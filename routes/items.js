import express from 'express';
import db from '../db.js';
import multer from 'multer';
import XLSX from 'xlsx';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const SORT_COLUMN_MAP = {
    name: 'name',
    sku: 'sku',
    category: 'category',
    sale_price: 'sale_price',
    purchase_price: 'purchase_price',
    current_stock: 'current_stock',
    gst_percent: 'gst_percent',
    created_at: 'created_at',
    updated_at: 'updated_at',
};

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const txt = String(value).trim();
    return txt.length ? txt : null;
}

function toBoolInt(value, fallback = 1) {
    if (value === undefined || value === null) return fallback;
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return fallback;
}

function validateItemPayload(payload, { isUpdate = false } = {}) {
    const errors = [];
    if (!payload.name) errors.push('name is required');
    if (!payload.sku) errors.push('sku is required');

    if (payload.sale_price < 0) errors.push('sale_price cannot be negative');
    if (payload.purchase_price < 0) errors.push('purchase_price cannot be negative');
    if (payload.gst_percent < 0 || payload.gst_percent > 100) errors.push('gst_percent must be between 0 and 100');
    if (payload.opening_stock < 0) errors.push('opening_stock cannot be negative');
    if (payload.current_stock < 0) errors.push('current_stock cannot be negative');
    if (payload.low_stock_threshold < 0) errors.push('low_stock_threshold cannot be negative');

    if (!isUpdate && payload.current_stock === undefined) {
        payload.current_stock = payload.opening_stock;
    }

    return errors;
}

function buildItemPayload(body, { isUpdate = false } = {}) {
    const payload = {
        name: normalizeText(body.name),
        sku: normalizeText(body.sku),
        category: normalizeText(body.category),
        unit: normalizeText(body.unit) || 'pcs',
        hsn_code: normalizeText(body.hsn_code),
        sale_price: toNumber(body.sale_price, 0),
        purchase_price: toNumber(body.purchase_price, 0),
        gst_percent: toNumber(body.gst_percent, 0),
        opening_stock: toNumber(body.opening_stock, 0),
        current_stock: body.current_stock === undefined && !isUpdate
            ? undefined
            : toNumber(body.current_stock, 0),
        low_stock_threshold: toNumber(body.low_stock_threshold, 0),
        is_active: toBoolInt(body.is_active, 1),
    };

    const errors = validateItemPayload(payload, { isUpdate });
    return { payload, errors };
}

function pickValue(row, keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
            return row[key];
        }
    }
    return undefined;
}

router.get('/template', async (_req, res) => {
    try {
        const templateRows = [
            {
                name: 'Parle-G 100g',
                sku: 'FMCG-PARLE-100G',
                category: 'Biscuits',
                unit: 'pcs',
                hsn_code: '1905',
                sale_price: 25,
                purchase_price: 20,
                gst_percent: 18,
                opening_stock: 100,
                current_stock: 95,
                low_stock_threshold: 20,
                is_active: 1,
            },
        ];

        const ws = XLSX.utils.json_to_sheet(templateRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'items_template');

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="items_import_template.xlsx"');
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buffer);
    } catch (err) {
        console.error('Items template error:', err);
        return res.status(500).json({ error: 'Failed to generate template' });
    }
});

