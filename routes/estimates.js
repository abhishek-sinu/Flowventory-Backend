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

async function getNextEstimateNo(conn) {
    const [rows] = await conn.query(
        "SELECT invoice_no FROM sales_invoices WHERE invoice_no LIKE 'EST-%' ORDER BY id DESC LIMIT 1"
    );
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `EST-${y}${m}${d}-`;

    let seq = 1;
    if (rows.length && String(rows[0].invoice_no || '').startsWith(prefix)) {
        const n = Number(String(rows[0].invoice_no).slice(prefix.length));
        if (Number.isFinite(n) && n >= 1) seq = n + 1;
    }

    return `${prefix}${String(seq).padStart(3, '0')}`;
}

async function computeLines(conn, inputItems, supplyType) {
    const errors = [];
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
            'SELECT id, name, hsn_code, unit, sale_price, gst_percent FROM items WHERE id = ? LIMIT 1',
            [itemId]
        );
        if (!itemRows.length) {
            errors.push(`item not found for item_id ${itemId}`);
            continue;
        }

        const item = itemRows[0];
        const rate = toNumber(rateInput, Number(item.sale_price || 0));
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
            line_total: round2(taxable + cgst + sgst + igst),
        });
    }

    return { normalizedItems, errors };
}

function summarizeTotals(lines, headerDiscountAmount, roundOff, paidAmount) {
    const subtotal = round2(lines.reduce((sum, line) => sum + round2(line.quantity * line.rate), 0));
    const lineDiscountTotal = round2(lines.reduce((sum, line) => sum + line.discount_amount, 0));
    const taxableAmountBeforeHeader = round2(lines.reduce((sum, line) => sum + line.taxable_value, 0));
    const taxableAmount = round2(Math.max(0, taxableAmountBeforeHeader - headerDiscountAmount));

    const cgstAmount = round2(lines.reduce((sum, line) => sum + line.cgst_amount, 0));
    const sgstAmount = round2(lines.reduce((sum, line) => sum + line.sgst_amount, 0));
    const igstAmount = round2(lines.reduce((sum, line) => sum + line.igst_amount, 0));

    const totalAmount = round2(taxableAmount + cgstAmount + sgstAmount + igstAmount + roundOff);
    const balanceAmount = round2(Math.max(0, totalAmount - paidAmount));

    return {
        subtotal,
        lineDiscountTotal,
        taxableAmount,
        cgstAmount,
        sgstAmount,
        igstAmount,
        totalAmount,
        balanceAmount,
    };
}

router.get('/', async (req, res) => {
    const { q, status } = req.query;
    const conditions = ["s.invoice_no LIKE 'EST-%'"];
    const params = [];

    if (q) {
        const pattern = `%${q}%`;
        conditions.push('(s.invoice_no LIKE ? OR p.name LIKE ?)');
        params.push(pattern, pattern);
    }

    if (status) {
        conditions.push('s.status = ?');
        params.push(String(status));
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    try {
        const [rows] = await db.query(
            `
            SELECT s.id, s.invoice_no, s.invoice_date, s.due_date, s.total_amount, s.status, s.created_at,
                   p.id AS party_id, p.name AS party_name
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            ${whereSql}
            ORDER BY s.invoice_date DESC, s.id DESC
            `,
            params
        );
        return res.json(rows);
    } catch (err) {
        console.error('Estimate list error:', err);
        return res.status(500).json({ error: 'Failed to fetch estimates' });
    }
});

router.get('/next-estimate-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const estimateNo = await getNextEstimateNo(conn);
        return res.json({ estimateNo });
    } catch (err) {
        console.error('Next estimate no error:', err);
        return res.status(500).json({ error: 'Failed to generate estimate number' });
    } finally {
        conn.release();
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [invoiceRows] = await db.query(
            `
            SELECT s.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                   p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            WHERE s.id = ? AND s.invoice_no LIKE 'EST-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!invoiceRows.length) {
            return res.status(404).json({ error: 'Estimate not found' });
        }

        const [itemRows] = await db.query(
            `
            SELECT id, item_id, item_name, hsn_code, quantity, unit, rate,
                   discount_percent, discount_amount, taxable_value, gst_percent,
                   cgst_amount, sgst_amount, igst_amount, line_total
            FROM sales_invoice_items
            WHERE sales_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        return res.json({ estimate: invoiceRows[0], items: itemRows });
    } catch (err) {
        console.error('Estimate get error:', err);
        return res.status(500).json({ error: 'Failed to fetch estimate' });
    }
});

