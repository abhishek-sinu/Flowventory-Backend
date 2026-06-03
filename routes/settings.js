import express from 'express';
import db from '../db.js';

const router = express.Router();

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text.length ? text : null;
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

router.get('/company-profile', async (_req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT
                id,
                company_name,
                legal_name,
                gstin,
                pan,
                email,
                phone,
                address,
                city,
                state,
                pincode,
                logo_url,
                is_default,
                created_at,
                updated_at
            FROM company_profiles
            ORDER BY is_default DESC, id ASC
            LIMIT 1
            `
        );

        if (!rows.length) {
            return res.json({
                id: null,
                company_name: '',
                legal_name: '',
                gstin: '',
                pan: '',
                email: '',
                phone: '',
                address: '',
                city: '',
                state: '',
                pincode: '',
                logo_url: '',
                is_default: 1,
            });
        }

        return res.json(rows[0]);
    } catch (err) {
        console.error('Company profile get error:', err);
        return res.status(500).json({ error: 'Failed to fetch company profile' });
    }
});

router.put('/company-profile', async (req, res) => {
    const payload = {
        company_name: normalizeText(req.body.company_name),
        legal_name: normalizeText(req.body.legal_name),
        gstin: normalizeText(req.body.gstin),
        pan: normalizeText(req.body.pan),
        email: normalizeText(req.body.email),
        phone: normalizeText(req.body.phone),
        address: normalizeText(req.body.address),
        city: normalizeText(req.body.city),
        state: normalizeText(req.body.state),
        pincode: normalizeText(req.body.pincode),
        logo_url: normalizeText(req.body.logo_url),
        is_default: 1,
    };

    if (!payload.company_name) {
        return res.status(400).json({ error: 'company_name is required' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [existingRows] = await conn.query(
            'SELECT id FROM company_profiles ORDER BY is_default DESC, id ASC LIMIT 1 FOR UPDATE'
        );

        let activeCompanyId;
        if (existingRows.length) {
            await conn.query('UPDATE company_profiles SET ? WHERE id = ?', [payload, existingRows[0].id]);
            activeCompanyId = existingRows[0].id;
        } else {
            const [insertResult] = await conn.query('INSERT INTO company_profiles SET ?', payload);
            activeCompanyId = insertResult.insertId;
        }

        await conn.query('UPDATE company_profiles SET is_default = 0 WHERE id <> ?', [activeCompanyId]);
        await conn.query('UPDATE company_profiles SET is_default = 1 WHERE id = ?', [activeCompanyId]);

        const [rows] = await conn.query(
            `
            SELECT
                id,
                company_name,
                legal_name,
                gstin,
                pan,
                email,
                phone,
                address,
                city,
                state,
                pincode,
                logo_url,
                is_default,
                created_at,
                updated_at
            FROM company_profiles
            ORDER BY is_default DESC, id ASC
            LIMIT 1
            `
        );

        await conn.commit();
        return res.json(rows[0]);
    } catch (err) {
        await conn.rollback();
        console.error('Company profile save error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Duplicate GSTIN already exists' });
        }
        return res.status(500).json({ error: 'Failed to save company profile' });
    } finally {
        conn.release();
    }
});

router.get('/tax-rates', async (req, res) => {
    const { q, active } = req.query;
    const filters = [];
    const params = [];

    if (q) {
        const pattern = `%${String(q).trim()}%`;
        filters.push('(name LIKE ? OR tax_type LIKE ?)');
        params.push(pattern, pattern);
    }

    if (active === '0' || active === '1') {
        filters.push('is_active = ?');
        params.push(Number(active));
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT id, name, rate_percent, tax_type, is_active, created_at, updated_at
            FROM tax_rates
            ${whereSql}
            ORDER BY rate_percent ASC, name ASC
            `,
            params
        );

        return res.json(rows);
    } catch (err) {
        console.error('Tax rates list error:', err);
        return res.status(500).json({ error: 'Failed to fetch tax rates' });
    }
});

