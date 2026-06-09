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

export async function getNextPaymentNo(conn) {
    const [rows] = await conn.query('SELECT payment_no FROM payment_out ORDER BY id DESC LIMIT 1');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const prefix = `PMT-${y}${m}${d}-`;

    let seq = 1;
    if (rows.length && String(rows[0].payment_no || '').startsWith(prefix)) {
        const n = Number(String(rows[0].payment_no).slice(prefix.length));
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
        conditions.push('(po.payment_no LIKE ? OR p.name LIKE ? OR pi.bill_no LIKE ? OR po.reference_no LIKE ?)');
        params.push(pattern, pattern, pattern, pattern);
    }

    if (party_id) {
        conditions.push('po.party_id = ?');
        params.push(Number(party_id));
    }

    if (payment_mode) {
        conditions.push('po.payment_mode = ?');
        params.push(String(payment_mode));
    }

    if (from_date) {
        conditions.push('po.payment_date >= ?');
        params.push(String(from_date));
    }

    if (to_date) {
        conditions.push('po.payment_date <= ?');
        params.push(String(to_date));
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                po.id,
                po.payment_no,
                po.payment_date,
                po.amount,
                po.payment_mode,
                po.reference_no,
                po.notes,
                po.created_at,
                p.id AS party_id,
                p.name AS party_name,
                pi.id AS purchase_invoice_id,
                pi.bill_no,
                pi.total_amount,
                pi.paid_amount,
                pi.balance_amount,
                pi.status AS bill_status
            FROM payment_out po
            JOIN parties p ON p.id = po.party_id
            LEFT JOIN purchase_invoices pi ON pi.id = po.purchase_invoice_id
            ${whereSql}
            ORDER BY po.payment_date DESC, po.id DESC
            `,
            params
        );

        return res.json(rows);
    } catch (err) {
        console.error('Payment Out list error:', err);
        return res.status(500).json({ error: 'Failed to fetch payment out entries' });
    }
});

router.get('/next-payment-no', async (_req, res) => {
    const conn = await db.getConnection();
    try {
        const paymentNo = await getNextPaymentNo(conn);
        return res.json({ paymentNo });
    } catch (err) {
        console.error('Next payment no error:', err);
        return res.status(500).json({ error: 'Failed to generate payment number' });
    } finally {
        conn.release();
    }
});

router.get('/open-bills', async (req, res) => {
    const partyId = Number(req.query.party_id);
    if (!Number.isFinite(partyId) || partyId <= 0) {
        return res.status(400).json({ error: 'party_id is required' });
    }

    try {
        const [rows] = await db.query(
            `
            SELECT
                id,
                bill_no,
                bill_date,
                total_amount,
                paid_amount,
                balance_amount,
                status
            FROM purchase_invoices
            WHERE party_id = ?
              AND status IN ('confirmed', 'partially_paid')
              AND balance_amount > 0
            ORDER BY bill_date ASC, id ASC
            `,
            [partyId]
        );
        return res.json(rows);
    } catch (err) {
        console.error('Payment Out open bills error:', err);
        return res.status(500).json({ error: 'Failed to fetch open bills' });
    }
});

router.post('/', async (req, res) => {
    const partyId = Number(req.body.party_id);
    const purchaseInvoiceIdRaw = req.body.purchase_invoice_id;
    const purchaseInvoiceId = purchaseInvoiceIdRaw === null || purchaseInvoiceIdRaw === undefined || purchaseInvoiceIdRaw === ''
        ? null
        : Number(purchaseInvoiceIdRaw);
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
    if (purchaseInvoiceId !== null && (!Number.isFinite(purchaseInvoiceId) || purchaseInvoiceId <= 0)) {
        errors.push('purchase_invoice_id must be valid when provided');
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

        let billBefore = null;
        if (purchaseInvoiceId !== null) {
            const [billRows] = await conn.query(
                `
                SELECT id, party_id, bill_no, total_amount, paid_amount, balance_amount, status
                FROM purchase_invoices
                WHERE id = ?
                FOR UPDATE
                `,
                [purchaseInvoiceId]
            );

            if (!billRows.length) {
                await conn.rollback();
                return res.status(400).json({ error: 'purchase bill not found' });
            }

            billBefore = billRows[0];
            if (Number(billBefore.party_id) !== partyId) {
                await conn.rollback();
                return res.status(400).json({ error: 'selected bill does not belong to party' });
            }
            if (String(billBefore.status) === 'draft' || String(billBefore.status) === 'cancelled') {
                await conn.rollback();
                return res.status(400).json({ error: 'payment cannot be applied to draft or cancelled bill' });
            }
            if (Number(billBefore.balance_amount) <= 0) {
                await conn.rollback();
                return res.status(400).json({ error: 'bill is already fully paid' });
            }
            if (amount > Number(billBefore.balance_amount)) {
                await conn.rollback();
                return res.status(400).json({ error: 'payment amount cannot exceed bill balance' });
            }
        }

        const paymentNo = normalizeText(req.body.payment_no) || await getNextPaymentNo(conn);

        const [paymentResult] = await conn.query('INSERT INTO payment_out SET ?', {
            payment_no: paymentNo,
            party_id: partyId,
            purchase_invoice_id: purchaseInvoiceId,
            payment_date: paymentDate,
            amount: round2(amount),
            payment_mode: paymentMode,
            reference_no: referenceNo,
            notes,
        });

        let billAfter = null;
        if (billBefore) {
            const nextPaid = round2(Number(billBefore.paid_amount || 0) + amount);
            const nextBalance = round2(Math.max(0, Number(billBefore.total_amount || 0) - nextPaid));
            let nextStatus = 'confirmed';
            if (nextBalance <= 0) {
                nextStatus = 'paid';
            } else if (nextPaid > 0) {
                nextStatus = 'partially_paid';
            }

            await conn.query('UPDATE purchase_invoices SET ? WHERE id = ?', [
                {
                    paid_amount: nextPaid,
                    balance_amount: nextBalance,
                    status: nextStatus,
                },
                billBefore.id,
            ]);

            billAfter = {
                id: billBefore.id,
                bill_no: billBefore.bill_no,
                paid_amount: nextPaid,
                balance_amount: nextBalance,
                status: nextStatus,
            };
        }

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'create_payment_out',
                    details: JSON.stringify({
                        payment_out_id: paymentResult.insertId,
                        payment_no: paymentNo,
                        amount: round2(amount),
                        purchase_invoice_id: purchaseInvoiceId,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.status(201).json({
            success: true,
            payment: {
                id: paymentResult.insertId,
                payment_no: paymentNo,
                party_id: partyId,
                purchase_invoice_id: purchaseInvoiceId,
                payment_date: paymentDate,
                amount: round2(amount),
                payment_mode: paymentMode,
                reference_no: referenceNo,
                notes,
            },
            bill: billAfter,
        });
    } catch (err) {
        await conn.rollback();
        console.error('Payment Out create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Payment number already exists' });
        }
        return res.status(500).json({ error: 'Failed to record payment out' });
    } finally {
        conn.release();
    }
});

// Delete (reverse) a payment out. Rolls back the linked bill's paid/balance
// amounts and status so the ledger and payables stay consistent.
router.delete('/:id', async (req, res) => {
    const paymentId = Number(req.params.id);
    if (!Number.isFinite(paymentId) || paymentId <= 0) {
        return res.status(400).json({ error: 'valid payment id is required' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [paymentRows] = await conn.query(
            'SELECT id, payment_no, purchase_invoice_id, amount FROM payment_out WHERE id = ? FOR UPDATE',
            [paymentId]
        );
        if (!paymentRows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Payment not found' });
        }

        const payment = paymentRows[0];
        let billAfter = null;

        if (payment.purchase_invoice_id) {
            const [billRows] = await conn.query(
                'SELECT id, bill_no, total_amount, paid_amount, balance_amount, status FROM purchase_invoices WHERE id = ? FOR UPDATE',
                [payment.purchase_invoice_id]
            );

            if (billRows.length) {
                const bill = billRows[0];
                // A cancelled bill stays cancelled; just remove the payment.
                if (String(bill.status) !== 'cancelled') {
                    const nextPaid = round2(Math.max(0, Number(bill.paid_amount || 0) - Number(payment.amount || 0)));
                    const nextBalance = round2(Math.max(0, Number(bill.total_amount || 0) - nextPaid));
                    let nextStatus = 'confirmed';
                    if (nextBalance <= 0 && nextPaid > 0) {
                        nextStatus = 'paid';
                    } else if (nextPaid > 0) {
                        nextStatus = 'partially_paid';
                    }

                    await conn.query('UPDATE purchase_invoices SET ? WHERE id = ?', [
                        { paid_amount: nextPaid, balance_amount: nextBalance, status: nextStatus },
                        bill.id,
                    ]);

                    billAfter = {
                        id: bill.id,
                        bill_no: bill.bill_no,
                        paid_amount: nextPaid,
                        balance_amount: nextBalance,
                        status: nextStatus,
                    };
                }
            }
        }

        await conn.query('DELETE FROM payment_out WHERE id = ?', [paymentId]);

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'delete_payment_out',
                    details: JSON.stringify({
                        payment_out_id: paymentId,
                        payment_no: payment.payment_no,
                        amount: Number(payment.amount || 0),
                        purchase_invoice_id: payment.purchase_invoice_id,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        return res.json({ success: true, id: paymentId, bill: billAfter });
    } catch (err) {
        await conn.rollback();
        console.error('Payment Out delete error:', err);
        return res.status(500).json({ error: 'Failed to delete payment out' });
    } finally {
        conn.release();
    }
});

export default router;
