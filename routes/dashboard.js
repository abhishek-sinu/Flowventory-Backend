import express from 'express';
const router = express.Router();
import db from '../db.js';

router.get('/stats', async (req, res) => {
    try {
        let todaySales = 0, monthRevenue = 0, totalReceivables = 0,
            totalPayables = 0, lowStockItems = 0, totalParties = 0,
            recentTransactions = [];

        // Sales posted today (exclude draft/cancelled)
        try {
            const [[row]] = await db.query(
                `
                SELECT COALESCE(SUM(total_amount), 0) AS v
                FROM sales_invoices
                WHERE DATE(invoice_date) = CURDATE()
                  AND status NOT IN ('draft', 'cancelled')
                `
            );
            todaySales = Number(row.v) || 0;
        } catch (_) {}

        // Current month posted sales
        try {
            const [[row]] = await db.query(
                `
                SELECT COALESCE(SUM(total_amount), 0) AS v
                FROM sales_invoices
                WHERE YEAR(invoice_date) = YEAR(CURDATE())
                  AND MONTH(invoice_date) = MONTH(CURDATE())
                  AND status NOT IN ('draft', 'cancelled')
                `
            );
            monthRevenue = Number(row.v) || 0;
        } catch (_) {}

        // Open customer balances
        try {
            const [[row]] = await db.query(
                `
                SELECT COALESCE(SUM(balance_amount), 0) AS v
                FROM sales_invoices
                WHERE status IN ('confirmed', 'partially_paid')
                `
            );
            totalReceivables = Number(row.v) || 0;
        } catch (_) {}

        // Open supplier balances
        try {
            const [[row]] = await db.query(
                `
                SELECT COALESCE(SUM(balance_amount), 0) AS v
                FROM purchase_invoices
                WHERE status IN ('confirmed', 'partially_paid')
                `
            );
            totalPayables = Number(row.v) || 0;
        } catch (_) {}

        try {
            const [[row]] = await db.query(
                `
                SELECT COUNT(*) AS v
                FROM items
                WHERE is_active = 1
                  AND current_stock <= low_stock_threshold
                `
            );
            lowStockItems = Number(row.v) || 0;
        } catch (_) {}

        try {
            const [[row]] = await db.query(
                `
                SELECT COUNT(*) AS v
                FROM parties
                WHERE is_active = 1
                `
            );
            totalParties = Number(row.v) || 0;
        } catch (_) {}

        // Latest sales + purchase bills for transaction widget
        try {
            const [rows] = await db.query(
                `
                SELECT
                    t.party_name,
                    t.type,
                    t.amount,
                    t.date,
                    t.status
                FROM (
                    SELECT
                        p.name AS party_name,
                        'sale' AS type,
                        s.total_amount AS amount,
                        s.invoice_date AS date,
                        s.status AS status,
                        s.id AS ref_id
                    FROM sales_invoices s
                    JOIN parties p ON p.id = s.party_id
                    WHERE s.status <> 'draft'

                    UNION ALL

                    SELECT
                        p.name AS party_name,
                        'purchase' AS type,
                        piv.total_amount AS amount,
                        piv.bill_date AS date,
                        piv.status AS status,
                        piv.id AS ref_id
                    FROM purchase_invoices piv
                    JOIN parties p ON p.id = piv.party_id
                    WHERE piv.status <> 'draft'
                ) t
                ORDER BY t.date DESC, t.ref_id DESC
                LIMIT 10
                `
            );
            recentTransactions = Array.isArray(rows) ? rows : [];
        } catch (_) {}

        res.json({
            todaySales,
            monthRevenue,
            totalReceivables,
            totalPayables,
            lowStockItems,
            totalParties,
            recentTransactions,
        });
    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
});

export default router;
