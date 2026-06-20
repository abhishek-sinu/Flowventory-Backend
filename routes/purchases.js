import express from 'express';
import db from '../db.js';
import multer from 'multer';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { buildCompanyContext, renderDocument } from '../utils/pdfRenderer.js';
import { getNextPaymentNo } from './paymentOut.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const txt = String(value).trim();
    return txt.length ? txt : null;
}

function pickValue(row, keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
            return row[key];
        }
    }
    return undefined;
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeDateFields(row) {
    const normalized = { ...row };
    Object.keys(normalized).forEach((key) => {
        if ((key.includes('date') || key === 'created_at') && normalized[key]) {
            normalized[key] = new Date(normalized[key]).toISOString().slice(0, 10);
        }
    });
    return normalized;
}

// Stock is added only for bills that actually bring goods into inventory.
// Drafts and cancelled bills do not affect stock.
function increasesStock(status) {
    return status !== 'draft' && status !== 'cancelled';
}

async function getNextBillNo(conn) {
    const [rows] = await conn.query('SELECT bill_no FROM purchase_invoices ORDER BY id DESC LIMIT 1');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `PINV-${y}${m}${d}-`;

    let seq = 1;
    if (rows.length && String(rows[0].bill_no || '').startsWith(prefix)) {
        const n = Number(String(rows[0].bill_no).slice(prefix.length));
        if (Number.isFinite(n) && n >= 1) seq = n + 1;
    }

    return `${prefix}${String(seq).padStart(3, '0')}`;
}

