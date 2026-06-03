import express from 'express';
import db from '../db.js';
import PDFDocument from 'pdfkit';

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

async function getNextChallanNo(conn) {
    const [rows] = await conn.query(
        "SELECT invoice_no FROM sales_invoices WHERE invoice_no LIKE 'DC-%' ORDER BY id DESC LIMIT 1"
    );
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `DC-${y}${m}${d}-`;

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
    const conditions = ["s.invoice_no LIKE 'DC-%'"];
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
        console.error('Delivery challan list error:', err);
        return res.status(500).json({ error: 'Failed to fetch delivery challans' });
    }
});

router.get('/next-challan-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const challanNo = await getNextChallanNo(conn);
        return res.json({ challanNo });
    } catch (err) {
        console.error('Next challan no error:', err);
        return res.status(500).json({ error: 'Failed to generate delivery challan number' });
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
            WHERE s.id = ? AND s.invoice_no LIKE 'DC-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).json({ error: 'Delivery challan not found' });
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

        return res.json({ challan: rows[0], items: itemRows });
    } catch (err) {
        console.error('Delivery challan get error:', err);
        return res.status(500).json({ error: 'Failed to fetch delivery challan' });
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

        const challanNo = normalizeText(req.body.challan_no) || await getNextChallanNo(conn);
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        const [result] = await conn.query('INSERT INTO sales_invoices SET ?', {
            invoice_no: challanNo,
            party_id: partyId,
            invoice_date: invoiceDate,
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
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: result.insertId,
                ...line,
            });
        }

        await conn.commit();
        return res.status(201).json({ success: true, challanId: result.insertId, challanNo });
    } catch (err) {
        await conn.rollback();
        console.error('Delivery challan create error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Delivery challan number already exists' });
        return res.status(500).json({ error: 'Failed to create delivery challan' });
    } finally {
        conn.release();
    }
});

router.put('/:id', async (req, res) => {
    const challanId = Number(req.params.id);
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
    if (!Number.isFinite(challanId) || challanId <= 0) errors.push('valid delivery challan id is required');
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!invoiceDate) errors.push('invoice_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            "SELECT id, invoice_no, status FROM sales_invoices WHERE id = ? AND invoice_no LIKE 'DC-%' FOR UPDATE",
            [challanId]
        );
        if (!existingRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Delivery challan not found' });
        }

        if (String(existingRows[0].status) !== 'draft') {
            await conn.rollback();
            return res.status(400).json({ error: 'Only draft delivery challans can be edited' });
        }

        const [partyRows] = await conn.query('SELECT id FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const challanNo = normalizeText(req.body.challan_no) || existingRows[0].invoice_no;
        const { normalizedItems, errors: lineErrors } = await computeLines(conn, inputItems, supplyType);
        if (lineErrors.length) {
            await conn.rollback();
            return res.status(400).json({ error: lineErrors.join(', ') });
        }

        const totals = summarizeTotals(normalizedItems, headerDiscountAmount, roundOff, 0);

        await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
            {
                invoice_no: challanNo,
                party_id: partyId,
                invoice_date: invoiceDate,
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
            challanId,
        ]);

        await conn.query('DELETE FROM sales_invoice_items WHERE sales_invoice_id = ?', [challanId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: challanId,
                ...line,
            });
        }

        await conn.commit();
        return res.json({ success: true, challanId, challanNo });
    } catch (err) {
        await conn.rollback();
        console.error('Delivery challan update error:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Delivery challan number already exists' });
        return res.status(500).json({ error: 'Failed to update delivery challan' });
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
            WHERE s.id = ? AND s.invoice_no LIKE 'DC-%'
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ error: 'Delivery challan not found' });

        const challan = rows[0];
        const [itemRows] = await db.query(
            `
            SELECT item_name, hsn_code, quantity, unit, rate, taxable_value, gst_percent, line_total
            FROM sales_invoice_items
            WHERE sales_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        const filename = `delivery_challan_${challan.invoice_no || challan.id}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');

        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.pipe(res);

        doc.fontSize(20).font('Helvetica-Bold').text('DELIVERY CHALLAN', { align: 'right' });
        doc.moveDown(0.3);
        doc.fontSize(11).font('Helvetica').text(`Challan No: ${challan.invoice_no || '-'}`, { align: 'right' });
        doc.text(`Challan Date: ${String(challan.invoice_date || '').slice(0, 10)}`, { align: 'right' });

        doc.moveDown(0.7);
        doc.fontSize(12).font('Helvetica-Bold').text('Delivered To');
        doc.fontSize(11).font('Helvetica').text(challan.party_name || '-');
        if (challan.party_phone) doc.text(`Phone: ${challan.party_phone}`);
        if (challan.party_gstin) doc.text(`GSTIN: ${challan.party_gstin}`);

        let y = doc.y + 14;
        doc.font('Helvetica-Bold').fontSize(10).text('Item', 40, y);
        doc.text('Qty', 280, y, { width: 60, align: 'right' });
        doc.text('Rate', 350, y, { width: 70, align: 'right' });
        doc.text('GST %', 430, y, { width: 60, align: 'right' });
        doc.text('Line Total', 495, y, { width: 60, align: 'right' });
        y += 18;

        doc.font('Helvetica').fontSize(10);
        itemRows.forEach((line) => {
            doc.text(String(line.item_name || '-'), 40, y, { width: 220 });
            doc.text(`${Number(line.quantity || 0).toFixed(0)} ${line.unit || ''}`, 280, y, { width: 60, align: 'right' });
            doc.text(Number(line.rate || 0).toFixed(2), 350, y, { width: 70, align: 'right' });
            doc.text(Number(line.gst_percent || 0).toFixed(2), 430, y, { width: 60, align: 'right' });
            doc.text(Number(line.line_total || 0).toFixed(2), 495, y, { width: 60, align: 'right' });
            y += 18;
            if (y > 730) {
                doc.addPage();
                y = 60;
            }
        });

        doc.moveTo(360, y + 6).lineTo(555, y + 6).stroke('#D1D5DB');
        doc.font('Helvetica').fontSize(11);
        doc.text(`Subtotal: ${Number(challan.subtotal || 0).toFixed(2)}`, 370, y + 14, { width: 185, align: 'right' });
        doc.text(`Taxable: ${Number(challan.taxable_amount || 0).toFixed(2)}`, 370, y + 30, { width: 185, align: 'right' });
        doc.text(`CGST: ${Number(challan.cgst_amount || 0).toFixed(2)}`, 370, y + 46, { width: 185, align: 'right' });
        doc.text(`SGST: ${Number(challan.sgst_amount || 0).toFixed(2)}`, 370, y + 62, { width: 185, align: 'right' });
        doc.text(`IGST: ${Number(challan.igst_amount || 0).toFixed(2)}`, 370, y + 78, { width: 185, align: 'right' });
        doc.font('Helvetica-Bold').fontSize(12).text(`Total: ${Number(challan.total_amount || 0).toFixed(2)}`, 350, y + 100, {
            width: 205,
            align: 'right',
        });

        doc.end();
    } catch (err) {
        console.error('Delivery challan pdf error:', err);
        return res.status(500).json({ error: 'Failed to generate delivery challan PDF' });
    }
});

export default router;