router.post('/import', upload.single('file'), async (req, res) => {
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Please upload an .xls or .xlsx file' });
    }

    const originalName = String(req.file.originalname || '').toLowerCase();
    if (!originalName.endsWith('.xls') && !originalName.endsWith('.xlsx')) {
        return res.status(400).json({ error: 'Only .xls or .xlsx files are supported' });
    }

    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (err) {
        console.error('Items import read error:', err);
        return res.status(400).json({ error: 'Invalid excel file format' });
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        return res.status(400).json({ error: 'Excel file has no sheets' });
    }

    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rawRows.length) {
        return res.status(400).json({ error: 'Excel file has no data rows' });
    }

    let created = 0;
    let updated = 0;
    const failed = [];

    for (let index = 0; index < rawRows.length; index += 1) {
        const rowNumber = index + 2;
        const row = rawRows[index];

        const normalizedRow = {
            name: pickValue(row, ['name', 'item_name', 'item name', 'Item Name']),
            sku: pickValue(row, ['sku', 'SKU']),
            category: pickValue(row, ['category', 'Category']),
            unit: pickValue(row, ['unit', 'Unit']),
            hsn_code: pickValue(row, ['hsn_code', 'hsn', 'HSN', 'HSN Code', 'hsn code']),
            sale_price: pickValue(row, ['sale_price', 'sale price', 'Sale Price']),
            purchase_price: pickValue(row, ['purchase_price', 'purchase price', 'Purchase Price']),
            gst_percent: pickValue(row, ['gst_percent', 'gst %', 'GST %']),
            opening_stock: pickValue(row, ['opening_stock', 'opening stock', 'Opening Stock']),
            current_stock: pickValue(row, ['current_stock', 'current stock', 'Current Stock']),
            low_stock_threshold: pickValue(row, ['low_stock_threshold', 'low stock threshold', 'Low Stock Threshold']),
            is_active: pickValue(row, ['is_active', 'active', 'Active']),
        };

        const { payload, errors } = buildItemPayload(normalizedRow, { isUpdate: false });
        if (errors.length) {
            failed.push({
                row: rowNumber,
                name: normalizedRow.name ? String(normalizedRow.name) : null,
                sku: normalizedRow.sku ? String(normalizedRow.sku) : null,
                reason: errors.join(', '),
            });
            continue;
        }

        try {
            const [existing] = await db.query('SELECT id FROM items WHERE sku = ? LIMIT 1', [payload.sku]);
            if (existing.length) {
                await db.query('UPDATE items SET ? WHERE id = ?', [payload, existing[0].id]);
                updated += 1;
            } else {
                await db.query('INSERT INTO items SET ?', payload);
                created += 1;
            }
        } catch (err) {
            failed.push({
                row: rowNumber,
                name: payload.name ? String(payload.name) : null,
                sku: payload.sku ? String(payload.sku) : null,
                reason: err?.code || 'database error',
            });
        }
    }

    if (req.user?.id) {
        try {
            await db.query('INSERT INTO audit_logs SET ?', {
                user_id: req.user.id,
                action: 'import_items_xls',
                details: JSON.stringify({ created, updated, failed_count: failed.length }),
            });
        } catch (_) {}
    }

    return res.json({
        success: true,
        summary: {
            totalRows: rawRows.length,
            created,
            updated,
            failedCount: failed.length,
            failed,
        },
    });
});