router.get('/', async (req, res) => {
    const { q, status } = req.query;
    const page = Math.max(1, toNumber(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toNumber(req.query.limit, 20)));
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (q) {
        const pattern = `%${q}%`;
        conditions.push('(piv.bill_no LIKE ? OR p.name LIKE ?)');
        params.push(pattern, pattern);
    }

    if (status) {
        conditions.push('piv.status = ?');
        params.push(String(status));
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total FROM purchase_invoices piv JOIN parties p ON p.id = piv.party_id ${whereSql}`,
            params
        );
        const total = Number(countRows[0]?.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / limit));

        const [rows] = await db.query(
            `
            SELECT
                piv.id,
                piv.bill_no,
                piv.bill_date,
                piv.due_date,
                piv.total_amount,
                piv.paid_amount,
                piv.balance_amount,
                piv.status,
                piv.created_at,
                p.id AS party_id,
                p.name AS party_name
            FROM purchase_invoices piv
            JOIN parties p ON p.id = piv.party_id
            ${whereSql}
            ORDER BY piv.bill_date DESC, piv.id DESC
            LIMIT ? OFFSET ?
            `,
            [...params, limit, offset]
        );

        return res.json({
            data: rows,
            pagination: {
                page,
                limit,
                total,
                totalPages,
            },
        });
    } catch (err) {
        console.error('Purchase list error:', err);
        return res.status(500).json({ error: 'Failed to fetch purchase bills' });
    }
});

router.get('/next-bill-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const billNo = await getNextBillNo(conn);
        return res.json({ billNo });
    } catch (err) {
        console.error('Next bill no error:', err);
        return res.status(500).json({ error: 'Failed to generate bill number' });
    } finally {
        conn.release();
    }
});

router.get('/template', async (_req, res) => {
    try {
        const templateRows = [
            {
                bill_no: 'PINV-20260620-001',
                bill_date: '2026-06-20',
                due_date: '2026-06-30',
                party_gstin: '27ABCDE1234F1Z5',
                party_name: 'ABC Traders',
                place_of_supply: 'Maharashtra',
                supply_type: 'intra',
                status: 'confirmed',
                discount_amount: 0,
                round_off: 0,
                notes: 'Sample purchase bill',
                paid_amount: 0,
                item_sku: 'FMCG-PARLE-100G',
                quantity: 10,
                rate: 20,
                discount_percent: 0,
                gst_percent: 18,
            },
        ];

        const ws = XLSX.utils.json_to_sheet(templateRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'purchase_import_template');

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="purchase_import_template.xlsx"');
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buffer);
    } catch (err) {
        console.error('Purchase template error:', err);
        return res.status(500).json({ error: 'Failed to generate template' });
    }
});

router.get('/xls', async (req, res) => {
    const { q, status } = req.query;
    const conditions = [];
    const params = [];

    if (q) {
        const pattern = `%${String(q).trim()}%`;
        conditions.push('(piv.bill_no LIKE ? OR p.name LIKE ? OR pii.item_name LIKE ? OR pii.item_id LIKE ?)');
        params.push(pattern, pattern, pattern, pattern);
    }

    if (status) {
        conditions.push('piv.status = ?');
        params.push(String(status));
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                piv.bill_no,
                piv.bill_date,
                piv.due_date,
                piv.place_of_supply,
                piv.status,
                piv.subtotal,
                piv.discount_amount,
                piv.header_discount_amount,
                piv.taxable_amount,
                piv.cgst_amount,
                piv.sgst_amount,
                piv.igst_amount,
                piv.round_off,
                piv.total_amount,
                piv.paid_amount,
                piv.balance_amount,
                piv.notes,
                p.name AS party_name,
                p.gstin AS party_gstin,
                p.phone AS party_phone,
                pii.item_id,
                pii.item_name,
                pii.hsn_code,
                pii.quantity,
                pii.unit,
                pii.rate,
                pii.discount_percent,
                pii.discount_amount AS line_discount_amount,
                pii.taxable_value,
                pii.gst_percent,
                pii.cgst_amount AS line_cgst_amount,
                pii.sgst_amount AS line_sgst_amount,
                pii.igst_amount AS line_igst_amount,
                pii.line_total
            FROM purchase_invoices piv
            JOIN parties p ON p.id = piv.party_id
            JOIN purchase_invoice_items pii ON pii.purchase_invoice_id = piv.id
            ${whereSql}
            ORDER BY piv.bill_date DESC, piv.id DESC, pii.id ASC
            `,
            params
        );

        const cleaned = rows.map(normalizeDateFields);
        const ws = XLSX.utils.json_to_sheet(cleaned);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'purchase_export');

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="purchase_export.xlsx"`);
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buffer);
    } catch (err) {
        console.error('Purchase export error:', err);
        return res.status(500).json({ error: 'Failed to export purchase data' });
    }
});

router.post('/import', upload.single('file'), async (req, res) => {
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Please upload an .xls or .xlsx file' });
    }

    const originalName = String(req.file.originalname || '').toLowerCase();
    if (!originalName.endsWith('.xls') && !originalName.endsWith('.xlsx')) {
        return res.status(400).json({ error: 'Only .xls or .xlsx files are supported' });
    }

    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (err) {
        console.error('Purchase import read error:', err);
        return res.status(400).json({ error: 'Invalid excel file format' });
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        return res.status(400).json({ error: 'Excel file has no sheets' });
    }

    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rawRows.length) {
        return res.status(400).json({ error: 'Excel file has no data rows' });
    }

    const failed = [];
    const groups = new Map();
    const seenBillNos = new Set();

    for (let index = 0; index < rawRows.length; index += 1) {
        const rowNumber = index + 2;
        const row = rawRows[index];
        const billNoRaw = pickValue(row, ['bill_no', 'Bill No', 'bill no']);
        const billDate = normalizeText(pickValue(row, ['bill_date', 'Bill Date', 'bill date']));
        const dueDate = normalizeText(pickValue(row, ['due_date', 'Due Date', 'due date']));
        const partyGstin = normalizeText(pickValue(row, ['party_gstin', 'GSTIN', 'gstin', 'Party GSTIN', 'Party Gstin']));
        const partyName = normalizeText(pickValue(row, ['party_name', 'Party Name', 'party name']));
        const placeOfSupply = normalizeText(pickValue(row, ['place_of_supply', 'place of supply', 'Place of Supply']));
        const status = normalizeText(pickValue(row, ['status', 'Status'])) || 'confirmed';
        const supplyType = normalizeText(pickValue(row, ['supply_type', 'supply type', 'Supply Type'])) || 'intra';
        const headerDiscountAmount = toNumber(pickValue(row, ['discount_amount', 'discount amount', 'Discount Amount']), 0);
        const roundOff = toNumber(pickValue(row, ['round_off', 'round off', 'Round Off']), 0);
        const notes = normalizeText(pickValue(row, ['notes', 'Notes']));
        const paidAmount = toNumber(pickValue(row, ['paid_amount', 'paid amount', 'Paid Amount']), 0);
        const itemSku = normalizeText(pickValue(row, ['item_sku', 'item sku', 'sku', 'SKU']));
        const itemName = normalizeText(pickValue(row, ['item_name', 'Item Name', 'item name']));
        const quantity = toNumber(pickValue(row, ['quantity', 'Quantity']), 0);
        const rate = toNumber(pickValue(row, ['rate', 'Rate']), 0);
        const discountPercent = toNumber(pickValue(row, ['discount_percent', 'discount percent', 'Discount Percent', 'Discount %']), 0);
        const gstPercent = toNumber(pickValue(row, ['gst_percent', 'gst percent', 'GST Percent', 'GST %']), 0);

        const billNo = normalizeText(billNoRaw) || null;
        const groupKey = billNo || `__ROW_${index + 1}`;

        if (!billDate) {
            failed.push({ row: rowNumber, bill_no: billNo, reason: 'bill_date is required' });
            continue;
        }

        if (!partyGstin && !partyName) {
            failed.push({ row: rowNumber, bill_no: billNo, reason: 'party_gstin or party_name is required' });
            continue;
        }

        if (!itemSku && !itemName) {
            failed.push({ row: rowNumber, bill_no: billNo, reason: 'item_sku or item_name is required' });
            continue;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            failed.push({ row: rowNumber, bill_no: billNo, reason: 'quantity must be a positive number' });
            continue;
        }

        if (String(status) !== 'confirmed' && String(status) !== 'draft') {
            failed.push({ row: rowNumber, bill_no: billNo, reason: 'status must be confirmed or draft' });
            continue;
        }

        if (!['intra', 'inter'].includes(String(supplyType))) {
            failed.push({ row: rowNumber, bill_no: billNo, reason: 'supply_type must be intra or inter' });
            continue;
        }

        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                bill_no: billNo,
                bill_date: billDate,
                due_date: dueDate,
                party_gstin: partyGstin,
                party_name: partyName,
                place_of_supply: placeOfSupply,
                status: String(status),
                supply_type: String(supplyType),
                discount_amount: headerDiscountAmount,
                round_off: roundOff,
                notes,
                paid_amount: paidAmount,
                lines: [],
            });
        }

        const group = groups.get(groupKey);
        if (group) {
            group.lines.push({
                item_sku: itemSku,
                item_name: itemName,
                quantity,
                rate,
                discount_percent: discountPercent,
                gst_percent: gstPercent,
                rowNumber,
            });
        }
    }

    if (failed.length) {
        return res.status(400).json({ success: false, summary: { totalRows: rawRows.length, created: 0, updated: 0, failedCount: failed.length, failed } });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        let created = 0;
        const successful = [];

        for (const [, group] of groups) {
            const partyWhere = group.party_gstin ? 'gstin = ?' : 'name = ?';
            const partyParam = group.party_gstin ? group.party_gstin : group.party_name;
            const [partyRows] = await conn.query(`SELECT id FROM parties WHERE ${partyWhere} LIMIT 1`, [partyParam]);
            if (!partyRows.length) {
                failed.push({ bill_no: group.bill_no, reason: 'party not found by GSTIN or name' });
                continue;
            }
            const partyId = partyRows[0].id;

            if (group.bill_no) {
                const [existing] = await conn.query('SELECT id FROM purchase_invoices WHERE bill_no = ? LIMIT 1', [group.bill_no]);
                if (existing.length) {
                    failed.push({ bill_no: group.bill_no, reason: 'bill_no already exists' });
                    continue;
                }
            }

            const normalizedItems = [];
            const validationErrors = [];
            for (const line of group.lines) {
                const [itemRows] = await conn.query(
                    'SELECT id, name, hsn_code, unit, purchase_price, gst_percent FROM items WHERE sku = ? OR name = ? LIMIT 1',
                    [line.item_sku, line.item_name]
                );
                if (!itemRows.length) {
                    validationErrors.push(`item not found for sku ${line.item_sku || ''} / name ${line.item_name || ''}`);
                    continue;
                }
                const item = itemRows[0];
                const lineRate = toNumber(line.rate, Number(item.purchase_price || 0));
                const gstPercent = toNumber(line.gst_percent, Number(item.gst_percent || 0));
                const discountPercent = toNumber(line.discount_percent, 0);
                const lineBase = round2(line.quantity * lineRate);
                const discountAmount = round2((lineBase * discountPercent) / 100);
                const taxable = round2(lineBase - discountAmount);
                const gstAmount = round2((taxable * gstPercent) / 100);
                let cgst = 0;
                let sgst = 0;
                let igst = 0;
                if (group.supply_type === 'inter') {
                    igst = gstAmount;
                } else {
                    cgst = round2(gstAmount / 2);
                    sgst = round2(gstAmount - cgst);
                }
                normalizedItems.push({
                    item_id: item.id,
                    item_name: item.name,
                    hsn_code: item.hsn_code,
                    quantity: line.quantity,
                    unit: item.unit || 'pcs',
                    rate: lineRate,
                    discount_percent: discountPercent,
                    discount_amount: discountAmount,
                    taxable_value: taxable,
                    gst_percent: gstPercent,
                    cgst_amount: cgst,
                    sgst_amount: sgst,
                    igst_amount: igst,
                    line_total: round2(taxable + cgst + sgst + igst),
                });
            }

            if (validationErrors.length) {
                failed.push({ bill_no: group.bill_no, reason: validationErrors.join('; ') });
                continue;
            }

            const subtotal = round2(normalizedItems.reduce((sum, line) => sum + round2(line.quantity * line.rate), 0));
            const lineDiscountTotal = round2(normalizedItems.reduce((sum, line) => sum + line.discount_amount, 0));
            const taxableAmountBeforeHeader = round2(normalizedItems.reduce((sum, line) => sum + line.taxable_value, 0));
            const taxableAmount = round2(Math.max(0, taxableAmountBeforeHeader - group.discount_amount));
            const cgstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.cgst_amount, 0));
            const sgstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.sgst_amount, 0));
            const igstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.igst_amount, 0));
            const totalAmount = round2(taxableAmount + cgstAmount + sgstAmount + igstAmount + group.round_off);
            const balanceAmount = round2(Math.max(0, totalAmount - group.paid_amount));
            const billNo = group.bill_no || await getNextBillNo(conn);

            const [billResult] = await conn.query('INSERT INTO purchase_invoices SET ?', {
                bill_no: billNo,
                party_id: partyId,
                bill_date: group.bill_date,
                due_date: group.due_date,
                place_of_supply: group.place_of_supply,
                subtotal,
                discount_amount: round2(lineDiscountTotal + group.discount_amount),
                header_discount_amount: round2(group.discount_amount),
                taxable_amount: taxableAmount,
                cgst_amount: cgstAmount,
                sgst_amount: sgstAmount,
                igst_amount: igstAmount,
                round_off: group.round_off,
                total_amount: totalAmount,
                paid_amount: group.paid_amount,
                balance_amount: balanceAmount,
                status: group.status,
                notes: group.notes,
            });

            for (const line of normalizedItems) {
                await conn.query('INSERT INTO purchase_invoice_items SET ?', {
                    purchase_invoice_id: billResult.insertId,
                    ...line,
                });
            }

            if (group.status === 'confirmed') {
                for (const line of normalizedItems) {
                    await conn.query('UPDATE items SET current_stock = current_stock + ? WHERE id = ?', [line.quantity, line.item_id]);
                }
            }

            if (group.paid_amount > 0 && group.status === 'confirmed' && String(billNo).startsWith('PINV-')) {
                const paymentNo = await getNextPaymentNo(conn);
                await conn.query('INSERT INTO payment_out SET ?', {
                    payment_no: paymentNo,
                    party_id: partyId,
                    purchase_invoice_id: billResult.insertId,
                    payment_date: group.bill_date,
                    amount: round2(group.paid_amount),
                    payment_mode: 'cash',
                    reference_no: null,
                    notes: `Auto-recorded with bill ${billNo}`,
                });
            }

            created += 1;
            successful.push(billNo);
        }

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'import_purchase_bills_xls',
                    details: JSON.stringify({ created, failedCount: failed.length, failed }),
                });
            } catch (_) {}
        }

        await conn.commit();

        return res.json({
            success: true,
            summary: {
                totalRows: rawRows.length,
                created,
                updated: 0,
                failedCount: failed.length,
                failed,
                importedBillNos: successful,
            },
        });
    } catch (err) {
        await conn.rollback();
        console.error('Purchase import error:', err);
        return res.status(500).json({ error: 'Failed to import purchase bills' });
    } finally {
        conn.release();
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [billRows] = await db.query(
            `
            SELECT
                piv.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM purchase_invoices piv
            JOIN parties p ON p.id = piv.party_id
            WHERE piv.id = ?
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!billRows.length) {
            return res.status(404).json({ error: 'Purchase bill not found' });
        }

        const [itemRows] = await db.query(
            `
            SELECT
                id,
                item_id,
                item_name,
                hsn_code,
                quantity,
                unit,
                rate,
                discount_percent,
                discount_amount,
                taxable_value,
                gst_percent,
                cgst_amount,
                sgst_amount,
                igst_amount,
                line_total
            FROM purchase_invoice_items
            WHERE purchase_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        return res.json({ bill: billRows[0], items: itemRows });
    } catch (err) {
        console.error('Purchase get bill error:', err);
        return res.status(500).json({ error: 'Failed to fetch purchase bill' });
    }
});

router.get('/:id/pdf', async (req, res) => {
    try {
        const [billRows] = await db.query(
            `
            SELECT
                piv.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM purchase_invoices piv
            JOIN parties p ON p.id = piv.party_id
            WHERE piv.id = ?
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!billRows.length) {
            return res.status(404).json({ error: 'Purchase bill not found' });
        }

        const bill = billRows[0];
        const [itemRows] = await db.query(
            `
            SELECT
                item_name,
                hsn_code,
                quantity,
                unit,
                rate,
                taxable_value,
                gst_percent,
                line_total
            FROM purchase_invoice_items
            WHERE purchase_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        const filename = `purchase_${bill.bill_no || bill.id}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');

        const company = await buildCompanyContext();
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        doc.pipe(res);

        renderDocument({
            doc,
            company,
            title: 'PURCHASE BILL',
            meta: [
                `Bill No: ${bill.bill_no || '-'}`,
                `Bill Date: ${String(bill.bill_date || '').slice(0, 10)}`,
                bill.due_date ? `Due Date: ${String(bill.due_date || '').slice(0, 10)}` : '',
            ],
            partyLabel: 'Supplier',
            party: {
                name: bill.party_name,
                phone: bill.party_phone,
                gstin: bill.party_gstin,
                address: [bill.party_billing_address, bill.party_city, bill.party_state]
                    .filter(Boolean)
                    .join(', '),
            },
            items: itemRows,
            totals: bill,
            totalLabel: 'Grand Total',
            watermark: String(bill.status) === 'cancelled' ? 'CANCELLED' : null,
        });

        return;
    } catch (err) {
        console.error('Purchase bill pdf error:', err);
        return res.status(500).json({ error: 'Failed to generate purchase bill PDF' });
    }
});

