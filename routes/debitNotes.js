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

async function getNextDebitNoteNo(conn) {
    const [rows] = await conn.query(
        "SELECT bill_no FROM purchase_invoices WHERE bill_no LIKE 'DN-%' ORDER BY id DESC LIMIT 1"
    );
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `DN-${y}${m}${d}-`;

    let seq = 1;
    if (rows.length && String(rows[0].bill_no || '').startsWith(prefix)) {
        const n = Number(String(rows[0].bill_no).slice(prefix.length));
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
    const subtotal = round2(lines.reduce((sum, line) => sum + line.quantity * line.rate, 0));
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
    const conditions = ["p.bill_no LIKE 'DN-%'"];
    const params = [];

    if (q) {
        const pattern = `%${q}%`;
        conditions.push('(p.bill_no LIKE ? OR pt.name LIKE ?)');
        params.push(pattern, pattern);
    }

    if (status) {
        conditions.push('p.status = ?');
        params.push(String(status));
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    try {
        const [rows] = await db.query(
            `
            SELECT p.id, p.bill_no, p.bill_date, p.due_date, p.total_amount, p.status, p.created_at,
                   pt.id AS party_id, pt.name AS party_name
            FROM purchase_invoices p
            JOIN parties pt ON pt.id = p.party_id
            ${whereSql}
            ORDER BY p.bill_date DESC, p.id DESC
            `,
            params
        );
        return res.json(rows);
    } catch (err) {
        console.error('Debit note list error:', err);
        return res.status(500).json({ error: 'Failed to fetch debit notes' });
    }
});

router.get('/next-debit-note-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const debitNoteNo = await getNextDebitNoteNo(conn);
        return res.json({ debitNoteNo });
    } catch (err) {
        console.error('Next debit note no error:', err);
        return res.status(500).json({ error: 'Failed to generate debit note number' });
    } finally {
        conn.release();
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT p.*, pt.name AS party_name, pt.phone AS party_phone, pt.gstin AS party_gstin,
                   pt.billing_address AS party_billing_address, pt.city AS party_city, pt.state AS party_state
            FROM purchase_invoices p
            JOIN parties pt ON pt.id = p.party_id
            WHERE p.id = ? AND p.bill_no LIKE 'DN-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).json({ error: 'Debit note not found' });
        }

        const [itemRows] = await db.query(
            `
            SELECT id, item_id, item_name, hsn_code, quantity, unit, rate,
                   discount_percent, discount_amount, taxable_value, gst_percent,
                   cgst_amount, sgst_amount, igst_amount, line_total
            FROM purchase_invoice_items
            WHERE purchase_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        return res.json({ debitNote: rows[0], items: itemRows });
    } catch (err) {
        console.error('Debit note get error:', err);
        return res.status(500).json({ error: 'Failed to fetch debit note' });
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

    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const debitNoteNo = normalizeText(req.body.debit_note_no) || await getNextDebitNoteNo(conn);
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        const [result] = await conn.query('INSERT INTO purchase_invoices SET ?', {
            bill_no: debitNoteNo,
            party_id: partyId,
            bill_date: billDate,
            due_date: dueDate,
            place_of_supply: placeOfSupply,
            subtotal: totals.subtotal,
            discount_amount: round2(totals.lineDiscountTotal + headerDiscountAmount),
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
            await conn.query('INSERT INTO purchase_invoice_items SET ?', {
                purchase_invoice_id: result.insertId,
                ...line,
            });
        }

        await conn.commit();
        return res.status(201).json({ success: true, debitNoteId: result.insertId, debitNoteNo });
    } catch (err) {
        await conn.rollback();
        console.error('Debit note create error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Debit note number already exists' });
        return res.status(500).json({ error: 'Failed to create debit note' });
    } finally {
        conn.release();
    }
});

router.put('/:id', async (req, res) => {
    const debitNoteId = Number(req.params.id);
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
    if (!Number.isFinite(debitNoteId) || debitNoteId <= 0) errors.push('valid debit note id is required');
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!billDate) errors.push('bill_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            "SELECT id, bill_no, status FROM purchase_invoices WHERE id = ? AND bill_no LIKE 'DN-%' FOR UPDATE",
            [debitNoteId]
        );
        if (!existingRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Debit note not found' });
        }

        if (String(existingRows[0].status) !== 'draft') {
            await conn.rollback();
            return res.status(400).json({ error: 'Only draft debit notes can be edited' });
        }

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const debitNoteNo = normalizeText(req.body.debit_note_no) || existingRows[0].bill_no;
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        await conn.query('UPDATE purchase_invoices SET ? WHERE id = ?', [
            {
                bill_no: debitNoteNo,
                party_id: partyId,
                bill_date: billDate,
                due_date: dueDate,
                place_of_supply: placeOfSupply,
                subtotal: totals.subtotal,
                discount_amount: round2(totals.lineDiscountTotal + headerDiscountAmount),
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
            debitNoteId,
        ]);

        await conn.query('DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = ?', [debitNoteId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO purchase_invoice_items SET ?', {
                purchase_invoice_id: debitNoteId,
                ...line,
            });
        }

        await conn.commit();
        return res.json({ success: true, debitNoteId, debitNoteNo });
    } catch (err) {
        await conn.rollback();
        console.error('Debit note update error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Debit note number already exists' });
        return res.status(500).json({ error: 'Failed to update debit note' });
    } finally {
        conn.release();
    }
});

router.get('/:id/pdf', async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT p.*, pt.name AS party_name, pt.phone AS party_phone, pt.gstin AS party_gstin,
                   pt.billing_address AS party_billing_address, pt.city AS party_city, pt.state AS party_state
            FROM purchase_invoices p
            JOIN parties pt ON pt.id = p.party_id
            WHERE p.id = ? AND p.bill_no LIKE 'DN-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ error: 'Debit note not found' });

        const debitNote = rows[0];
        const [itemRows] = await db.query(
            `
            SELECT item_name, hsn_code, quantity, unit, rate, taxable_value, gst_percent, line_total
            FROM purchase_invoice_items
            WHERE purchase_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        const filename = `debit_note_${debitNote.bill_no || debitNote.id}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');

        const company = await buildCompanyContext();
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.pipe(res);

        renderDocument({
            doc,
            company,
            title: 'DEBIT NOTE',
            meta: [
                `Debit Note No: ${debitNote.bill_no || '-'}`,
                `Date: ${String(debitNote.bill_date || '').slice(0, 10)}`,
            ],
            partyLabel: 'Supplier',
            party: {
                name: debitNote.party_name,
                phone: debitNote.party_phone,
                gstin: debitNote.party_gstin,
                address: [debitNote.party_billing_address, debitNote.party_city, debitNote.party_state]
                    .filter(Boolean)
                    .join(', '),
            },
            items: itemRows,
            totals: debitNote,
            totalLabel: 'Debit Total',
        });
    } catch (err) {
        console.error('Debit note pdf error:', err);
        return res.status(500).json({ error: 'Failed to generate debit note PDF' });
    }
});

export default router;
