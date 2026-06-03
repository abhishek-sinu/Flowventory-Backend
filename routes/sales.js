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

async function getNextInvoiceNo(conn) {
    const [rows] = await conn.query('SELECT invoice_no FROM sales_invoices ORDER BY id DESC LIMIT 1');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `SINV-${y}${m}${d}-`;

    let seq = 1;
    if (rows.length && String(rows[0].invoice_no || '').startsWith(prefix)) {
        const n = Number(String(rows[0].invoice_no).slice(prefix.length));
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
        conditions.push('(s.invoice_no LIKE ? OR p.name LIKE ?)');
        params.push(pattern, pattern);
    }

    if (status) {
        conditions.push('s.status = ?');
        params.push(String(status));
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                s.id,
                s.invoice_no,
                s.invoice_date,
                s.due_date,
                s.total_amount,
                s.paid_amount,
                s.balance_amount,
                s.status,
                s.created_at,
                p.id AS party_id,
                p.name AS party_name
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            ${whereSql}
            ORDER BY s.invoice_date DESC, s.id DESC
            `,
            params
        );

        return res.json(rows);
    } catch (err) {
        console.error('Sales list error:', err);
        return res.status(500).json({ error: 'Failed to fetch sales invoices' });
    }
});

router.get('/next-invoice-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const invoiceNo = await getNextInvoiceNo(conn);
        return res.json({ invoiceNo });
    } catch (err) {
        console.error('Next invoice no error:', err);
        return res.status(500).json({ error: 'Failed to generate invoice number' });
    } finally {
        conn.release();
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [invoiceRows] = await db.query(
            `
            SELECT
                s.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            WHERE s.id = ?
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!invoiceRows.length) {
            return res.status(404).json({ error: 'Invoice not found' });
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
            FROM sales_invoice_items
            WHERE sales_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        return res.json({ invoice: invoiceRows[0], items: itemRows });
    } catch (err) {
        console.error('Sales get invoice error:', err);
        return res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});

router.get('/:id/pdf', async (req, res) => {
    try {
        const [invoiceRows] = await db.query(
            `
            SELECT
                s.*, p.name AS party_name, p.phone AS party_phone, p.gstin AS party_gstin,
                p.billing_address AS party_billing_address, p.city AS party_city, p.state AS party_state
            FROM sales_invoices s
            JOIN parties p ON p.id = s.party_id
            WHERE s.id = ?
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!invoiceRows.length) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const invoice = invoiceRows[0];
        const [itemRows] = await db.query(
            `
            SELECT
                item_name,
                hsn_code,
                quantity,
                unit,
                rate,
                discount_amount,
                taxable_value,
                gst_percent,
                cgst_amount,
                sgst_amount,
                igst_amount,
                line_total
            FROM sales_invoice_items
            WHERE sales_invoice_id = ?
            ORDER BY id ASC
            `,
            [req.params.id]
        );

        const filename = `invoice_${invoice.invoice_no || invoice.id}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');

        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.pipe(res);

        doc.fontSize(20).font('Helvetica-Bold').text('TAX INVOICE', { align: 'right' });
        doc.moveDown(0.3);
        doc.fontSize(11).font('Helvetica').text(`Invoice No: ${invoice.invoice_no || '-'}`, { align: 'right' });
        doc.text(`Invoice Date: ${String(invoice.invoice_date || '').slice(0, 10)}`, { align: 'right' });
        if (invoice.due_date) {
            doc.text(`Due Date: ${String(invoice.due_date || '').slice(0, 10)}`, { align: 'right' });
        }

        doc.moveDown(0.7);
        doc.fontSize(12).font('Helvetica-Bold').text('Bill To');
        doc.fontSize(11).font('Helvetica').text(invoice.party_name || '-');
        if (invoice.party_phone) doc.text(`Phone: ${invoice.party_phone}`);
        if (invoice.party_gstin) doc.text(`GSTIN: ${invoice.party_gstin}`);
        const address = [invoice.party_billing_address, invoice.party_city, invoice.party_state]
            .filter(Boolean)
            .join(', ');
        if (address) doc.text(address);

        doc.moveDown(0.8);
        const tableTop = doc.y;
        const x = 40;
        const w = [24, 180, 56, 50, 70, 70, 70];
        const headers = ['#', 'Item', 'Qty', 'Rate', 'Taxable', 'GST', 'Line Total'];
        let cursorX = x;

        doc.font('Helvetica-Bold').fontSize(10);
        headers.forEach((header, i) => {
            doc.rect(cursorX, tableTop, w[i], 22).fillAndStroke('#E5E7EB', '#D1D5DB');
            doc.fillColor('#111827').text(header, cursorX + 4, tableTop + 7, {
                width: w[i] - 8,
                align: i >= 2 ? 'right' : 'left',
            });
            cursorX += w[i];
        });

        let y = tableTop + 22;
        doc.font('Helvetica').fontSize(9);
        itemRows.forEach((line, idx) => {
            cursorX = x;
            const row = [
                String(idx + 1),
                `${line.item_name || '-'}${line.hsn_code ? `\nHSN: ${line.hsn_code}` : ''}`,
                `${Number(line.quantity || 0).toFixed(3)} ${line.unit || ''}`,
                Number(line.rate || 0).toFixed(2),
                Number(line.taxable_value || 0).toFixed(2),
                Number(line.gst_percent || 0).toFixed(2),
                Number(line.line_total || 0).toFixed(2),
            ];

            const rowHeight = 28;
            row.forEach((cell, i) => {
                doc.rect(cursorX, y, w[i], rowHeight).stroke('#E5E7EB');
                doc.fillColor('#111827').text(cell, cursorX + 4, y + 7, {
                    width: w[i] - 8,
                    align: i >= 2 ? 'right' : 'left',
                    ellipsis: true,
                });
                cursorX += w[i];
            });

            y += rowHeight;
            if (y > 700) {
                doc.addPage();
                y = 60;
            }
        });

        doc.moveTo(350, y + 10).lineTo(555, y + 10).stroke('#D1D5DB');
        doc.font('Helvetica').fontSize(10);
        doc.text(`Subtotal: ${Number(invoice.subtotal || 0).toFixed(2)}`, 370, y + 18, { width: 185, align: 'right' });
        doc.text(`Taxable: ${Number(invoice.taxable_amount || 0).toFixed(2)}`, 370, y + 34, { width: 185, align: 'right' });
        doc.text(`CGST: ${Number(invoice.cgst_amount || 0).toFixed(2)}`, 370, y + 50, { width: 185, align: 'right' });
        doc.text(`SGST: ${Number(invoice.sgst_amount || 0).toFixed(2)}`, 370, y + 66, { width: 185, align: 'right' });
        doc.text(`IGST: ${Number(invoice.igst_amount || 0).toFixed(2)}`, 370, y + 82, { width: 185, align: 'right' });
        doc.font('Helvetica-Bold').fontSize(12).text(`Grand Total: ${Number(invoice.total_amount || 0).toFixed(2)}`, 350, y + 102, {
            width: 205,
            align: 'right',
        });

        doc.end();
        return;
    } catch (err) {
        console.error('Sales invoice pdf error:', err);
        return res.status(500).json({ error: 'Failed to generate invoice PDF' });
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

    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [partyRows] = await conn.query('SELECT id, name FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const invoiceNo = normalizeText(req.body.invoice_no) || await getNextInvoiceNo(conn);

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

        const [invoiceResult] = await conn.query('INSERT INTO sales_invoices SET ?', {
            invoice_no: invoiceNo,
            party_id: partyId,
            invoice_date: invoiceDate,
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
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: invoiceResult.insertId,
                ...line,
            });
        }

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'create_sales_invoice',
                    details: JSON.stringify({
                        sales_invoice_id: invoiceResult.insertId,
                        invoice_no: invoiceNo,
                        total_amount: totalAmount,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();

        return res.status(201).json({
            success: true,
            invoice: {
                id: invoiceResult.insertId,
                invoice_no: invoiceNo,
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
        console.error('Sales create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Invoice number already exists' });
        }
        return res.status(500).json({ error: 'Failed to create sales invoice' });
    } finally {
        conn.release();
    }
});

router.put('/:id', async (req, res) => {
    const invoiceId = Number(req.params.id);
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
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) errors.push('valid invoice id is required');
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!invoiceDate) errors.push('invoice_date is required');
    if (!inputItems.length) errors.push('at least one item is required');
    if (!['intra', 'inter'].includes(supplyType)) errors.push('supply_type must be intra or inter');

    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingInvoiceRows] = await conn.query(
            'SELECT id, invoice_no, status FROM sales_invoices WHERE id = ? FOR UPDATE',
            [invoiceId]
        );
        if (!existingInvoiceRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Invoice not found' });
        }

        if (String(existingInvoiceRows[0].status) !== 'draft') {
            await conn.rollback();
            return res.status(400).json({ error: 'Only draft invoices can be edited' });
        }

        const [partyRows] = await conn.query('SELECT id, name FROM parties WHERE id = ? LIMIT 1', [partyId]);
        if (!partyRows.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'party not found' });
        }

        const invoiceNo = normalizeText(req.body.invoice_no) || existingInvoiceRows[0].invoice_no;

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

        await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
            {
                invoice_no: invoiceNo,
                party_id: partyId,
                invoice_date: invoiceDate,
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
            invoiceId,
        ]);

        await conn.query('DELETE FROM sales_invoice_items WHERE sales_invoice_id = ?', [invoiceId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: invoiceId,
                ...line,
            });
        }

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'update_sales_invoice',
                    details: JSON.stringify({
                        sales_invoice_id: invoiceId,
                        invoice_no: invoiceNo,
                        total_amount: totalAmount,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.json({
            success: true,
            invoice: {
                id: invoiceId,
                invoice_no: invoiceNo,
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
        console.error('Sales update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Invoice number already exists' });
        }
        return res.status(500).json({ error: 'Failed to update sales invoice' });
    } finally {
        conn.release();
    }
});

export default router;