router.post('/tax-rates', async (req, res) => {
    const payload = {
        name: normalizeText(req.body.name),
        rate_percent: toNumber(req.body.rate_percent, NaN),
        tax_type: normalizeText(req.body.tax_type) || 'gst',
        is_active: toBoolInt(req.body.is_active, 1),
    };

    if (!payload.name) {
        return res.status(400).json({ error: 'name is required' });
    }
    if (!Number.isFinite(payload.rate_percent) || payload.rate_percent < 0 || payload.rate_percent > 100) {
        return res.status(400).json({ error: 'rate_percent must be between 0 and 100' });
    }
    if (!['gst', 'igst', 'cess', 'other'].includes(payload.tax_type)) {
        return res.status(400).json({ error: 'tax_type must be gst, igst, cess, or other' });
    }

    try {
        const [result] = await db.query('INSERT INTO tax_rates SET ?', payload);
        const [rows] = await db.query('SELECT * FROM tax_rates WHERE id = ? LIMIT 1', [result.insertId]);
        return res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Tax rates create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Tax rate with same name and percent already exists' });
        }
        return res.status(500).json({ error: 'Failed to create tax rate' });
    }
});

router.put('/tax-rates/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid tax rate id' });
    }

    const payload = {
        name: normalizeText(req.body.name),
        rate_percent: toNumber(req.body.rate_percent, NaN),
        tax_type: normalizeText(req.body.tax_type) || 'gst',
        is_active: toBoolInt(req.body.is_active, 1),
    };

    if (!payload.name) {
        return res.status(400).json({ error: 'name is required' });
    }
    if (!Number.isFinite(payload.rate_percent) || payload.rate_percent < 0 || payload.rate_percent > 100) {
        return res.status(400).json({ error: 'rate_percent must be between 0 and 100' });
    }
    if (!['gst', 'igst', 'cess', 'other'].includes(payload.tax_type)) {
        return res.status(400).json({ error: 'tax_type must be gst, igst, cess, or other' });
    }

    try {
        const [result] = await db.query('UPDATE tax_rates SET ? WHERE id = ?', [payload, id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Tax rate not found' });
        }
        const [rows] = await db.query('SELECT * FROM tax_rates WHERE id = ? LIMIT 1', [id]);
        return res.json(rows[0]);
    } catch (err) {
        console.error('Tax rates update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Tax rate with same name and percent already exists' });
        }
        return res.status(500).json({ error: 'Failed to update tax rate' });
    }
});

router.delete('/tax-rates/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid tax rate id' });
    }

    try {
        const [result] = await db.query('DELETE FROM tax_rates WHERE id = ?', [id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Tax rate not found' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Tax rates delete error:', err);
        return res.status(500).json({ error: 'Failed to delete tax rate' });
    }
});

