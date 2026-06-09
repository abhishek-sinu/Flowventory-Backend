/**
 * One-time stock reconciliation script.
 *
 * Background: before the stock fix, confirmed sales did not reduce stock and
 * confirmed purchases did not add stock. This script recomputes each item's
 * `current_stock` from a clean baseline so existing records become correct.
 *
 * Formula:
 *   expected = opening_stock
 *            + SUM(confirmed real purchase quantities)      [purchase_invoices, NOT debit notes]
 *            - SUM(confirmed debit note quantities)          [purchase_invoices LIKE 'DN-%'] (purchase return)
 *            - SUM(confirmed real sales quantities)          [sales_invoices SINV-, not CN/EST/DC]
 *            + SUM(confirmed credit note quantities)         [sales_invoices LIKE 'CN-%'] (sales return)
 *            + SUM(manual stock adjustments from audit_logs)
 *
 * Note: sales_invoices also stores estimates (EST-) and delivery challans (DC-),
 * which must NOT affect stock. They are excluded below.
 *
 * "Confirmed" means any invoice/bill whose status is not 'draft' and not 'cancelled'.
 *
 * Usage (run from the "Flowventory Backend" folder):
 *   node scripts/reconcileStock.js          # dry run: shows differences only
 *   node scripts/reconcileStock.js --apply  # actually updates items.current_stock
 */

import db from '../db.js';

const APPLY = process.argv.includes('--apply');

function round3(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

async function main() {
    const [items] = await db.query(
        'SELECT id, name, sku, opening_stock, current_stock FROM items ORDER BY id ASC'
    );

    // Confirmed real sales (exclude credit notes, estimates, delivery challans) -> subtract.
    const [salesAgg] = await db.query(
        `SELECT sii.item_id AS item_id, SUM(sii.quantity) AS qty
         FROM sales_invoice_items sii
         JOIN sales_invoices s ON s.id = sii.sales_invoice_id
         WHERE s.status NOT IN ('draft', 'cancelled')
           AND s.invoice_no NOT LIKE 'CN-%'
           AND s.invoice_no NOT LIKE 'EST-%'
           AND s.invoice_no NOT LIKE 'DC-%'
         GROUP BY sii.item_id`
    );

    // Confirmed credit notes (sales returns) -> add back.
    const [creditAgg] = await db.query(
        `SELECT sii.item_id AS item_id, SUM(sii.quantity) AS qty
         FROM sales_invoice_items sii
         JOIN sales_invoices s ON s.id = sii.sales_invoice_id
         WHERE s.status NOT IN ('draft', 'cancelled')
           AND s.invoice_no LIKE 'CN-%'
         GROUP BY sii.item_id`
    );

    // Confirmed real purchases (exclude debit notes) -> add.
    const [purchaseAgg] = await db.query(
        `SELECT pii.item_id AS item_id, SUM(pii.quantity) AS qty
         FROM purchase_invoice_items pii
         JOIN purchase_invoices piv ON piv.id = pii.purchase_invoice_id
         WHERE piv.status NOT IN ('draft', 'cancelled')
           AND piv.bill_no NOT LIKE 'DN-%'
         GROUP BY pii.item_id`
    );

    // Confirmed debit notes (purchase returns) -> subtract.
    const [debitAgg] = await db.query(
        `SELECT pii.item_id AS item_id, SUM(pii.quantity) AS qty
         FROM purchase_invoice_items pii
         JOIN purchase_invoices piv ON piv.id = pii.purchase_invoice_id
         WHERE piv.status NOT IN ('draft', 'cancelled')
           AND piv.bill_no LIKE 'DN-%'
         GROUP BY pii.item_id`
    );

    // Manual stock adjustments recorded in audit_logs.
    const [adjustLogs] = await db.query(
        "SELECT details FROM audit_logs WHERE action = 'adjust_stock'"
    );

    const salesByItem = new Map(salesAgg.map((r) => [Number(r.item_id), Number(r.qty || 0)]));
    const creditByItem = new Map(creditAgg.map((r) => [Number(r.item_id), Number(r.qty || 0)]));
    const purchaseByItem = new Map(purchaseAgg.map((r) => [Number(r.item_id), Number(r.qty || 0)]));
    const debitByItem = new Map(debitAgg.map((r) => [Number(r.item_id), Number(r.qty || 0)]));

    const adjustByItem = new Map();
    for (const row of adjustLogs) {
        let parsed;
        try {
            parsed = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
        } catch (_) {
            continue;
        }
        if (!parsed || parsed.item_id == null) continue;
        const id = Number(parsed.item_id);
        const qty = Number(parsed.quantity || 0);
        const delta = String(parsed.direction).toLowerCase() === 'out' ? -qty : qty;
        adjustByItem.set(id, (adjustByItem.get(id) || 0) + delta);
    }

    const changes = [];
    for (const item of items) {
        const id = Number(item.id);
        const opening = Number(item.opening_stock || 0);
        const purchased = purchaseByItem.get(id) || 0;
        const debited = debitByItem.get(id) || 0;
        const sold = salesByItem.get(id) || 0;
        const credited = creditByItem.get(id) || 0;
        const adjusted = adjustByItem.get(id) || 0;

        const expected = round3(opening + purchased - debited - sold + credited + adjusted);
        const actual = Number(item.current_stock || 0);

        changes.push({
            id,
            name: item.name,
            sku: item.sku,
            opening,
            purchased,
            sold,
            adjusted,
            expected,
            actual,
            diff: round3(expected - actual),
        });
    }

    console.log(`\nStock reconciliation (${APPLY ? 'APPLY' : 'DRY RUN'})`);
    console.log('='.repeat(110));
    console.log(
        ['ID', 'SKU', 'NAME', 'OPEN', '+PUR', '-SALE', '+ADJ', 'EXPECTED', 'CURRENT', 'DIFF']
            .map((h, i) => (i < 2 ? h.padEnd(10) : h.padStart(10)))
            .join('')
    );
    console.log('-'.repeat(110));

    let mismatches = 0;
    for (const c of changes) {
        if (c.diff !== 0) mismatches += 1;
        console.log(
            String(c.id).padEnd(10) +
                String(c.sku || '').slice(0, 9).padEnd(10) +
                String(c.name || '').slice(0, 9).padStart(10) +
                String(c.opening).padStart(10) +
                String(c.purchased).padStart(10) +
                String(c.sold).padStart(10) +
                String(c.adjusted).padStart(10) +
                String(c.expected).padStart(10) +
                String(c.actual).padStart(10) +
                String(c.diff).padStart(10)
        );
    }

    console.log('-'.repeat(110));
    console.log(`Items checked: ${changes.length} | Mismatches: ${mismatches}`);

    if (!APPLY) {
        console.log('\nDry run only. Re-run with --apply to write the EXPECTED values to items.current_stock.\n');
        return;
    }

    if (mismatches === 0) {
        console.log('\nNothing to update. Stock already matches.\n');
        return;
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        for (const c of changes) {
            if (c.diff === 0) continue;
            await conn.query('UPDATE items SET current_stock = ? WHERE id = ?', [c.expected, c.id]);
        }
        await conn.commit();
        console.log(`\nUpdated ${mismatches} item(s). Stock reconciled.\n`);
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Reconciliation failed:', err);
        process.exit(1);
    });