router.post('/', async (req, res) => {
    const partyId = Number(req.body.party_id);
    const billDate = normalizeText(req.body.bill_date);
    const dueDate = normalizeText(req.body.due_date);
    const placeOfSupply = normalizeText(req.body.place_of_supply);
    const notes = normalizeText(req.body.notes);
    const status = normalizeText(req.body.status) || 'draft';
    const headerDiscountAmount = toNumber(req.body.discount_amount, 0);
    const roundOff = toNumber(req.body.round_off, 0);
    const supplyType = normalizeText(req.body.supply_type) || 'intra';
    const inputItems = Array.isArray(req.body.items) ? req.body.items : [];

    const errors = [];
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!billDate) errors.push('bill_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const billNo = normalizeText(req.body.bill_no) || await getNextBillNo(conn);

        const normalizedItems = [];
        for (const raw of inputItems) {
            const itemId = Number(raw.item_id);
            const qty = toNumber(raw.quantity, 0);
            const rateInput = raw.rate;
            const discountPercent = toNumber(raw.discount_percent, 0);
            const gstPercentInput = raw.gst_percent;

            if (!Number.isFinite(itemId) || itemId <= 0) {
                errors.push('each line requires valid item_id');
                continue;
            }
            if (!Number.isFinite(qty) || qty <= 0) {
                errors.push('quantity must be greater than 0');
                continue;
            }
            if (!Number.isInteger(qty)) {
                errors.push('quantity must be a whole number');
                continue;
            }

            const [itemRows] = await conn.query(
                'SELECT id, name, hsn_code, unit, purchase_price, gst_percent FROM items WHERE id = ? LIMIT 1',
                [itemId]
            );
            if (!itemRows.length) {
                errors.push(`item not found for item_id ${itemId}`);
                continue;
            }

            const item = itemRows[0];
            const rate = toNumber(rateInput, Number(item.purchase_price || 0));
            const gstPercent = toNumber(gstPercentInput, Number(item.gst_percent || 0));

            const lineBase = round2(qty * rate);
            const discountAmount = round2((lineBase * discountPercent) / 100);
            const taxable = round2(lineBase - discountAmount);
            const gstAmount = round2((taxable * gstPercent) / 100);

            let cgst = 0;
            let sgst = 0;
            let igst = 0;
            if (supplyType === 'inter') {
                igst = gstAmount;
            } else {
                cgst = round2(gstAmount / 2);
                sgst = round2(gstAmount - cgst);
            }

            const lineTotal = round2(taxable + cgst + sgst + igst);

            normalizedItems.push({
                item_id: item.id,
                item_name: item.name,
                hsn_code: item.hsn_code,
                quantity: qty,
                unit: item.unit || 'pcs',
                rate,
                discount_percent: discountPercent,
                discount_amount: discountAmount,
                taxable_value: taxable,
                gst_percent: gstPercent,
                cgst_amount: cgst,
                sgst_amount: sgst,
                igst_amount: igst,
                line_total: lineTotal,
            });
        }

        if (errors.length) {
            await conn.rollback();
            return res.status(400).json({ error: errors.join(', ') });
        }

        const subtotal = round2(normalizedItems.reduce((sum, line) => sum + round2(line.quantity * line.rate), 0));
        const lineDiscountTotal = round2(normalizedItems.reduce((sum, line) => sum + line.discount_amount, 0));
        const taxableAmountBeforeHeader = round2(normalizedItems.reduce((sum, line) => sum + line.taxable_value, 0));
        const taxableAmount = round2(Math.max(0, taxableAmountBeforeHeader - headerDiscountAmount));

        const cgstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.cgst_amount, 0));
        const sgstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.sgst_amount, 0));
        const igstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.igst_amount, 0));

        const totalAmount = round2(taxableAmount + cgstAmount + sgstAmount + igstAmount + roundOff);
        const paidAmount = toNumber(req.body.paid_amount, 0);
        const balanceAmount = round2(Math.max(0, totalAmount - paidAmount));

        const [billResult] = await conn.query('INSERT INTO purchase_invoices SET ?', {
            bill_no: billNo,
            party_id: partyId,
            bill_date: billDate,
            due_date: dueDate,
            place_of_supply: placeOfSupply,
            subtotal,
            discount_amount: round2(lineDiscountTotal + headerDiscountAmount),
            header_discount_amount: round2(headerDiscountAmount),
            taxable_amount: taxableAmount,
            cgst_amount: cgstAmount,
            sgst_amount: sgstAmount,
            igst_amount: igstAmount,
            round_off: roundOff,
            total_amount: totalAmount,
            paid_amount: paidAmount,
            balance_amount: balanceAmount,
            status,
            notes,
        });

        for (const line of normalizedItems) {
            await conn.query('INSERT INTO purchase_invoice_items SET ?', {
                purchase_invoice_id: billResult.insertId,
                ...line,
            });
        }

        if (increasesStock(status)) {
            for (const line of normalizedItems) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock + ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        // If the bill is created with an upfront paid amount, record a matching
        // Payment Out so the party ledger and payables stay consistent.
        // Only for booked purchase bills (PINV-, not draft/cancelled/debit note).
        if (paidAmount > 0 && increasesStock(status) && String(billNo).startsWith('PINV-')) {
            const paymentNo = await getNextPaymentNo(conn);
            await conn.query('INSERT INTO payment_out SET ?', {
                payment_no: paymentNo,
                party_id: partyId,
                purchase_invoice_id: billResult.insertId,
                payment_date: billDate,
                amount: round2(paidAmount),
                payment_mode: 'cash',
                reference_no: null,
                notes: `Auto-recorded with bill ${billNo}`,
            });
        }

        await conn.commit();

        return res.status(201).json({
            success: true,
            bill: {
                id: billResult.insertId,
                bill_no: billNo,
                subtotal,
                taxable_amount: taxableAmount,
                cgst_amount: cgstAmount,
                sgst_amount: sgstAmount,
                igst_amount: igstAmount,
                total_amount: totalAmount,
                paid_amount: paidAmount,
                balance_amount: balanceAmount,
                status,
            },
        });
    } catch (err) {
        await conn.rollback();
        console.error('Purchase create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Bill number already exists' });
        }
        return res.status(500).json({ error: 'Failed to create purchase bill' });
    } finally {
        conn.release();
    }
});

