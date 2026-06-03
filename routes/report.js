import express from 'express';
const router = express.Router();
import db from '../db.js';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';

function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeMode(mode) {
    return mode === 'aggregate' ? 'aggregate' : 'individual';
}

function buildDonationWhereClause(query) {
    const conditions = [];
    const params = [];

    if (query.dateFrom) {
        conditions.push('donations.transaction_date >= ?');
        params.push(query.dateFrom);
    }
    if (query.dateTo) {
        conditions.push('donations.transaction_date <= ?');
        params.push(query.dateTo);
    }
    if (query.amountMin !== undefined && query.amountMin !== '') {
        conditions.push('donations.amount >= ?');
        params.push(Number(query.amountMin));
    }
    if (query.amountMax !== undefined && query.amountMax !== '') {
        conditions.push('donations.amount <= ?');
        params.push(Number(query.amountMax));
    }
    if (query.scheme) {
        conditions.push('LOWER(donations.scheme_name) LIKE ?');
        params.push(`%${String(query.scheme).toLowerCase()}%`);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params };
}

async function getReportRows(query) {
    const mode = normalizeMode(query.mode);
    const { whereSql, params } = buildDonationWhereClause(query);

    if (mode === 'aggregate') {
        const [rows] = await db.query(
            `
            SELECT
                MIN(donations.id) AS id,
                phone_group.donor_phone AS donor_phone,
                COALESCE(MAX(donors.name), MAX(donations.donor_name)) AS donor_name,
                MAX(cultivators.name) AS cultivator_name,
                COUNT(*) AS donation_count,
                SUM(donations.amount) AS amount,
                MIN(donations.transaction_date) AS first_date,
                MAX(donations.transaction_date) AS last_date,
                GROUP_CONCAT(DISTINCT donations.scheme_name ORDER BY donations.scheme_name SEPARATOR ', ') AS scheme_names
            FROM donations
            JOIN (
                SELECT id, COALESCE(NULLIF(phone_number, ''), CONCAT('NO_PHONE_', id)) AS donor_phone
                FROM donations
            ) AS phone_group ON phone_group.id = donations.id
            LEFT JOIN donors ON donations.phone_number = donors.phone
            LEFT JOIN cultivators ON donors.cultivator_id = cultivators.id
            ${whereSql}
            GROUP BY phone_group.donor_phone
            ORDER BY SUM(donations.amount) DESC
            `,
            params
        );
        return rows;
    }

    const [rows] = await db.query(
        `
        SELECT
            donations.id,
            donations.receipt_number,
            COALESCE(donors.name, donations.donor_name) AS donor_name,
            COALESCE(donors.phone, donations.phone_number) AS donor_phone,
            donations.transaction_date,
            donations.amount,
            donations.scheme_name,
            donations.mode_of_payment,
            donations.instrument_number,
            cultivators.name AS cultivator_name
        FROM donations
        LEFT JOIN donors ON donations.phone_number = donors.phone
        LEFT JOIN cultivators ON donors.cultivator_id = cultivators.id
        ${whereSql}
        ORDER BY donations.transaction_date DESC, donations.id DESC
        `,
        params
    );

    return rows;
}

function prettifyKey(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeDateFields(row) {
    const normalized = { ...row };
    Object.keys(normalized).forEach(key => {
        if ((key.includes('date') || key === 'created_at') && normalized[key]) {
            normalized[key] = new Date(normalized[key]).toLocaleDateString('en-IN');
        }
    });
    return normalized;
}

/**
 * @swagger
 * tags:
 *   name: Report
 *   description: Reporting endpoints
 */

/**
 * @swagger
 * /api/report/donations/xls:
 *   get:
 *     summary: Export donations to XLS
 *     tags: [Report]
 *     responses:
 *       200:
 *         description: XLS file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 */
// XLS export for donations
router.get('/donations/xls', async (req, res) => {
    try {
        const mode = normalizeMode(req.query.mode);
        const results = await getReportRows(req.query);
        const cleaned = results.map(({ id, ...rest }) => normalizeDateFields(rest));
        const ws = XLSX.utils.json_to_sheet(cleaned);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Donations');
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const filename = mode === 'aggregate' ? 'donations_aggregate.xlsx' : 'donations.xlsx';
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: err });
    }
});

