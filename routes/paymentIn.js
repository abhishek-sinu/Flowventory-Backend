import express from 'express';
import db from '../db.js';

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

export async function getNextReceiptNo(conn) {
    const [rows] = await conn.query('SELECT receipt_no FROM payment_in ORDER BY id DESC LIMIT 1');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `RCPT-${y}${m}${d}-`;

    let seq = 1;
    if (rows.length && String(rows[0].receipt_no || '').startsWith(prefix)) {
        const n = Number(String(rows[0].receipt_no).slice(prefix.length));
        if (Number.isFinite(n) && n >= 1) seq = n + 1;
    }

    return `${prefix}${String(seq).padStart(3, '0')}`;
}

router.get('/', async (req, res) => {
    const { q, party_id, payment_mode, from_date, to_date } = req.query;
    const conditions = [];
    const params = [];

    if (q) {
        const pattern = `%${q}%`;
        conditions.push('(pi.receipt_no LIKE ? OR p.name LIKE ? OR si.invoice_no LIKE ? OR pi.reference_no LIKE ?)');
        params.push(pattern, pattern, pattern, pattern);
    }

    if (party_id) {
        conditions.push('pi.party_id = ?');
        params.push(Number(party_id));
    }

    if (payment_mode) {
        conditions.push('pi.payment_mode = ?');
        params.push(String(payment_mode));
    }

    if (from_date) {
        conditions.push('pi.payment_date >= ?');
        params.push(String(from_date));
    }

    if (to_date) {
        conditions.push('pi.payment_date <= ?');
        params.push(String(to_date));
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                pi.id,
                pi.receipt_no,
                pi.payment_date,
                pi.amount,
                pi.payment_mode,
                pi.reference_no,
                pi.notes,
                pi.created_at,
                p.id AS party_id,
                p.name AS party_name,
                si.id AS sales_invoice_id,
                si.invoice_no,
                si.total_amount,
                si.paid_amount,
                si.balance_amount,
                si.status AS invoice_status
            FROM payment_in pi
            JOIN parties p ON p.id = pi.party_id
            LEFT JOIN sales_invoices si ON si.id = pi.sales_invoice_id
            ${whereSql}
            ORDER BY pi.payment_date DESC, pi.id DESC
            `,
            params
        );

        return res.json(rows);
    } catch (err) {
        console.error('Payment In list error:', err);
        return res.status(500).json({ error: 'Failed to fetch payment receipts' });
    }
});

router.get('/next-receipt-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const receiptNo = await getNextReceiptNo(conn);
        return res.json({ receiptNo });
    } catch (err) {
        console.error('Next receipt no error:', err);
        return res.status(500).json({ error: 'Failed to generate receipt number' });
    } finally {
        conn.release();
    }
});

router.get('/open-invoices', async (req, res) => {
    const partyId = Number(req.query.party_id);
    if (!Number.isFinite(partyId) || partyId <= 0) {
        return res.status(400).json({ error: 'party_id is required' });
    }

    try {
        const [rows] = await db.query(
            `
            SELECT
                id,
                invoice_no,
                invoice_date,
                total_amount,
                paid_amount,
                balance_amount,
                status
            FROM sales_invoices
            WHERE party_id = ?
              AND status IN ('confirmed', 'partially_paid')
              AND balance_amount > 0
            ORDER BY invoice_date ASC, id ASC
            `,
            [partyId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Payment In open invoices error:', err);
        return res.status(500).json({ error: 'Failed to fetch open invoices' });
    }
});

router.post('/', async (req, res) => {
    const partyId = Number(req.body.party_id);
    const salesInvoiceIdRaw = req.body.sales_invoice_id;
    const salesInvoiceId = salesInvoiceIdRaw === null || salesInvoiceIdRaw === undefined || salesInvoiceIdRaw === ''
        ? null
        : Number(salesInvoiceIdRaw);
    const paymentDate = normalizeText(req.body.payment_date);
    const amount = toNumber(req.body.amount, 0);
    const paymentMode = normalizeText(req.body.payment_mode) || 'cash';
    const referenceNo = normalizeText(req.body.reference_no);
    const notes = normalizeText(req.body.notes);

    const errors = [];
    if (!Number.isFinite(partyId) || partyId <= 0) errors.push('party_id is required');
    if (!paymentDate) errors.push('payment_date is required');
    if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be greater than 0');
    if (!['cash', 'bank', 'upi', 'card', 'cheque', 'other'].includes(paymentMode)) {
        errors.push('invalid payment_mode');
    }
    if (salesInvoiceId !== null && (!Number.isFinite(salesInvoiceId) || salesInvoiceId <= 0)) {
        errors.push('sales_invoice_id must be valid when provided');
    }

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

        let invoiceBefore = null;
        if (salesInvoiceId !== null) {
            const [invoiceRows] = await conn.query(
                `
                SELECT id, party_id, invoice_no, total_amount, paid_amount, balance_amount, status
                FROM sales_invoices
                WHERE id = ?
                FOR UPDATE
                `,
                [salesInvoiceId]
            );

            if (!invoiceRows.length) {
                await conn.rollback();
                return res.status(400).json({ error: 'sales invoice not found' });
            }

            invoiceBefore = invoiceRows[0];
            if (Number(invoiceBefore.party_id) !== partyId) {
                await conn.rollback();
                return res.status(400).json({ error: 'selected invoice does not belong to party' });
            }
            if (String(invoiceBefore.status) === 'draft' || String(invoiceBefore.status) === 'cancelled') {
                await conn.rollback();
                return res.status(400).json({ error: 'payment cannot be applied to draft or cancelled invoice' });
            }
            if (Number(invoiceBefore.balance_amount) <= 0) {
                await conn.rollback();
                return res.status(400).json({ error: 'invoice is already fully paid' });
            }
            if (amount > Number(invoiceBefore.balance_amount)) {
                await conn.rollback();
                return res.status(400).json({ error: 'payment amount cannot exceed invoice balance' });
            }
        }

        const receiptNo = normalizeText(req.body.receipt_no) || await getNextReceiptNo(conn);

        const [receiptResult] = await conn.query('INSERT INTO payment_in SET ?', {
            receipt_no: receiptNo,
            party_id: partyId,
            sales_invoice_id: salesInvoiceId,
            payment_date: paymentDate,
            amount: round2(amount),
            payment_mode: paymentMode,
            reference_no: referenceNo,
            notes,
        });

        let invoiceAfter = null;
        if (invoiceBefore) {
            const nextPaid = round2(Number(invoiceBefore.paid_amount || 0) + amount);
            const nextBalance = round2(Math.max(0, Number(invoiceBefore.total_amount || 0) - nextPaid));
            let nextStatus = 'confirmed';
            if (nextBalance <= 0) {
                nextStatus = 'paid';
            } else if (nextPaid > 0) {
                nextStatus = 'partially_paid';
            }

            await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
                {
                    paid_amount: nextPaid,
                    balance_amount: nextBalance,
                    status: nextStatus,
                },
                invoiceBefore.id,
            ]);

            invoiceAfter = {
                id: invoiceBefore.id,
                invoice_no: invoiceBefore.invoice_no,
                paid_amount: nextPaid,
                balance_amount: nextBalance,
                status: nextStatus,
            };
        }

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'create_payment_in',
                    details: JSON.stringify({
                        payment_in_id: receiptResult.insertId,
                        receipt_no: receiptNo,
                        amount: round2(amount),
                        sales_invoice_id: salesInvoiceId,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.status(201).json({
            success: true,
            payment: {
                id: receiptResult.insertId,
                receipt_no: receiptNo,
                party_id: partyId,
                sales_invoice_id: salesInvoiceId,
                payment_date: paymentDate,
                amount: round2(amount),
                payment_mode: paymentMode,
                reference_no: referenceNo,
                notes,
            },
            invoice: invoiceAfter,
        });
    } catch (err) {
        await conn.rollback();
        console.error('Payment In create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Receipt number already exists' });
        }
        return res.status(500).json({ error: 'Failed to record payment' });
    } finally {
        conn.release();
    }
});

// Delete (reverse) a payment. This rolls back the linked invoice's paid/balance
// amounts and status so the ledger and receivables stay consistent.
router.delete('/:id', async (req, res) => {
    const paymentId = Number(req.params.id);
    if (!Number.isFinite(paymentId) || paymentId <= 0) {
        return res.status(400).json({ error: 'valid payment id is required' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [paymentRows] = await conn.query(
            'SELECT id, receipt_no, sales_invoice_id, amount FROM payment_in WHERE id = ? FOR UPDATE',
            [paymentId]
        );
        if (!paymentRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Payment not found' });
        }

        const payment = paymentRows[0];
        let invoiceAfter = null;

        if (payment.sales_invoice_id) {
            const [invoiceRows] = await conn.query(
                'SELECT id, invoice_no, total_amount, paid_amount, balance_amount, status FROM sales_invoices WHERE id = ? FOR UPDATE',
                [payment.sales_invoice_id]
            );

            if (invoiceRows.length) {
                const invoice = invoiceRows[0];
                // A cancelled invoice stays cancelled; just remove the payment.
                if (String(invoice.status) !== 'cancelled') {
                    const nextPaid = round2(Math.max(0, Number(invoice.paid_amount || 0) - Number(payment.amount || 0)));
                    const nextBalance = round2(Math.max(0, Number(invoice.total_amount || 0) - nextPaid));
                    let nextStatus = 'confirmed';
                    if (nextBalance <= 0 && nextPaid > 0) {
                        nextStatus = 'paid';
                    } else if (nextPaid > 0) {
                        nextStatus = 'partially_paid';
                    }

                    await conn.query('UPDATE sales_invoices SET ? WHERE id = ?', [
                        { paid_amount: nextPaid, balance_amount: nextBalance, status: nextStatus },
                        invoice.id,
                    ]);

                    invoiceAfter = {
                        id: invoice.id,
                        invoice_no: invoice.invoice_no,
                        paid_amount: nextPaid,
                        balance_amount: nextBalance,
                        status: nextStatus,
                    };
                }
            }
        }

        await conn.query('DELETE FROM payment_in WHERE id = ?', [paymentId]);

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'delete_payment_in',
                    details: JSON.stringify({
                        payment_in_id: paymentId,
                        receipt_no: payment.receipt_no,
                        amount: Number(payment.amount || 0),
                        sales_invoice_id: payment.sales_invoice_id,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.json({ success: true, id: paymentId, invoice: invoiceAfter });
    } catch (err) {
        await conn.rollback();
        console.error('Payment In delete error:', err);
        return res.status(500).json({ error: 'Failed to delete payment' });
    } finally {
        conn.release();
    }
});

export default router;