router.put('/:id', async (req, res) => {
    const billId = Number(req.params.id);
    const partyId = Number(req.body.party_id);
    const billDate = normalizeText(req.body.bill_date);
    const dueDate = normalizeText(req.body.due_date);
    const placeOfSupply = normalizeText(req.body.place_of_supply);
    const notes = normalizeText(req.body.notes);
    const status = normalizeText(req.body.status) || 'draft';
    const headerDiscountAmount = toNumber(req.body.discount_amount, 0);
    const roundOff = toNumber(req.body.round_off, 0);
    const supplyType = normalizeText(req.body.supply_type) || 'intra';
    const inputItems = Array.isArray(req.body.items) ? req.body.items : [];

    const errors = [];
    if (!Number.isFinite(billId) || billId <= 0) errors.push('valid bill id is required');
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!billDate) errors.push('bill_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            'SELECT id, bill_no, status FROM purchase_invoices WHERE id = ? FOR UPDATE',
            [billId]
        );
        if (!existingRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Purchase bill not found' });
        }

        if (String(existingRows[0].status) !== 'draft') {
            await conn.rollback();
            return res.status(400).json({ error: 'Only draft purchase bills can be edited' });
        }

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const billNo = normalizeText(req.body.bill_no) || existingRows[0].bill_no;

        const normalizedItems = [];
        for (const raw of inputItems) {
            const itemId = Number(raw.item_id);
            const qty = toNumber(raw.quantity, 0);
            const rateInput = raw.rate;
            const discountPercent = toNumber(raw.discount_percent, 0);
            const gstPercentInput = raw.gst_percent;

            if (!Number.isFinite(itemId) || itemId <= 0) {
                errors.push('each line requires valid item_id');
                continue;
            }
            if (!Number.isFinite(qty) || qty <= 0) {
                errors.push('quantity must be greater than 0');
                continue;
            }
            if (!Number.isInteger(qty)) {
                errors.push('quantity must be a whole number');
                continue;
            }

            const [itemRows] = await conn.query(
                'SELECT id, name, hsn_code, unit, purchase_price, gst_percent FROM items WHERE id = ? LIMIT 1',
                [itemId]
            );
            if (!itemRows.length) {
                errors.push(`item not found for item_id ${itemId}`);
                continue;
            }

            const item = itemRows[0];
            const rate = toNumber(rateInput, Number(item.purchase_price || 0));
            const gstPercent = toNumber(gstPercentInput, Number(item.gst_percent || 0));

            const lineBase = round2(qty * rate);
            const discountAmount = round2((lineBase * discountPercent) / 100);
            const taxable = round2(lineBase - discountAmount);
            const gstAmount = round2((taxable * gstPercent) / 100);

            let cgst = 0;
            let sgst = 0;
            let igst = 0;
            if (supplyType === 'inter') {
                igst = gstAmount;
            } else {
                cgst = round2(gstAmount / 2);
                sgst = round2(gstAmount - cgst);
            }

            const lineTotal = round2(taxable + cgst + sgst + igst);

            normalizedItems.push({
                item_id: item.id,
                item_name: item.name,
                hsn_code: item.hsn_code,
                quantity: qty,
                unit: item.unit || 'pcs',
                rate,
                discount_percent: discountPercent,
                discount_amount: discountAmount,
                taxable_value: taxable,
                gst_percent: gstPercent,
                cgst_amount: cgst,
                sgst_amount: sgst,
                igst_amount: igst,
                line_total: lineTotal,
            });
        }

        if (errors.length) {
            await conn.rollback();
            return res.status(400).json({ error: errors.join(', ') });
        }

        const subtotal = round2(normalizedItems.reduce((sum, line) => sum + round2(line.quantity * line.rate), 0));
        const lineDiscountTotal = round2(normalizedItems.reduce((sum, line) => sum + line.discount_amount, 0));
        const taxableAmountBeforeHeader = round2(normalizedItems.reduce((sum, line) => sum + line.taxable_value, 0));
        const taxableAmount = round2(Math.max(0, taxableAmountBeforeHeader - headerDiscountAmount));

        const cgstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.cgst_amount, 0));
        const sgstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.sgst_amount, 0));
        const igstAmount = round2(normalizedItems.reduce((sum, line) => sum + line.igst_amount, 0));

        const totalAmount = round2(taxableAmount + cgstAmount + sgstAmount + igstAmount + roundOff);
        const paidAmount = toNumber(req.body.paid_amount, 0);
        const balanceAmount = round2(Math.max(0, totalAmount - paidAmount));

        await conn.query('UPDATE purchase_invoices SET ? WHERE id = ?', [
            {
                bill_no: billNo,
                party_id: partyId,
                bill_date: billDate,
                due_date: dueDate,
                place_of_supply: placeOfSupply,
                subtotal,
                discount_amount: round2(lineDiscountTotal + headerDiscountAmount),
                header_discount_amount: round2(headerDiscountAmount),
                taxable_amount: taxableAmount,
                cgst_amount: cgstAmount,
                sgst_amount: sgstAmount,
                igst_amount: igstAmount,
                round_off: roundOff,
                total_amount: totalAmount,
                paid_amount: paidAmount,
                balance_amount: balanceAmount,
                status,
                notes,
            },
            billId,
        ]);

        await conn.query('DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = ?', [billId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO purchase_invoice_items SET ?', {
                purchase_invoice_id: billId,
                ...line,
            });
        }

        // Existing bill was a draft (enforced above), so no stock was added yet.
        // Add now if it is being confirmed.
        if (increasesStock(status)) {
            for (const line of normalizedItems) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock + ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        await conn.commit();
        return res.json({ success: true, billId, billNo });
    } catch (err) {
        await conn.rollback();
        console.error('Purchase update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Bill number already exists' });
        }
        return res.status(500).json({ error: 'Failed to update purchase bill' });
    } finally {
        conn.release();
    }
});

