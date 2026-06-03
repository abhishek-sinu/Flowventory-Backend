import express from 'express';
const router = express.Router();
import db from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication endpoints
 */

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: User login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: JWT token and user info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Invalid credentials
 */
// User login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log('[LOGIN] Incoming:', { username });
    try {
        const [results] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        console.log('[LOGIN] User lookup results:', results);
        if (!results.length) {
            console.warn('[LOGIN] Invalid credentials: user not found');
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        console.log('[LOGIN] Password compare result:', isMatch);
        if (!isMatch) {
            console.warn('[LOGIN] Invalid credentials: password mismatch');
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
        const token = jwt.sign({ id: user.id, username: user.username, role_id: user.role_id }, JWT_SECRET, { expiresIn: '1d' });
        console.log('[LOGIN] Token generated:', token);
        res.json({ success: true, token, user: { id: user.id, username: user.username, role_id: user.role_id } });
        console.log('[LOGIN] Response sent:', { id: user.id, username: user.username, role_id: user.role_id });
    } catch (err) {
        console.error('[LOGIN] DB error:', err);
        return res.status(500).json({ error: err });
    }
});

// User registration (admin only)
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: User registration (admin only)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
router.post('/register', async (req, res) => {
    const { username, email, password, role_id } = req.body;
    const resolvedRoleId = role_id || 2;
    console.log('[REGISTER] Incoming:', { username, email, role_id: resolvedRoleId });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userData = {
            username,
            email,
            password_hash: hashedPassword,
            role_id: resolvedRoleId,
        };

        // Ensure default Guest role exists for self-signup flow.
        if (!role_id) {
            await db.query('INSERT IGNORE INTO roles SET ?', { id: 2, name: 'Guest' });
        }

        const [result] = await db.query('INSERT INTO users SET ?', userData);
        console.log('[REGISTER] User created:', {
            id: result.insertId,
            username,
            email,
            role_id: resolvedRoleId,
        });

        return res.status(201).json({
            success: true,
            id: result.insertId,
            username,
            email,
            role_id: resolvedRoleId,
        });
    } catch (err) {
        console.error('[REGISTER] Error:', err);
        if (err && err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Username or email already exists' });
        }
        return res.status(500).json({ error: 'Registration failed' });
    }
});

export default router;
