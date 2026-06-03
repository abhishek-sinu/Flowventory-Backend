import express from 'express';
const router = express.Router();
import db from '../db.js';

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User management endpoints
 */

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 */
// Get all users
router.get('/', (req, res) => {
    (async () => {
        try {
            const [results] = await db.query('SELECT * FROM users');
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err });
        }
    })();
});

// Get user by ID
/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: User ID
 *     responses:
 *       200:
 *         description: User object
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
router.get('/:id', (req, res) => {
    (async () => {
        try {
            const [results] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
            res.json(results[0]);
        } catch (err) {
            res.status(500).json({ error: err });
        }
    })();
});

// Create user
/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create a new user
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       200:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
router.post('/', (req, res) => {
    const user = req.body;
    db.query('INSERT INTO users SET ?', user, (err, result) => {
        if (err) return res.status(500).json({ error: err });
        res.json({ id: result.insertId, ...user });
        // Audit log
        if (req.user && req.user.id) {
            db.query('INSERT INTO audit_logs SET ?', {
                user_id: req.user.id,
                action: 'create_user',
                details: JSON.stringify({ user_id: result.insertId, user }),
            });
        }
    });
});

// Update user
/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user by ID
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       200:
 *         description: User updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 */
router.put('/:id', (req, res) => {
    db.query('UPDATE users SET ? WHERE id = ?', [req.body, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err });
        res.json({ message: 'User updated' });
        // Audit log
        if (req.user && req.user.id) {
            db.query('INSERT INTO audit_logs SET ?', {
                user_id: req.user.id,
                action: 'update_user',
                details: JSON.stringify({ user_id: req.params.id, user: req.body }),
            });
        }
    });
});

// Delete user
/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Delete user by ID
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: User ID
 *     responses:
 *       200:
 *         description: User deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 */
router.delete('/:id', (req, res) => {
    db.query('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err });
        res.json({ message: 'User deleted' });
        // Audit log
        if (req.user && req.user.id) {
            db.query('INSERT INTO audit_logs SET ?', {
                user_id: req.user.id,
                action: 'delete_user',
                details: JSON.stringify({ user_id: req.params.id }),
            });
        }
    });
});

export default router;
/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         username:
 *           type: string
 *         email:
 *           type: string
 *         password_hash:
 *           type: string
 *         role_id:
 *           type: integer
 *         last_login:
 *           type: string
 *           format: date-time
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */
