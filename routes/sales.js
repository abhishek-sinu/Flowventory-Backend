import express from 'express';
import db from '../db.js';
import PDFDocument from 'pdfkit';
import { buildCompanyContext, renderDocument } from '../utils/pdfRenderer.js';
import { getNextReceiptNo } from './paymentIn.js';

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

// Stock is deducted only for invoices that actually leave inventory.
// Drafts and cancelled invoices do not affect stock.
function reducesStock(status) {
    return status !== 'draft' && status !== 'cancelled';
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

        const company = await buildCompanyContext();
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        doc.pipe(res);

        renderDocument({
            doc,
            company,
            title: 'TAX INVOICE',
            meta: [
                `Invoice No: ${invoice.invoice_no || '-'}`,
                `Invoice Date: ${String(invoice.invoice_date || '').slice(0, 10)}`,
                invoice.due_date ? `Due Date: ${String(invoice.due_date || '').slice(0, 10)}` : '',
            ],
            partyLabel: 'Bill To',
            party: {
                name: invoice.party_name,
                phone: invoice.party_phone,
                gstin: invoice.party_gstin,
                address: [invoice.party_billing_address, invoice.party_city, invoice.party_state]
                    .filter(Boolean)
                    .join(', '),
            },
            items: itemRows,
            totals: invoice,
            totalLabel: 'Grand Total',
            payment: { paid: invoice.paid_amount, balance: invoice.balance_amount },
            watermark: String(invoice.status) === 'cancelled' ? 'CANCELLED' : null,
        });

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

        const [invoiceResult] = await conn.query('INSERT INTO sales_invoices SET ?', {
            invoice_no: invoiceNo,
            party_id: partyId,
            invoice_date: invoiceDate,
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
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: invoiceResult.insertId,
                ...line,
            });
        }

        if (reducesStock(status)) {
            for (const line of normalizedItems) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock - ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        // If the invoice is created with an upfront paid amount, record a matching
        // Payment In receipt so the party ledger and receivables stay consistent.
        // Only for booked sales invoices (SINV-, not draft/cancelled/estimate/DC).
        if (paidAmount > 0 && reducesStock(status) && String(invoiceNo).startsWith('SINV-')) {
            const receiptNo = await getNextReceiptNo(conn);
            await conn.query('INSERT INTO payment_in SET ?', {
                receipt_no: receiptNo,
                party_id: partyId,
                sales_invoice_id: invoiceResult.insertId,
                payment_date: invoiceDate,
                amount: round2(paidAmount),
                payment_mode: 'cash',
                reference_no: null,
                notes: `Auto-recorded with invoice ${invoiceNo}`,
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

        await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
            {
                invoice_no: invoiceNo,
                party_id: partyId,
                invoice_date: invoiceDate,
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
            invoiceId,
        ]);

        await conn.query('DELETE FROM sales_invoice_items WHERE sales_invoice_id = ?', [invoiceId]);
        for (const line of normalizedItems) {
            await conn.query('INSERT INTO sales_invoice_items SET ?', {
                sales_invoice_id: invoiceId,
                ...line,
            });
        }

        // Existing invoice was a draft (enforced above), so no stock was deducted yet.
        // Deduct now if it is being confirmed.
        if (reducesStock(status)) {
            for (const line of normalizedItems) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock - ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
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

// Cancel a sales invoice and reverse its stock impact.
// A confirmed sale removed stock, so cancelling it adds that stock back.
router.post('/:id/cancel', async (req, res) => {
    const invoiceId = Number(req.params.id);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({ error: 'valid invoice id is required' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            'SELECT id, invoice_no, status, paid_amount, balance_amount FROM sales_invoices WHERE id = ? FOR UPDATE',
            [invoiceId]
        );
        if (!rows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Invoice not found' });
        }

        const current = rows[0];
        if (String(current.status) === 'cancelled') {
            await conn.rollback();
            return res.status(400).json({ error: 'Invoice is already cancelled' });
        }

        // Block cancellation if payments have been recorded against this invoice.
        // The user must delete those payments first so the ledger stays consistent.
        const [paymentRows] = await conn.query(
            'SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM payment_in WHERE sales_invoice_id = ?',
            [invoiceId]
        );
        if (Number(paymentRows[0]?.cnt || 0) > 0) {
            await conn.rollback();
            return res.status(409).json({
                error: `Cannot cancel: ${paymentRows[0].cnt} payment(s) totalling ${Number(paymentRows[0].total).toFixed(2)} are linked to this invoice. Delete the payment(s) first.`,
            });
        }

        // Only restore stock if the invoice had actually deducted it.
        if (reducesStock(current.status)) {
            const [lines] = await conn.query(
                'SELECT item_id, quantity FROM sales_invoice_items WHERE sales_invoice_id = ?',
                [invoiceId]
            );
            for (const line of lines) {
                await conn.query(
                    'UPDATE items SET current_stock = current_stock + ? WHERE id = ?',
                    [line.quantity, line.item_id]
                );
            }
        }

        // Zero out the financials: a cancelled invoice owes nothing and is paid nothing.
        await conn.query(
            'UPDATE sales_invoices SET status = ?, paid_amount = 0, balance_amount = 0 WHERE id = ?',
            ['cancelled', invoiceId]
        );

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'cancel_sales_invoice',
                    details: JSON.stringify({
                        sales_invoice_id: invoiceId,
                        invoice_no: current.invoice_no,
                        previous_status: current.status,
                        stock_restored: reducesStock(current.status),
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.json({ success: true, id: invoiceId, status: 'cancelled' });
    } catch (err) {
        await conn.rollback();
        console.error('Sales cancel error:', err);
        return res.status(500).json({ error: 'Failed to cancel sales invoice' });
    } finally {
        conn.release();
    }
});

export default router;