router.post('/', async (req, res) => {
    const partyId = Number(req.body.party_id);
    const invoiceDate = normalizeText(req.body.invoice_date);
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
    if (!invoiceDate) errors.push('invoice_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const estimateNo = normalizeText(req.body.estimate_no) || await getNextEstimateNo(conn);
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        const [result] = await conn.query('INSERT INTO sales_invoices SET ?', {
            invoice_no: estimateNo,
            party_id: partyId,
            invoice_date: invoiceDate,
            due_date: dueDate,
            place_of_supply: placeOfSupply,
            subtotal: totals.subtotal,
            discount_amount: round2(totals.lineDiscountTotal + headerDiscountAmount),
            header_discount_amount: round2(headerDiscountAmount),
            taxable_amount: totals.taxableAmount,
            cgst_amount: totals.cgstAmount,
            sgst_amount: totals.sgstAmount,
            igst_amount: totals.igstAmount,
            round_off: roundOff,
            total_amount: totals.totalAmount,
            paid_amount: 0,
            balance_amount: totals.balanceAmount,
            status,
            notes,
        });

        for (const line of normalizedItems) {
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: result.insertId,
                ...line,
            });
        }

        await conn.commit();
        return res.status(201).json({ success: true, estimateId: result.insertId, estimateNo });
    } catch (err) {
        await conn.rollback();
        console.error('Estimate create error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Estimate number already exists' });
        return res.status(500).json({ error: 'Failed to create estimate' });
    } finally {
        conn.release();
    }
});

router.put('/:id', async (req, res) => {
    const estimateId = Number(req.params.id);
    const partyId = Number(req.body.party_id);
    const invoiceDate = normalizeText(req.body.invoice_date);
    const dueDate = normalizeText(req.body.due_date);
    const placeOfSupply = normalizeText(req.body.place_of_supply);
    const notes = normalizeText(req.body.notes);
    const status = normalizeText(req.body.status) || 'draft';
    const headerDiscountAmount = toNumber(req.body.discount_amount, 0);
    const roundOff = toNumber(req.body.round_off, 0);
    const supplyType = normalizeText(req.body.supply_type) || 'intra';
    const inputItems = Array.isArray(req.body.items) ? req.body.items : [];

    const errors = [];
    if (!Number.isFinite(estimateId) || estimateId <= 0) errors.push('valid estimate id is required');
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!invoiceDate) errors.push('invoice_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            "SELECT id, invoice_no, status FROM sales_invoices WHERE id = ? AND invoice_no LIKE 'EST-%' FOR UPDATE",
            [estimateId]
        );
        if (!existingRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Estimate not found' });
        }

        if (String(existingRows[0].status) !== 'draft') {
            await conn.rollback();
            return res.status(400).json({ error: 'Only draft estimates can be edited' });
        }

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const estimateNo = normalizeText(req.body.estimate_no) || existingRows[0].invoice_no;
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
            {
                invoice_no: estimateNo,
                party_id: partyId,
                invoice_date: invoiceDate,
                due_date: dueDate,
                place_of_supply: placeOfSupply,
                subtotal: totals.subtotal,
                discount_amount: round2(totals.lineDiscountTotal + headerDiscountAmount),
                header_discount_amount: round2(headerDiscountAmount),
                taxable_amount: totals.taxableAmount,
                cgst_amount: totals.cgstAmount,
                sgst_amount: totals.sgstAmount,
                igst_amount: totals.igstAmount,
                round_off: roundOff,
                total_amount: totals.totalAmount,
                paid_amount: 0,
                balance_amount: totals.balanceAmount,
                status,
                notes,
            },
            estimateId,
        ]);

        await conn.query('DELETE FROM sales_invoice_items WHERE sales_invoice_id = ?', [estimateId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: estimateId,
                ...line,
            });
        }

        await conn.commit();
        return res.json({ success: true, estimateId, estimateNo });
    } catch (err) {
        await conn.rollback();
        console.error('Estimate update error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Estimate number already exists' });
        return res.status(500).json({ error: 'Failed to update estimate' });
    } finally {
        conn.release();
    }
});

router.get('/:id/pdf', async (req, res) => {
    try {
        const [estimateRows] = await db.query(
            `
            SELECT s.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                   p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            WHERE s.id = ? AND s.invoice_no LIKE 'EST-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!estimateRows.length) return res.status(404).json({ error: 'Estimate not found' });

        const estimate = estimateRows[0];
        const [itemRows] = await db.query(
            `
            SELECT item_name, hsn_code, quantity, unit, rate, taxable_value, gst_percent, line_total
            FROM sales_invoice_items
            WHERE sales_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        const filename = `estimate_${estimate.invoice_no || estimate.id}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');

        const company = await buildCompanyContext();
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.pipe(res);

        renderDocument({
            doc,
            company,
            title: 'ESTIMATE',
            meta: [
                `Estimate No: ${estimate.invoice_no || '-'}`,
                `Estimate Date: ${String(estimate.invoice_date || '').slice(0, 10)}`,
                estimate.due_date ? `Valid Until: ${String(estimate.due_date || '').slice(0, 10)}` : '',
            ],
            partyLabel: 'Prepared For',
            party: {
                name: estimate.party_name,
                phone: estimate.party_phone,
                gstin: estimate.party_gstin,
                address: [estimate.party_billing_address, estimate.party_city, estimate.party_state]
                    .filter(Boolean)
                    .join(', '),
            },
            items: itemRows,
            totals: estimate,
            totalLabel: 'Estimate Total',
        });
    } catch (err) {
        console.error('Estimate pdf error:', err);
        return res.status(500).json({ error: 'Failed to generate estimate PDF' });
    }
});

export default router;
