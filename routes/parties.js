import express from 'express';
import db from '../db.js';
import multer from 'multer';
import XLSX from 'xlsx';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const PARTY_TYPES = new Set(['customer', 'supplier', 'both']);
const BALANCE_NATURES = new Set(['receivable', 'payable']);

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const txt = String(value).trim();
    return txt.length ? txt : null;
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolInt(value, fallback = 1) {
    if (value === undefined || value === null) return fallback;
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return fallback;
}

function buildPartyPayload(body) {
    const party_type = normalizeText(body.party_type) || 'customer';
    const balance_nature = normalizeText(body.balance_nature) || 'receivable';

    const payload = {
        party_type: PARTY_TYPES.has(party_type) ? party_type : party_type,
        name: normalizeText(body.name),
        phone: normalizeText(body.phone),
        email: normalizeText(body.email),
        gstin: normalizeText(body.gstin),
        pan: normalizeText(body.pan),
        billing_address: normalizeText(body.billing_address),
        shipping_address: normalizeText(body.shipping_address),
        city: normalizeText(body.city),
        state: normalizeText(body.state),
        pincode: normalizeText(body.pincode),
        opening_balance: toNumber(body.opening_balance, 0),
        balance_nature: BALANCE_NATURES.has(balance_nature) ? balance_nature : balance_nature,
        current_balance: toNumber(body.current_balance, 0),
        is_active: toBoolInt(body.is_active, 1),
    };

    const errors = [];
    if (!payload.name) errors.push('name is required');
    if (!PARTY_TYPES.has(payload.party_type)) errors.push('party_type must be customer, supplier, or both');
    if (!BALANCE_NATURES.has(payload.balance_nature)) errors.push('balance_nature must be receivable or payable');
    if (payload.opening_balance < 0) errors.push('opening_balance cannot be negative');
    if (payload.current_balance < 0) errors.push('current_balance cannot be negative');

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
                party_type: 'customer',
                name: 'ABC Traders',
                phone: '9876543210',
                email: 'abc@example.com',
                gstin: '27ABCDE1234F1Z5',
                pan: 'ABCDE1234F',
                billing_address: '12 Market Road',
                shipping_address: '12 Market Road',
                city: 'Mumbai',
                state: 'Maharashtra',
                pincode: '400001',
                opening_balance: 0,
                balance_nature: 'receivable',
                current_balance: 0,
                is_active: 1,
            },
        ];

        const ws = XLSX.utils.json_to_sheet(templateRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'parties_template');

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="parties_import_template.xlsx"');
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buffer);
    } catch (err) {
        console.error('Parties template error:', err);
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
        console.error('Parties import read error:', err);
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
            party_type: pickValue(row, ['party_type', 'party type', 'Party Type']),
            name: pickValue(row, ['name', 'Name']),
            phone: pickValue(row, ['phone', 'Phone']),
            email: pickValue(row, ['email', 'Email']),
            gstin: pickValue(row, ['gstin', 'GSTIN', 'gst']),
            pan: pickValue(row, ['pan', 'PAN']),
            billing_address: pickValue(row, ['billing_address', 'billing address', 'Billing Address']),
            shipping_address: pickValue(row, ['shipping_address', 'shipping address', 'Shipping Address']),
            city: pickValue(row, ['city', 'City']),
            state: pickValue(row, ['state', 'State']),
            pincode: pickValue(row, ['pincode', 'Pincode', 'pin']),
            opening_balance: pickValue(row, ['opening_balance', 'opening balance', 'Opening Balance']),
            balance_nature: pickValue(row, ['balance_nature', 'balance nature', 'Balance Nature']),
            current_balance: pickValue(row, ['current_balance', 'current balance', 'Current Balance']),
            is_active: pickValue(row, ['is_active', 'active', 'Active']),
        };

        const { payload, errors } = buildPartyPayload(normalizedRow);
        if (errors.length) {
            failed.push({
                row: rowNumber,
                name: normalizedRow.name ? String(normalizedRow.name) : null,
                gstin: normalizedRow.gstin ? String(normalizedRow.gstin) : null,
                reason: errors.join(', '),
            });
            continue;
        }

        try {
            const gstin = payload.gstin;
            let existing = [];

            if (gstin) {
                const [rows] = await db.query('SELECT id FROM parties WHERE gstin = ? LIMIT 1', [gstin]);
                existing = rows;
            }

            if (existing.length) {
                await db.query('UPDATE parties SET ? WHERE id = ?', [payload, existing[0].id]);
                updated += 1;
            } else {
                await db.query('INSERT INTO parties SET ?', payload);
                created += 1;
            }
        } catch (err) {
            failed.push({
                row: rowNumber,
                name: payload.name ? String(payload.name) : null,
                gstin: payload.gstin ? String(payload.gstin) : null,
                reason: err?.code || 'database error',
            });
        }
    }

    if (req.user?.id) {
        try {
            await db.query('INSERT INTO audit_logs SET ?', {
                user_id: req.user.id,
                action: 'import_parties_xls',
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
    const { q, type, active } = req.query;
    const conditions = [];
    const params = [];

    if (q) {
        conditions.push('(name LIKE ? OR phone LIKE ? OR gstin LIKE ?)');
        const pattern = `%${q}%`;
        params.push(pattern, pattern, pattern);
    }

    if (type && PARTY_TYPES.has(String(type))) {
        conditions.push('party_type = ?');
        params.push(String(type));
    }

    if (active === '1' || active === '0') {
        conditions.push('is_active = ?');
        params.push(Number(active));
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                id,
                party_type,
                name,
                phone,
                email,
                gstin,
                city,
                state,
                opening_balance,
                balance_nature,
                current_balance,
                is_active,
                created_at,
                updated_at
            FROM parties
            ${whereSql}
            ORDER BY updated_at DESC, id DESC
            `,
            params
        );
        return res.json(rows);
    } catch (err) {
        console.error('Parties list error:', err);
        return res.status(500).json({ error: 'Failed to fetch parties' });
    }
});

router.post('/', async (req, res) => {
    const { payload, errors } = buildPartyPayload(req.body);
    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    try {
        const [result] = await db.query('INSERT INTO parties SET ?', payload);

        if (req.user?.id) {
            try {
                await db.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'create_party',
                    details: JSON.stringify({ party_id: result.insertId, name: payload.name }),
                });
            } catch (_) {}
        }

        const [rows] = await db.query('SELECT * FROM parties WHERE id = ?', [result.insertId]);
        return res.status(201).json({ success: true, party: rows[0] });
    } catch (err) {
        console.error('Parties create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'GSTIN already exists' });
        }
        return res.status(500).json({ error: 'Failed to create party' });
    }
});

router.put('/:id', async (req, res) => {
    const { payload, errors } = buildPartyPayload(req.body);
    if (errors.length) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    try {
        const [result] = await db.query('UPDATE parties SET ? WHERE id = ?', [payload, req.params.id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Party not found' });
        }

        if (req.user?.id) {
            try {
                await db.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'update_party',
                    details: JSON.stringify({ party_id: Number(req.params.id), name: payload.name }),
                });
            } catch (_) {}
        }

        const [rows] = await db.query('SELECT * FROM parties WHERE id = ?', [req.params.id]);
        return res.json({ success: true, party: rows[0] });
    } catch (err) {
        console.error('Parties update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'GSTIN already exists' });
        }
        return res.status(500).json({ error: 'Failed to update party' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const [existing] = await db.query('SELECT id, name FROM parties WHERE id = ?', [req.params.id]);
        if (!existing.length) {
            return res.status(404).json({ error: 'Party not found' });
        }

        const [result] = await db.query('DELETE FROM parties WHERE id = ?', [req.params.id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Party not found' });
        }

        if (req.user?.id) {
            try {
                await db.query('INSERT INTO audit_logs SET ?', {
                    user_id: req.user.id,
                    action: 'delete_party',
                    details: JSON.stringify({ party_id: Number(req.params.id), name: existing[0].name }),
                });
            } catch (_) {}
        }

        return res.json({ success: true, message: 'Party deleted' });
    } catch (err) {
        console.error('Parties delete error:', err);
        return res.status(500).json({ error: 'Failed to delete party' });
    }
});

export default router;