// PDF export for donations
/**
 * @swagger
 * /api/report/donations/pdf:
 *   get:
 *     summary: Export donations to PDF
 *     tags: [Report]
 *     responses:
 *       200:
 *         description: PDF file download
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/donations/pdf', async (req, res) => {
    try {
        const mode = normalizeMode(req.query.mode);
        const results = await getReportRows(req.query);
        const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
        const filename = mode === 'aggregate' ? 'donations_aggregate.pdf' : 'donations.pdf';
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.type('application/pdf');
        doc.pipe(res);

        doc.fontSize(18).text(mode === 'aggregate' ? 'Donations Aggregate Report' : 'Donations Report', { align: 'center' });
        doc.moveDown();

        if (results.length === 0) {
            doc.fontSize(12).text('No donations found.');
            doc.end();
            return;
        }

        // Get columns (exclude id)
        const allKeys = Object.keys(results[0]).filter(k => k !== 'id');
        const colCount = allKeys.length;
        const tableLeft = 40;
        const tableWidth = doc.page.width - 80;
        const colWidth = tableWidth / colCount;
        const rowHeight = 25;

        // Draw header
        let y = doc.y;
        doc.fontSize(9).font('Helvetica-Bold');
        doc.rect(tableLeft, y, tableWidth, rowHeight).fill('#2563EB');
        allKeys.forEach((key, i) => {
            const label = prettifyKey(key);
            doc.fillColor('#FFFFFF').text(label, tableLeft + i * colWidth + 4, y + 7, { width: colWidth - 8, ellipsis: true });
        });
        y += rowHeight;

        // Draw rows
        doc.font('Helvetica').fillColor('#000000');
        results.forEach((row, rowIndex) => {
            // Add new page if needed
            if (y + rowHeight > doc.page.height - 40) {
                doc.addPage();
                y = 40;
            }
            const bgColor = rowIndex % 2 === 0 ? '#F3F4F6' : '#FFFFFF';
            doc.rect(tableLeft, y, tableWidth, rowHeight).fill(bgColor);
            doc.fillColor('#000000');
            allKeys.forEach((key, i) => {
                let val = row[key] != null ? String(row[key]) : '-';
                if ((key.includes('date') || key === 'created_at') && row[key]) {
                    try { val = new Date(row[key]).toLocaleDateString('en-IN'); } catch(e) {}
                }
                doc.fontSize(8).text(val, tableLeft + i * colWidth + 4, y + 7, { width: colWidth - 8, ellipsis: true });
            });
            y += rowHeight;
        });

        doc.end();
    } catch (err) {
        res.status(500).json({ error: err });
    }
});

router.get('/profit-loss', async (req, res) => {
    const { from_date: fromDate, to_date: toDate } = req.query;

    const dateFilters = [];
    const dateParams = [];

    if (fromDate) {
        dateFilters.push('doc_date >= ?');
        dateParams.push(String(fromDate));
    }
    if (toDate) {
        dateFilters.push('doc_date <= ?');
        dateParams.push(String(toDate));
    }

    const dateWhere = dateFilters.length ? `WHERE ${dateFilters.join(' AND ')}` : '';

    try {
        const [salesRows] = await db.query(
            `
            SELECT SUM(total_amount) AS total
            FROM sales_invoices
            WHERE invoice_no LIKE 'SINV-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${fromDate ? 'AND invoice_date >= ?' : ''}
              ${toDate ? 'AND invoice_date <= ?' : ''}
            `,
            dateParams
        );

        const [creditRows] = await db.query(
            `
            SELECT SUM(total_amount) AS total
            FROM sales_invoices
            WHERE invoice_no LIKE 'CN-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${fromDate ? 'AND invoice_date >= ?' : ''}
              ${toDate ? 'AND invoice_date <= ?' : ''}
            `,
            dateParams
        );

        const [purchaseRows] = await db.query(
            `
            SELECT SUM(total_amount) AS total
            FROM purchase_invoices
            WHERE bill_no LIKE 'PINV-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${fromDate ? 'AND bill_date >= ?' : ''}
              ${toDate ? 'AND bill_date <= ?' : ''}
            `,
            dateParams
        );

        const [debitRows] = await db.query(
            `
            SELECT SUM(total_amount) AS total
            FROM purchase_invoices
            WHERE bill_no LIKE 'DN-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${fromDate ? 'AND bill_date >= ?' : ''}
              ${toDate ? 'AND bill_date <= ?' : ''}
            `,
            dateParams
        );

        const [monthSeriesRows] = await db.query(
            `
            SELECT
                ym,
                SUM(sales_total) AS gross_sales,
                SUM(credit_total) AS credit_notes,
                SUM(purchase_total) AS gross_purchases,
                SUM(debit_total) AS debit_notes
            FROM (
                SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS ym, invoice_date AS doc_date,
                       SUM(total_amount) AS sales_total, 0 AS credit_total, 0 AS purchase_total, 0 AS debit_total
                FROM sales_invoices
                WHERE invoice_no LIKE 'SINV-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(invoice_date, '%Y-%m'), invoice_date

                UNION ALL

                SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS ym, invoice_date AS doc_date,
                       0 AS sales_total, SUM(total_amount) AS credit_total, 0 AS purchase_total, 0 AS debit_total
                FROM sales_invoices
                WHERE invoice_no LIKE 'CN-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(invoice_date, '%Y-%m'), invoice_date

                UNION ALL

                SELECT DATE_FORMAT(bill_date, '%Y-%m') AS ym, bill_date AS doc_date,
                       0 AS sales_total, 0 AS credit_total, SUM(total_amount) AS purchase_total, 0 AS debit_total
                FROM purchase_invoices
                WHERE bill_no LIKE 'PINV-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(bill_date, '%Y-%m'), bill_date

                UNION ALL

                SELECT DATE_FORMAT(bill_date, '%Y-%m') AS ym, bill_date AS doc_date,
                       0 AS sales_total, 0 AS credit_total, 0 AS purchase_total, SUM(total_amount) AS debit_total
                FROM purchase_invoices
                WHERE bill_no LIKE 'DN-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(bill_date, '%Y-%m'), bill_date
            ) combined
            ${dateWhere}
            GROUP BY ym
            ORDER BY ym ASC
            `,
            dateParams
        );

        const grossSales = Number(salesRows[0]?.total || 0);
        const salesReturns = Number(creditRows[0]?.total || 0);
        const netSales = round2(grossSales - salesReturns);

        const grossPurchases = Number(purchaseRows[0]?.total || 0);
        const purchaseReturns = Number(debitRows[0]?.total || 0);
        const netPurchases = round2(grossPurchases - purchaseReturns);

        const grossProfit = round2(netSales - netPurchases);
        const grossMarginPercent = netSales > 0 ? round2((grossProfit / netSales) * 100) : 0;

        const series = monthSeriesRows.map((row) => {
            const rowNetSales = round2(Number(row.gross_sales || 0) - Number(row.credit_notes || 0));
            const rowNetPurchases = round2(Number(row.gross_purchases || 0) - Number(row.debit_notes || 0));
            return {
                month: row.ym,
                gross_sales: round2(Number(row.gross_sales || 0)),
                credit_notes: round2(Number(row.credit_notes || 0)),
                net_sales: rowNetSales,
                gross_purchases: round2(Number(row.gross_purchases || 0)),
                debit_notes: round2(Number(row.debit_notes || 0)),
                net_purchases: rowNetPurchases,
                gross_profit: round2(rowNetSales - rowNetPurchases),
            };
        });

        return res.json({
            summary: {
                from_date: fromDate || null,
                to_date: toDate || null,
                gross_sales: round2(grossSales),
                credit_notes: round2(salesReturns),
                net_sales: netSales,
                gross_purchases: round2(grossPurchases),
                debit_notes: round2(purchaseReturns),
                net_purchases: netPurchases,
                gross_profit: grossProfit,
                gross_margin_percent: grossMarginPercent,
            },
            month_wise: series,
        });
    } catch (err) {
        console.error('Profit & Loss report error:', err);
        return res.status(500).json({ error: 'Failed to fetch profit and loss report' });
    }
});

router.get('/stock-summary', async (req, res) => {
    const { q, category, active, low_stock_only: lowStockOnly } = req.query;
    const conditions = [];
    const params = [];

    if (q) {
        const pattern = `%${String(q).trim()}%`;
        conditions.push('(name LIKE ? OR sku LIKE ?)');
        params.push(pattern, pattern);
    }

    if (category) {
        conditions.push('category = ?');
        params.push(String(category));
    }

    if (active === '0' || active === '1') {
        conditions.push('is_active = ?');
        params.push(Number(active));
    } else {
        conditions.push('is_active = 1');
    }

    if (String(lowStockOnly) === '1') {
        conditions.push('current_stock <= low_stock_threshold');
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                id,
                name,
                sku,
                category,
                unit,
                current_stock,
                low_stock_threshold,
                purchase_price,
                sale_price,
                is_active,
                updated_at
            FROM items
            ${whereSql}
            ORDER BY updated_at DESC, id DESC
            `,
            params
        );

        const normalized = rows.map((row) => {
            const stockQty = Number(row.current_stock || 0);
            const costRate = Number(row.purchase_price || 0);
            const saleRate = Number(row.sale_price || 0);
            const lowStock = stockQty <= Number(row.low_stock_threshold || 0);

            return {
                ...row,
                stock_value_cost: round2(stockQty * costRate),
                stock_value_sale: round2(stockQty * saleRate),
                low_stock_flag: lowStock ? 1 : 0,
            };
        });

        const summary = normalized.reduce(
            (acc, row) => {
                acc.total_items += 1;
                acc.total_stock_qty = round2(acc.total_stock_qty + Number(row.current_stock || 0));
                acc.stock_value_cost = round2(acc.stock_value_cost + Number(row.stock_value_cost || 0));
                acc.stock_value_sale = round2(acc.stock_value_sale + Number(row.stock_value_sale || 0));
                if (Number(row.low_stock_flag) === 1) acc.low_stock_items += 1;
                return acc;
            },
            {
                total_items: 0,
                total_stock_qty: 0,
                stock_value_cost: 0,
                stock_value_sale: 0,
                low_stock_items: 0,
            }
        );

        const categories = Array.from(
            new Set(
                normalized
                    .map((row) => (row.category ? String(row.category).trim() : ''))
                    .filter(Boolean)
            )
        ).sort((a, b) => a.localeCompare(b));

        return res.json({ summary, items: normalized, categories });
    } catch (err) {
        console.error('Stock summary report error:', err);
        return res.status(500).json({ error: 'Failed to fetch stock summary report' });
    }
});

router.get('/gst-summary', async (req, res) => {
    const { from_date: fromDate, to_date: toDate } = req.query;
    const dateParams = [];
    const salesDateFilter = `${fromDate ? 'AND invoice_date >= ?' : ''} ${toDate ? 'AND invoice_date <= ?' : ''}`;
    const purchaseDateFilter = `${fromDate ? 'AND bill_date >= ?' : ''} ${toDate ? 'AND bill_date <= ?' : ''}`;
    if (fromDate) dateParams.push(String(fromDate));
    if (toDate) dateParams.push(String(toDate));

    const monthFilters = [];
    const monthParams = [];
    if (fromDate) {
        monthFilters.push('doc_date >= ?');
        monthParams.push(String(fromDate));
    }
    if (toDate) {
        monthFilters.push('doc_date <= ?');
        monthParams.push(String(toDate));
    }
    const monthWhere = monthFilters.length ? `WHERE ${monthFilters.join(' AND ')}` : '';

    try {
        const [salesRows] = await db.query(
            `
            SELECT
                SUM(taxable_amount) AS taxable,
                SUM(cgst_amount) AS cgst,
                SUM(sgst_amount) AS sgst,
                SUM(igst_amount) AS igst
            FROM sales_invoices
            WHERE invoice_no LIKE 'SINV-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${salesDateFilter}
            `,
            dateParams
        );

        const [creditRows] = await db.query(
            `
            SELECT
                SUM(taxable_amount) AS taxable,
                SUM(cgst_amount) AS cgst,
                SUM(sgst_amount) AS sgst,
                SUM(igst_amount) AS igst
            FROM sales_invoices
            WHERE invoice_no LIKE 'CN-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${salesDateFilter}
            `,
            dateParams
        );

        const [purchaseRows] = await db.query(
            `
            SELECT
                SUM(taxable_amount) AS taxable,
                SUM(cgst_amount) AS cgst,
                SUM(sgst_amount) AS sgst,
                SUM(igst_amount) AS igst
            FROM purchase_invoices
            WHERE bill_no LIKE 'PINV-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${purchaseDateFilter}
            `,
            dateParams
        );

        const [debitRows] = await db.query(
            `
            SELECT
                SUM(taxable_amount) AS taxable,
                SUM(cgst_amount) AS cgst,
                SUM(sgst_amount) AS sgst,
                SUM(igst_amount) AS igst
            FROM purchase_invoices
            WHERE bill_no LIKE 'DN-%'
              AND status IN ('confirmed', 'partially_paid', 'paid')
              ${purchaseDateFilter}
            `,
            dateParams
        );

        const [monthRows] = await db.query(
            `
            SELECT
                ym,
                SUM(out_taxable) AS outward_taxable,
                SUM(out_cgst) AS outward_cgst,
                SUM(out_sgst) AS outward_sgst,
                SUM(out_igst) AS outward_igst,
                SUM(out_taxable_adjustment) AS outward_taxable_adjustment,
                SUM(out_cgst_adjustment) AS outward_cgst_adjustment,
                SUM(out_sgst_adjustment) AS outward_sgst_adjustment,
                SUM(out_igst_adjustment) AS outward_igst_adjustment,
                SUM(in_taxable) AS inward_taxable,
                SUM(in_cgst) AS inward_cgst,
                SUM(in_sgst) AS inward_sgst,
                SUM(in_igst) AS inward_igst,
                SUM(in_taxable_adjustment) AS inward_taxable_adjustment,
                SUM(in_cgst_adjustment) AS inward_cgst_adjustment,
                SUM(in_sgst_adjustment) AS inward_sgst_adjustment,
                SUM(in_igst_adjustment) AS inward_igst_adjustment
            FROM (
                SELECT
                    DATE_FORMAT(invoice_date, '%Y-%m') AS ym,
                    invoice_date AS doc_date,
                    SUM(taxable_amount) AS out_taxable,
                    SUM(cgst_amount) AS out_cgst,
                    SUM(sgst_amount) AS out_sgst,
                    SUM(igst_amount) AS out_igst,
                    0 AS out_taxable_adjustment,
                    0 AS out_cgst_adjustment,
                    0 AS out_sgst_adjustment,
                    0 AS out_igst_adjustment,
                    0 AS in_taxable,
                    0 AS in_cgst,
                    0 AS in_sgst,
                    0 AS in_igst,
                    0 AS in_taxable_adjustment,
                    0 AS in_cgst_adjustment,
                    0 AS in_sgst_adjustment,
                    0 AS in_igst_adjustment
                FROM sales_invoices
                WHERE invoice_no LIKE 'SINV-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(invoice_date, '%Y-%m'), invoice_date

                UNION ALL

                SELECT
                    DATE_FORMAT(invoice_date, '%Y-%m') AS ym,
                    invoice_date AS doc_date,
                    0 AS out_taxable,
                    0 AS out_cgst,
                    0 AS out_sgst,
                    0 AS out_igst,
                    SUM(taxable_amount) AS out_taxable_adjustment,
                    SUM(cgst_amount) AS out_cgst_adjustment,
                    SUM(sgst_amount) AS out_sgst_adjustment,
                    SUM(igst_amount) AS out_igst_adjustment,
                    0 AS in_taxable,
                    0 AS in_cgst,
                    0 AS in_sgst,
                    0 AS in_igst,
                    0 AS in_taxable_adjustment,
                    0 AS in_cgst_adjustment,
                    0 AS in_sgst_adjustment,
                    0 AS in_igst_adjustment
                FROM sales_invoices
                WHERE invoice_no LIKE 'CN-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(invoice_date, '%Y-%m'), invoice_date

                UNION ALL

                SELECT
                    DATE_FORMAT(bill_date, '%Y-%m') AS ym,
                    bill_date AS doc_date,
                    0 AS out_taxable,
                    0 AS out_cgst,
                    0 AS out_sgst,
                    0 AS out_igst,
                    0 AS out_taxable_adjustment,
                    0 AS out_cgst_adjustment,
                    0 AS out_sgst_adjustment,
                    0 AS out_igst_adjustment,
                    SUM(taxable_amount) AS in_taxable,
                    SUM(cgst_amount) AS in_cgst,
                    SUM(sgst_amount) AS in_sgst,
                    SUM(igst_amount) AS in_igst,
                    0 AS in_taxable_adjustment,
                    0 AS in_cgst_adjustment,
                    0 AS in_sgst_adjustment,
                    0 AS in_igst_adjustment
                FROM purchase_invoices
                WHERE bill_no LIKE 'PINV-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(bill_date, '%Y-%m'), bill_date

                UNION ALL

                SELECT
                    DATE_FORMAT(bill_date, '%Y-%m') AS ym,
                    bill_date AS doc_date,
                    0 AS out_taxable,
                    0 AS out_cgst,
                    0 AS out_sgst,
                    0 AS out_igst,
                    0 AS out_taxable_adjustment,
                    0 AS out_cgst_adjustment,
                    0 AS out_sgst_adjustment,
                    0 AS out_igst_adjustment,
                    0 AS in_taxable,
                    0 AS in_cgst,
                    0 AS in_sgst,
                    0 AS in_igst,
                    SUM(taxable_amount) AS in_taxable_adjustment,
                    SUM(cgst_amount) AS in_cgst_adjustment,
                    SUM(sgst_amount) AS in_sgst_adjustment,
                    SUM(igst_amount) AS in_igst_adjustment
                FROM purchase_invoices
                WHERE bill_no LIKE 'DN-%'
                  AND status IN ('confirmed', 'partially_paid', 'paid')
                GROUP BY DATE_FORMAT(bill_date, '%Y-%m'), bill_date
            ) monthly
            ${monthWhere}
            GROUP BY ym
            ORDER BY ym ASC
            `,
            monthParams
        );

        const outwardGross = {
            taxable: Number(salesRows[0]?.taxable || 0),
            cgst: Number(salesRows[0]?.cgst || 0),
            sgst: Number(salesRows[0]?.sgst || 0),
            igst: Number(salesRows[0]?.igst || 0),
        };
        const outwardAdjustments = {
            taxable: Number(creditRows[0]?.taxable || 0),
            cgst: Number(creditRows[0]?.cgst || 0),
            sgst: Number(creditRows[0]?.sgst || 0),
            igst: Number(creditRows[0]?.igst || 0),
        };

        const inwardGross = {
            taxable: Number(purchaseRows[0]?.taxable || 0),
            cgst: Number(purchaseRows[0]?.cgst || 0),
            sgst: Number(purchaseRows[0]?.sgst || 0),
            igst: Number(purchaseRows[0]?.igst || 0),
        };
        const inwardAdjustments = {
            taxable: Number(debitRows[0]?.taxable || 0),
            cgst: Number(debitRows[0]?.cgst || 0),
            sgst: Number(debitRows[0]?.sgst || 0),
            igst: Number(debitRows[0]?.igst || 0),
        };

        const outwardNet = {
            taxable: round2(outwardGross.taxable - outwardAdjustments.taxable),
            cgst: round2(outwardGross.cgst - outwardAdjustments.cgst),
            sgst: round2(outwardGross.sgst - outwardAdjustments.sgst),
            igst: round2(outwardGross.igst - outwardAdjustments.igst),
        };
        outwardNet.total_tax = round2(outwardNet.cgst + outwardNet.sgst + outwardNet.igst);

        const inwardNet = {
            taxable: round2(inwardGross.taxable - inwardAdjustments.taxable),
            cgst: round2(inwardGross.cgst - inwardAdjustments.cgst),
            sgst: round2(inwardGross.sgst - inwardAdjustments.sgst),
            igst: round2(inwardGross.igst - inwardAdjustments.igst),
        };
        inwardNet.total_tax = round2(inwardNet.cgst + inwardNet.sgst + inwardNet.igst);

        const monthWise = monthRows.map((row) => {
            const outNetTaxable = round2(Number(row.outward_taxable || 0) - Number(row.outward_taxable_adjustment || 0));
            const outNetCgst = round2(Number(row.outward_cgst || 0) - Number(row.outward_cgst_adjustment || 0));
            const outNetSgst = round2(Number(row.outward_sgst || 0) - Number(row.outward_sgst_adjustment || 0));
            const outNetIgst = round2(Number(row.outward_igst || 0) - Number(row.outward_igst_adjustment || 0));

            const inNetTaxable = round2(Number(row.inward_taxable || 0) - Number(row.inward_taxable_adjustment || 0));
            const inNetCgst = round2(Number(row.inward_cgst || 0) - Number(row.inward_cgst_adjustment || 0));
            const inNetSgst = round2(Number(row.inward_sgst || 0) - Number(row.inward_sgst_adjustment || 0));
            const inNetIgst = round2(Number(row.inward_igst || 0) - Number(row.inward_igst_adjustment || 0));

            const outTotalTax = round2(outNetCgst + outNetSgst + outNetIgst);
            const inTotalTax = round2(inNetCgst + inNetSgst + inNetIgst);

            return {
                month: row.ym,
                outward_taxable: outNetTaxable,
                outward_cgst: outNetCgst,
                outward_sgst: outNetSgst,
                outward_igst: outNetIgst,
                outward_total_tax: outTotalTax,
                inward_taxable: inNetTaxable,
                inward_cgst: inNetCgst,
                inward_sgst: inNetSgst,
                inward_igst: inNetIgst,
                inward_total_tax: inTotalTax,
                net_gst_payable: round2(outTotalTax - inTotalTax),
            };
        });

        return res.json({
            summary: {
                from_date: fromDate || null,
                to_date: toDate || null,
                gstr1: {
                    gross_outward: {
                        taxable: round2(outwardGross.taxable),
                        cgst: round2(outwardGross.cgst),
                        sgst: round2(outwardGross.sgst),
                        igst: round2(outwardGross.igst),
                    },
                    credit_note_adjustments: {
                        taxable: round2(outwardAdjustments.taxable),
                        cgst: round2(outwardAdjustments.cgst),
                        sgst: round2(outwardAdjustments.sgst),
                        igst: round2(outwardAdjustments.igst),
                    },
                    net_outward: outwardNet,
                },
                gstr3b: {
                    outward_tax_liability: {
                        cgst: outwardNet.cgst,
                        sgst: outwardNet.sgst,
                        igst: outwardNet.igst,
                        total_tax: outwardNet.total_tax,
                    },
                    input_tax_credit: {
                        cgst: inwardNet.cgst,
                        sgst: inwardNet.sgst,
                        igst: inwardNet.igst,
                        total_tax: inwardNet.total_tax,
                    },
                    net_gst_payable: round2(outwardNet.total_tax - inwardNet.total_tax),
                },
                inward_summary: {
                    gross_inward: {
                        taxable: round2(inwardGross.taxable),
                        cgst: round2(inwardGross.cgst),
                        sgst: round2(inwardGross.sgst),
                        igst: round2(inwardGross.igst),
                    },
                    debit_note_adjustments: {
                        taxable: round2(inwardAdjustments.taxable),
                        cgst: round2(inwardAdjustments.cgst),
                        sgst: round2(inwardAdjustments.sgst),
                        igst: round2(inwardAdjustments.igst),
                    },
                    net_inward: inwardNet,
                },
            },
            month_wise: monthWise,
        });
    } catch (err) {
        console.error('GST summary report error:', err);
        return res.status(500).json({ error: 'Failed to fetch GST summary report' });
    }
});

router.get('/party-ledger', async (req, res) => {
    const partyId = Number(req.query.party_id);
    const { from_date: fromDate, to_date: toDate } = req.query;

    if (!Number.isFinite(partyId) || partyId <= 0) {
        return res.status(400).json({ error: 'party_id is required' });
    }

    try {
        const [partyRows] = await db.query(
            `
            SELECT id, name, party_type, opening_balance, balance_nature, current_balance
            FROM parties
            WHERE id = ?
            LIMIT 1
            `,
            [partyId]
        );

        if (!partyRows.length) {
            return res.status(404).json({ error: 'Party not found' });
        }

        const party = partyRows[0];
        const baseAmount = Number(party.opening_balance || 0);
        const openingSign = String(party.balance_nature || 'receivable') === 'payable' ? -1 : 1;
        const openingSigned = round2(baseAmount * openingSign);

        const dateFilters = [];
        const dateParams = [partyId, partyId, partyId, partyId, partyId, partyId];
        if (fromDate) {
            dateFilters.push('txn_date >= ?');
            dateParams.push(String(fromDate));
        }
        if (toDate) {
            dateFilters.push('txn_date <= ?');
            dateParams.push(String(toDate));
        }
        const dateWhere = dateFilters.length ? `WHERE ${dateFilters.join(' AND ')}` : '';

        const [rows] = await db.query(
            `
            SELECT *
            FROM (
                SELECT
                    'sale' AS txn_type,
                    s.id AS ref_id,
                    s.invoice_no AS ref_no,
                    s.invoice_date AS txn_date,
                    'Sales Invoice' AS source,
                    s.total_amount AS debit_amount,
                    0 AS credit_amount,
                    s.created_at
                FROM sales_invoices s
                WHERE s.party_id = ?
                  AND s.invoice_no LIKE 'SINV-%'
                  AND s.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'credit_note' AS txn_type,
                    s.id AS ref_id,
                    s.invoice_no AS ref_no,
                    s.invoice_date AS txn_date,
                    'Credit Note' AS source,
                    0 AS debit_amount,
                    s.total_amount AS credit_amount,
                    s.created_at
                FROM sales_invoices s
                WHERE s.party_id = ?
                  AND s.invoice_no LIKE 'CN-%'
                  AND s.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'purchase' AS txn_type,
                    b.id AS ref_id,
                    b.bill_no AS ref_no,
                    b.bill_date AS txn_date,
                    'Purchase Bill' AS source,
                    0 AS debit_amount,
                    b.total_amount AS credit_amount,
                    b.created_at
                FROM purchase_invoices b
                WHERE b.party_id = ?
                  AND b.bill_no LIKE 'PINV-%'
                  AND b.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'debit_note' AS txn_type,
                    b.id AS ref_id,
                    b.bill_no AS ref_no,
                    b.bill_date AS txn_date,
                    'Debit Note' AS source,
                    b.total_amount AS debit_amount,
                    0 AS credit_amount,
                    b.created_at
                FROM purchase_invoices b
                WHERE b.party_id = ?
                  AND b.bill_no LIKE 'DN-%'
                  AND b.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'payment_in' AS txn_type,
                    pi.id AS ref_id,
                    pi.receipt_no AS ref_no,
                    pi.payment_date AS txn_date,
                    'Payment In' AS source,
                    0 AS debit_amount,
                    pi.amount AS credit_amount,
                    pi.created_at
                FROM payment_in pi
                WHERE pi.party_id = ?

                UNION ALL

                SELECT
                    'payment_out' AS txn_type,
                    po.id AS ref_id,
                    po.payment_no AS ref_no,
                    po.payment_date AS txn_date,
                    'Payment Out' AS source,
                    po.amount AS debit_amount,
                    0 AS credit_amount,
                    po.created_at
                FROM payment_out po
                WHERE po.party_id = ?
            ) ledger
            ${dateWhere}
            ORDER BY txn_date ASC, created_at ASC, ref_id ASC
            `,
            dateParams
        );

        let preRangeDebit = 0;
        let preRangeCredit = 0;
        if (fromDate) {
            const [openingRows] = await db.query(
                `
                SELECT
                    COALESCE(SUM(debit_amount), 0) AS debit_total,
                    COALESCE(SUM(credit_amount), 0) AS credit_total
                FROM (
                    SELECT s.total_amount AS debit_amount, 0 AS credit_amount
                    FROM sales_invoices s
                    WHERE s.party_id = ?
                      AND s.invoice_no LIKE 'SINV-%'
                      AND s.status IN ('confirmed', 'partially_paid', 'paid')
                      AND s.invoice_date < ?

                    UNION ALL

                    SELECT 0 AS debit_amount, s.total_amount AS credit_amount
                    FROM sales_invoices s
                    WHERE s.party_id = ?
                      AND s.invoice_no LIKE 'CN-%'
                      AND s.status IN ('confirmed', 'partially_paid', 'paid')
                      AND s.invoice_date < ?

                    UNION ALL

                    SELECT 0 AS debit_amount, b.total_amount AS credit_amount
                    FROM purchase_invoices b
                    WHERE b.party_id = ?
                      AND b.bill_no LIKE 'PINV-%'
                      AND b.status IN ('confirmed', 'partially_paid', 'paid')
                      AND b.bill_date < ?

                    UNION ALL

                    SELECT b.total_amount AS debit_amount, 0 AS credit_amount
                    FROM purchase_invoices b
                    WHERE b.party_id = ?
                      AND b.bill_no LIKE 'DN-%'
                      AND b.status IN ('confirmed', 'partially_paid', 'paid')
                      AND b.bill_date < ?

                    UNION ALL

                    SELECT 0 AS debit_amount, pi.amount AS credit_amount
                    FROM payment_in pi
                    WHERE pi.party_id = ?
                      AND pi.payment_date < ?

                    UNION ALL

                    SELECT po.amount AS debit_amount, 0 AS credit_amount
                    FROM payment_out po
                    WHERE po.party_id = ?
                      AND po.payment_date < ?
                ) pre_range
                `,
                [partyId, String(fromDate), partyId, String(fromDate), partyId, String(fromDate), partyId, String(fromDate), partyId, String(fromDate), partyId, String(fromDate)]
            );
            preRangeDebit = Number(openingRows[0]?.debit_total || 0);
            preRangeCredit = Number(openingRows[0]?.credit_total || 0);
        }

        const openingSignedAtRange = round2(openingSigned + (preRangeDebit - preRangeCredit));
        let runningSigned = openingSignedAtRange;

        const entries = rows.map((row) => {
            const debit = round2(Number(row.debit_amount || 0));
            const credit = round2(Number(row.credit_amount || 0));
            runningSigned = round2(runningSigned + debit - credit);

            return {
                ...row,
                debit_amount: debit,
                credit_amount: credit,
                running_balance: Math.abs(runningSigned),
                running_nature: runningSigned >= 0 ? 'receivable' : 'payable',
            };
        });

        const totals = entries.reduce(
            (acc, row) => {
                acc.total_debit = round2(acc.total_debit + Number(row.debit_amount || 0));
                acc.total_credit = round2(acc.total_credit + Number(row.credit_amount || 0));
                return acc;
            },
            { total_debit: 0, total_credit: 0 }
        );

        const closingSigned = entries.length ? runningSigned : openingSignedAtRange;

        return res.json({
            summary: {
                from_date: fromDate || null,
                to_date: toDate || null,
                party: {
                    id: party.id,
                    name: party.name,
                    party_type: party.party_type,
                },
                opening_balance: round2(Math.abs(openingSignedAtRange)),
                opening_nature: openingSignedAtRange >= 0 ? 'receivable' : 'payable',
                total_debit: totals.total_debit,
                total_credit: totals.total_credit,
                closing_balance: round2(Math.abs(closingSigned)),
                closing_nature: closingSigned >= 0 ? 'receivable' : 'payable',
                entry_count: entries.length,
            },
            entries,
        });
    } catch (err) {
        console.error('Party ledger report error:', err);
        return res.status(500).json({ error: 'Failed to fetch party ledger report' });
    }
});

router.get('/day-book', async (req, res) => {
    const { from_date: fromDate, to_date: toDate, txn_type: txnType } = req.query;
    const allowedTypes = new Set(['sale', 'purchase', 'payment_in', 'payment_out', 'credit_note', 'debit_note']);
    const hasTypeFilter = txnType && allowedTypes.has(String(txnType));

    const filters = [];
    const params = [];

    if (fromDate) {
        filters.push('txn_date >= ?');
        params.push(String(fromDate));
    }
    if (toDate) {
        filters.push('txn_date <= ?');
        params.push(String(toDate));
    }
    if (hasTypeFilter) {
        filters.push('txn_type = ?');
        params.push(String(txnType));
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT * FROM (
                SELECT
                    'sale' AS txn_type,
                    s.id AS ref_id,
                    s.invoice_no AS ref_no,
                    s.invoice_date AS txn_date,
                    p.name AS party_name,
                    s.total_amount AS amount_in,
                    0 AS amount_out,
                    'Sales Invoice' AS source,
                    s.created_at
                FROM sales_invoices s
                JOIN parties p ON p.id = s.party_id
                WHERE s.invoice_no LIKE 'SINV-%'
                  AND s.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'credit_note' AS txn_type,
                    s.id AS ref_id,
                    s.invoice_no AS ref_no,
                    s.invoice_date AS txn_date,
                    p.name AS party_name,
                    0 AS amount_in,
                    s.total_amount AS amount_out,
                    'Credit Note' AS source,
                    s.created_at
                FROM sales_invoices s
                JOIN parties p ON p.id = s.party_id
                WHERE s.invoice_no LIKE 'CN-%'
                  AND s.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'purchase' AS txn_type,
                    b.id AS ref_id,
                    b.bill_no AS ref_no,
                    b.bill_date AS txn_date,
                    p.name AS party_name,
                    0 AS amount_in,
                    b.total_amount AS amount_out,
                    'Purchase Bill' AS source,
                    b.created_at
                FROM purchase_invoices b
                JOIN parties p ON p.id = b.party_id
                WHERE b.bill_no LIKE 'PINV-%'
                  AND b.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'debit_note' AS txn_type,
                    b.id AS ref_id,
                    b.bill_no AS ref_no,
                    b.bill_date AS txn_date,
                    p.name AS party_name,
                    b.total_amount AS amount_in,
                    0 AS amount_out,
                    'Debit Note' AS source,
                    b.created_at
                FROM purchase_invoices b
                JOIN parties p ON p.id = b.party_id
                WHERE b.bill_no LIKE 'DN-%'
                  AND b.status IN ('confirmed', 'partially_paid', 'paid')

                UNION ALL

                SELECT
                    'payment_in' AS txn_type,
                    pi.id AS ref_id,
                    pi.receipt_no AS ref_no,
                    pi.payment_date AS txn_date,
                    p.name AS party_name,
                    pi.amount AS amount_in,
                    0 AS amount_out,
                    'Payment In' AS source,
                    pi.created_at
                FROM payment_in pi
                JOIN parties p ON p.id = pi.party_id

                UNION ALL

                SELECT
                    'payment_out' AS txn_type,
                    po.id AS ref_id,
                    po.payment_no AS ref_no,
                    po.payment_date AS txn_date,
                    p.name AS party_name,
                    0 AS amount_in,
                    po.amount AS amount_out,
                    'Payment Out' AS source,
                    po.created_at
                FROM payment_out po
                JOIN parties p ON p.id = po.party_id
            ) daybook
            ${whereSql}
            ORDER BY txn_date DESC, created_at DESC, ref_id DESC
            `,
            params
        );

        const entries = rows.map((row) => ({
            ...row,
            amount_in: round2(Number(row.amount_in || 0)),
            amount_out: round2(Number(row.amount_out || 0)),
            net_amount: round2(Number(row.amount_in || 0) - Number(row.amount_out || 0)),
        }));

        const summary = entries.reduce(
            (acc, row) => {
                acc.total_in = round2(acc.total_in + Number(row.amount_in || 0));
                acc.total_out = round2(acc.total_out + Number(row.amount_out || 0));
                return acc;
            },
            {
                from_date: fromDate || null,
                to_date: toDate || null,
                txn_type: hasTypeFilter ? String(txnType) : null,
                total_in: 0,
                total_out: 0,
            }
        );
        summary.net_flow = round2(summary.total_in - summary.total_out);
        summary.entry_count = entries.length;

        return res.json({ summary, entries });
    } catch (err) {
        console.error('Day book report error:', err);
        return res.status(500).json({ error: 'Failed to fetch day book report' });
    }
});

export default router;