// Cancel a purchase bill and reverse its stock impact.
// A confirmed purchase added stock, so cancelling it removes that stock again.
router.post('/:id/cancel', async (req, res) => {
    const billId = Number(req.params.id);
    if (!Number.isFinite(billId) || billId <= 0) {
        return res.status(400).json({ error: 'valid bill id is required' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            'SELECT id, bill_no, status, paid_amount, balance_amount FROM purchase_invoices WHERE id = ? FOR UPDATE',
            [billId]
        );
        if (!rows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Purchase bill not found' });
        }

        const current = rows[0];
        if (String(current.status) === 'cancelled') {
            await conn.rollback();
            return res.status(400).json({ error: 'Purchase bill is already cancelled' });
        }

        // Block cancellation if payments have been recorded against this bill.
        // The user must delete those payments first so the ledger stays consistent.
        const [paymentRows] = await conn.query(
            'SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM payment_out WHERE purchase_invoice_id = ?',
            [billId]
        );
        if (Number(paymentRows[0]?.cnt || 0) > 0) {
            await conn.rollback();
            return res.status(409).json({
                error: `Cannot cancel: ${paymentRows[0].cnt} payment(s) totalling ${Number(paymentRows[0].total).toFixed(2)} are linked to this bill. Delete the payment(s) first.`,
            });
        }

        // Only reverse stock if the bill had actually added it.
        if (increasesStock(current.status)) {
            const [lines] = await conn.query(
                'SELECT item_id, item_name, quantity FROM purchase_invoice_items WHERE purchase_invoice_id = ?',
                [billId]
            );

            // Block cancellation if removing the purchased stock would make any
            // item go negative (i.e. those goods have since been sold/consumed).
            for (const line of lines) {
                const [itemRows] = await conn.query(
                    'SELECT current_stock FROM items WHERE id = ? FOR UPDATE',
                    [line.item_id]
                );
                const stock = itemRows.length ? Number(itemRows[0].current_stock || 0) : 0;
                if (stock - Number(line.quantity) < 0) {
                    await conn.rollback();
                    return res.status(400).json({
                        error: `Cannot cancel: not enough stock to reverse for "${line.item_name}". Those goods may already be sold.`,
                    });
                }
            }

            for (const line of lines) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock - ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        await conn.query('UPDATE purchase_invoices SET status = ?, paid_amount = 0, balance_amount = 0 WHERE id = ?', ['cancelled', billId]);

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'cancel_purchase_bill',
                    details: JSON.stringify({
                        purchase_invoice_id: billId,
                        bill_no: current.bill_no,
                        previous_status: current.status,
                        stock_reversed: increasesStock(current.status),
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.json({ success: true, id: billId, status: 'cancelled' });
    } catch (err) {
        await conn.rollback();
        console.error('Purchase cancel error:', err);
        return res.status(500).json({ error: 'Failed to cancel purchase bill' });
    } finally {
        conn.release();
    }
});

export default router;
