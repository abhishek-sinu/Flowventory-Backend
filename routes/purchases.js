import express from 'express';
import db from '../db.js';
import PDFDocument from 'pdfkit';
import { buildCompanyContext, renderDocument } from '../utils/pdfRenderer.js';

const router = express.Router();

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const txt = String(value).trim();
    return txt.length ? txt : null;
}

function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
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
            `,
            params
        );

        return res.json(rows);
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
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
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

        const subtotal = round2(normalizedItems.reduce((sum, line) => sum + line.quantity * line.rate, 0));
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

        const subtotal = round2(normalizedItems.reduce((sum, line) => sum + line.quantity * line.rate, 0));
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

export default router;