router.get('/units', async (req, res) => {
    const { q, active } = req.query;
    const filters = [];
    const params = [];

    if (q) {
        const pattern = `%${String(q).trim()}%`;
        filters.push('(unit_name LIKE ? OR unit_code LIKE ?)');
        params.push(pattern, pattern);
    }

    if (active === '0' || active === '1') {
        filters.push('is_active = ?');
        params.push(Number(active));
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT id, unit_name, unit_code, is_active, created_at, updated_at
            FROM units
            ${whereSql}
            ORDER BY unit_name ASC
            `,
            params
        );

        return res.json(rows);
    } catch (err) {
        console.error('Units list error:', err);
        return res.status(500).json({ error: 'Failed to fetch units' });
    }
});

router.post('/units', async (req, res) => {
    const payload = {
        unit_name: normalizeText(req.body.unit_name),
        unit_code: normalizeText(req.body.unit_code),
        is_active: toBoolInt(req.body.is_active, 1),
    };

    if (!payload.unit_name || !payload.unit_code) {
        return res.status(400).json({ error: 'unit_name and unit_code are required' });
    }

    try {
        const [result] = await db.query('INSERT INTO units SET ?', payload);
        const [rows] = await db.query('SELECT * FROM units WHERE id = ? LIMIT 1', [result.insertId]);
        return res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Units create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Unit name/code already exists' });
        }
        return res.status(500).json({ error: 'Failed to create unit' });
    }
});

router.put('/units/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid unit id' });
    }

    const payload = {
        unit_name: normalizeText(req.body.unit_name),
        unit_code: normalizeText(req.body.unit_code),
        is_active: toBoolInt(req.body.is_active, 1),
    };

    if (!payload.unit_name || !payload.unit_code) {
        return res.status(400).json({ error: 'unit_name and unit_code are required' });
    }

    try {
        const [result] = await db.query('UPDATE units SET ? WHERE id = ?', [payload, id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Unit not found' });
        }
        const [rows] = await db.query('SELECT * FROM units WHERE id = ? LIMIT 1', [id]);
        return res.json(rows[0]);
    } catch (err) {
        console.error('Units update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Unit name/code already exists' });
        }
        return res.status(500).json({ error: 'Failed to update unit' });
    }
});

router.delete('/units/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid unit id' });
    }

    try {
        const [result] = await db.query('DELETE FROM units WHERE id = ?', [id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Unit not found' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Units delete error:', err);
        return res.status(500).json({ error: 'Failed to delete unit' });
    }
});

router.get('/bank-accounts', async (req, res) => {
    const { q, active } = req.query;
    const filters = [];
    const params = [];

    if (q) {
        const pattern = `%${String(q).trim()}%`;
        filters.push('(account_name LIKE ? OR bank_name LIKE ? OR account_number LIKE ? OR ifsc_code LIKE ?)');
        params.push(pattern, pattern, pattern, pattern);
    }

    if (active === '0' || active === '1') {
        filters.push('is_active = ?');
        params.push(Number(active));
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    try {
        const [rows] = await db.query(
            `
            SELECT
                id,
                account_name,
                bank_name,
                account_number,
                ifsc_code,
                branch_name,
                upi_id,
                opening_balance,
                current_balance,
                is_active,
                created_at,
                updated_at
            FROM bank_accounts
            ${whereSql}
            ORDER BY bank_name ASC, account_name ASC
            `,
            params
        );

        return res.json(rows);
    } catch (err) {
        console.error('Bank accounts list error:', err);
        return res.status(500).json({ error: 'Failed to fetch bank accounts' });
    }
});

router.post('/bank-accounts', async (req, res) => {
    const openingBalance = toNumber(req.body.opening_balance, 0);
    const currentBalance = req.body.current_balance === undefined || req.body.current_balance === null || req.body.current_balance === ''
        ? openingBalance
        : toNumber(req.body.current_balance, openingBalance);

    const payload = {
        account_name: normalizeText(req.body.account_name),
        bank_name: normalizeText(req.body.bank_name),
        account_number: normalizeText(req.body.account_number),
        ifsc_code: normalizeText(req.body.ifsc_code),
        branch_name: normalizeText(req.body.branch_name),
        upi_id: normalizeText(req.body.upi_id),
        opening_balance: openingBalance,
        current_balance: currentBalance,
        is_active: toBoolInt(req.body.is_active, 1),
    };

    if (!payload.account_name || !payload.bank_name || !payload.account_number) {
        return res.status(400).json({ error: 'account_name, bank_name, and account_number are required' });
    }

    if (payload.opening_balance < 0 || payload.current_balance < 0) {
        return res.status(400).json({ error: 'opening/current balance cannot be negative' });
    }

    try {
        const [result] = await db.query('INSERT INTO bank_accounts SET ?', payload);
        const [rows] = await db.query('SELECT * FROM bank_accounts WHERE id = ? LIMIT 1', [result.insertId]);
        return res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Bank accounts create error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Bank account number already exists' });
        }
        return res.status(500).json({ error: 'Failed to create bank account' });
    }
});

router.put('/bank-accounts/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid bank account id' });
    }

    const payload = {
        account_name: normalizeText(req.body.account_name),
        bank_name: normalizeText(req.body.bank_name),
        account_number: normalizeText(req.body.account_number),
        ifsc_code: normalizeText(req.body.ifsc_code),
        branch_name: normalizeText(req.body.branch_name),
        upi_id: normalizeText(req.body.upi_id),
        opening_balance: toNumber(req.body.opening_balance, 0),
        current_balance: toNumber(req.body.current_balance, 0),
        is_active: toBoolInt(req.body.is_active, 1),
    };

    if (!payload.account_name || !payload.bank_name || !payload.account_number) {
        return res.status(400).json({ error: 'account_name, bank_name, and account_number are required' });
    }

    if (payload.opening_balance < 0 || payload.current_balance < 0) {
        return res.status(400).json({ error: 'opening/current balance cannot be negative' });
    }

    try {
        const [result] = await db.query('UPDATE bank_accounts SET ? WHERE id = ?', [payload, id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Bank account not found' });
        }
        const [rows] = await db.query('SELECT * FROM bank_accounts WHERE id = ? LIMIT 1', [id]);
        return res.json(rows[0]);
    } catch (err) {
        console.error('Bank accounts update error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Bank account number already exists' });
        }
        return res.status(500).json({ error: 'Failed to update bank account' });
    }
});

router.delete('/bank-accounts/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid bank account id' });
    }

    try {
        const [result] = await db.query('DELETE FROM bank_accounts WHERE id = ?', [id]);
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Bank account not found' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Bank accounts delete error:', err);
        return res.status(500).json({ error: 'Failed to delete bank account' });
    }
});

export default router;