router.get('/', async (req, res) => {
    const { q, category, lowStock, active } = req.query;
    const page = Math.max(1, toNumber(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toNumber(req.query.limit, 20)));
    const offset = (page - 1) * limit;
    const sortBy = String(req.query.sortBy || 'updated_at');
    const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortColumn = SORT_COLUMN_MAP[sortBy] || 'updated_at';

    const conditions = [];
    const params = [];

    if (q) {
        conditions.push('(name LIKE ? OR sku LIKE ?)');
        const pattern = `%${q}%`;
        params.push(pattern, pattern);
    }

    if (category) {
        conditions.push('category = ?');
        params.push(category);
    }

    if (active === '1' || active === '0') {
        conditions.push('is_active = ?');
        params.push(Number(active));
    }

    if (lowStock === '1') {
        conditions.push('current_stock <= low_stock_threshold');
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total FROM items ${whereSql}`,
            params
        );
        const total = Number(countRows[0]?.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / limit));

        const [rows] = await db.query(
            `
            SELECT
                id,
                name,
                sku,
                category,
                unit,
                hsn_code,
                sale_price,
                purchase_price,
                gst_percent,
                opening_stock,
                current_stock,
                low_stock_threshold,
                is_active,
                created_at,
                updated_at
            FROM items
            ${whereSql}
            ORDER BY ${sortColumn} ${sortDir}, id DESC
            LIMIT ? OFFSET ?
            `,
            [...params, limit, offset]
        );
        res.json({
            data: rows,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                sortBy,
                sortDir: sortDir.toLowerCase(),
            },
        });
    } catch (err) {
        console.error('Items list error:', err);
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
        if (!rows.length) {
            return res.status(404).json({ error: 'Item not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Items get by id error:', err);
        res.status(500).json({ error: 'Failed to fetch item' });
    }
});

router.post('/', async (req, res) => {
    const { payload, errors } = buildItemPayload(req.body, { isUpdate: false });
    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    try {
        const [result] = await db.query('INSERT INTO items SET ?', payload);
        if (req.user?.id) {
            try {
                await db.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'create_item',
                    details: JSON.stringify({ item_id: result.insertId, sku: payload.sku }),
                });
            } catch (_) {}
        }
        const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [result.insertId]);
        res.status(201).json({ success: true, item: rows[0] });
    } catch (err) {
        console.error('Items create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'SKU already exists' });
        }
        res.status(500).json({ error: 'Failed to create item' });
    }
});

router.put('/:id', async (req, res) => {
    const { payload, errors } = buildItemPayload(req.body, { isUpdate: true });
    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    try {
        const [updateResult] = await db.query('UPDATE items SET ? WHERE id = ?', [payload, req.params.id]);
        if (!updateResult.affectedRows) {
            return res.status(404).json({ error: 'Item not found' });
        }

        if (req.user?.id) {
            try {
                await db.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'update_item',
                    details: JSON.stringify({ item_id: Number(req.params.id), sku: payload.sku }),
                });
            } catch (_) {}
        }

        const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
        res.json({ success: true, item: rows[0] });
    } catch (err) {
        console.error('Items update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'SKU already exists' });
        }
        res.status(500).json({ error: 'Failed to update item' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const [existing] = await db.query('SELECT id, name, sku FROM items WHERE id = ?', [req.params.id]);
        if (!existing.length) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const [result] = await db.query('DELETE FROM items WHERE id = ?', [req.params.id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Item not found' });
        }

        if (req.user?.id) {
            try {
                await db.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'delete_item',
                    details: JSON.stringify({ item_id: Number(req.params.id), sku: existing[0].sku }),
                });
            } catch (_) {}
        }

        res.json({ success: true, message: 'Item deleted' });
    } catch (err) {
        console.error('Items delete error:', err);
        res.status(500).json({ error: 'Failed to delete item' });
    }
});

router.post('/:id/adjust-stock', async (req, res) => {
    const direction = String(req.body.direction || '').toLowerCase();
    const quantity = toNumber(req.body.quantity, NaN);
    const reason = normalizeText(req.body.reason) || 'manual_adjustment';

    if (!['in', 'out'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be in or out' });
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive number' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query('SELECT id, name, sku, current_stock FROM items WHERE id = ? FOR UPDATE', [req.params.id]);
        if (!rows.length) {
            await conn.rollback();
            return res.status(404).json({ error: 'Item not found' });
        }

        const item = rows[0];
        const current = Number(item.current_stock || 0);
        const delta = direction === 'in' ? quantity : -quantity;
        const nextStock = current + delta;

        if (nextStock < 0) {
            await conn.rollback();
            return res.status(400).json({ error: 'Insufficient stock for this adjustment' });
        }

        await conn.query('UPDATE items SET current_stock = ? WHERE id = ?', [nextStock, req.params.id]);

        if (req.user?.id) {
            try {
                await conn.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'adjust_stock',
                    details: JSON.stringify({
                        item_id: Number(req.params.id),
                        sku: item.sku,
                        direction,
                        quantity,
                        previous_stock: current,
                        new_stock: nextStock,
                        reason,
                    }),
                });
            } catch (_) {}
        }

        await conn.commit();
        const [updated] = await conn.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
        return res.json({ success: true, item: updated[0] });
    } catch (err) {
        await conn.rollback();
        console.error('Items adjust stock error:', err);
        return res.status(500).json({ error: 'Failed to adjust stock' });
    } finally {
        conn.release();
    }
});

export default router;
