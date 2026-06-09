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

// A credit note is a sales return: confirming it brings goods back into stock.
// Drafts and cancelled notes do not affect stock.
function affectsStock(status) {
    return status !== 'draft' && status !== 'cancelled';
}

async function getNextCreditNoteNo(conn) {
    const [rows] = await conn.query(
        "SELECT invoice_no FROM sales_invoices WHERE invoice_no LIKE 'CN-%' ORDER BY id DESC LIMIT 1"
    );
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `CN-${y}${m}${d}-`;

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
    const conditions = ["s.invoice_no LIKE 'CN-%'"];
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
        console.error('Credit note list error:', err);
        return res.status(500).json({ error: 'Failed to fetch credit notes' });
    }
});

router.get('/next-credit-note-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const creditNoteNo = await getNextCreditNoteNo(conn);
        return res.json({ creditNoteNo });
    } catch (err) {
        console.error('Next credit note no error:', err);
        return res.status(500).json({ error: 'Failed to generate credit note number' });
    } finally {
        conn.release();
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT s.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                   p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            WHERE s.id = ? AND s.invoice_no LIKE 'CN-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).json({ error: 'Credit note not found' });
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

        return res.json({ creditNote: rows[0], items: itemRows });
    } catch (err) {
        console.error('Credit note get error:', err);
        return res.status(500).json({ error: 'Failed to fetch credit note' });
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

        const creditNoteNo = normalizeText(req.body.credit_note_no) || await getNextCreditNoteNo(conn);
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        const [result] = await conn.query('INSERT INTO sales_invoices SET ?', {
            invoice_no: creditNoteNo,
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

        if (affectsStock(status)) {
            for (const line of normalizedItems) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock + ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        await conn.commit();
        return res.status(201).json({ success: true, creditNoteId: result.insertId, creditNoteNo });
    } catch (err) {
        await conn.rollback();
        console.error('Credit note create error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Credit note number already exists' });
        return res.status(500).json({ error: 'Failed to create credit note' });
    } finally {
        conn.release();
    }
});

router.put('/:id', async (req, res) => {
    const creditNoteId = Number(req.params.id);
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
    if (!Number.isFinite(creditNoteId) || creditNoteId <= 0) errors.push('valid credit note id is required');
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!invoiceDate) errors.push('invoice_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            "SELECT id, invoice_no, status FROM sales_invoices WHERE id = ? AND invoice_no LIKE 'CN-%' FOR UPDATE",
            [creditNoteId]
        );
        if (!existingRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Credit note not found' });
        }

        if (String(existingRows[0].status) !== 'draft') {
            await conn.rollback();
            return res.status(400).json({ error: 'Only draft credit notes can be edited' });
        }

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const creditNoteNo = normalizeText(req.body.credit_note_no) || existingRows[0].invoice_no;
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
            {
                invoice_no: creditNoteNo,
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
            creditNoteId,
        ]);

        await conn.query('DELETE FROM sales_invoice_items WHERE sales_invoice_id = ?', [creditNoteId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: creditNoteId,
                ...line,
            });
        }

        // Existing note was a draft (enforced above), so no stock was added yet.
        // Add now if it is being confirmed.
        if (affectsStock(status)) {
            for (const line of normalizedItems) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock + ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        await conn.commit();
        return res.json({ success: true, creditNoteId, creditNoteNo });
    } catch (err) {
        await conn.rollback();
        console.error('Credit note update error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Credit note number already exists' });
        return res.status(500).json({ error: 'Failed to update credit note' });
    } finally {
        conn.release();
    }
});

// Cancel a credit note and reverse its stock impact.
// A confirmed credit note added stock back, so cancelling removes it again.
router.post('/:id/cancel', async (req, res) => {
    const creditNoteId = Number(req.params.id);
    if (!Number.isFinite(creditNoteId) || creditNoteId <= 0) {
        return res.status(400).json({ error: 'valid credit note id is required' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            "SELECT id, invoice_no, status FROM sales_invoices WHERE id = ? AND invoice_no LIKE 'CN-%' FOR UPDATE",
            [creditNoteId]
        );
        if (!rows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Credit note not found' });
        }

        const current = rows[0];
        if (String(current.status) === 'cancelled') {
            await conn.rollback();
            return res.status(400).json({ error: 'Credit note is already cancelled' });
        }

        if (affectsStock(current.status)) {
            const [lines] = await conn.query(
                'SELECT item_id, item_name, quantity FROM sales_invoice_items WHERE sales_invoice_id = ?',
                [creditNoteId]
            );

            // Block if reversing the returned stock would make any item go negative.
            for (const line of lines) {
                const [itemRows] = await conn.query(
                    'SELECT current_stock FROM items WHERE id = ? FOR UPDATE',
                    [line.item_id]
                );
                const stock = itemRows.length ? Number(itemRows[0].current_stock || 0) : 0;
                if (stock - Number(line.quantity) < 0) {
                    await conn.rollback();
                    return res.status(400).json({
                        error: `Cannot cancel: not enough stock to reverse for "${line.item_name}".`,
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

        await conn.query('UPDATE sales_invoices SET status = ? WHERE id = ?', ['cancelled', creditNoteId]);

        await conn.commit();
        return res.json({ success: true, id: creditNoteId, status: 'cancelled' });
    } catch (err) {
        await conn.rollback();
        console.error('Credit note cancel error:', err);
        return res.status(500).json({ error: 'Failed to cancel credit note' });
    } finally {
        conn.release();
    }
});

router.get('/:id/pdf', async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT s.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                   p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            WHERE s.id = ? AND s.invoice_no LIKE 'CN-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ error: 'Credit note not found' });

        const creditNote = rows[0];
        const [itemRows] = await db.query(
            `
            SELECT item_name, hsn_code, quantity, unit, rate, taxable_value, gst_percent, line_total
            FROM sales_invoice_items
            WHERE sales_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        const filename = `credit_note_${creditNote.invoice_no || creditNote.id}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');

        const company = await buildCompanyContext();
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        doc.pipe(res);

        renderDocument({
            doc,
            company,
            title: 'CREDIT NOTE',
            meta: [
                `Credit Note No: ${creditNote.invoice_no || '-'}`,
                `Date: ${String(creditNote.invoice_date || '').slice(0, 10)}`,
            ],
            partyLabel: 'Party',
            party: {
                name: creditNote.party_name,
                phone: creditNote.party_phone,
                gstin: creditNote.party_gstin,
                address: [creditNote.party_billing_address, creditNote.party_city, creditNote.party_state]
                    .filter(Boolean)
                    .join(', '),
            },
            items: itemRows,
            totals: creditNote,
            totalLabel: 'Credit Total',
            watermark: String(creditNote.status) === 'cancelled' ? 'CANCELLED' : null,
        });
    } catch (err) {
        console.error('Credit note pdf error:', err);
        return res.status(500).json({ error: 'Failed to generate credit note PDF' });
    }
});

export default router;
