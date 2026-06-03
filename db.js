import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Use a connection pool instead of a single connection. Pools are resilient
// to transient disconnections and will create new connections as needed.
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONN_LIMIT) || 10,
    queueLimit: 0,
});

console.log('MySQL pool created');

// Run an initial quick test query so any connection errors surface early.
async function testConnection() {
    try {
        await pool.query('SELECT 1');
        console.log('Database pool test query OK');
        // Test users table accessibility
        try {
            const [rows] = await pool.query('SELECT id, username FROM users LIMIT 1');
            console.log('Users table test query OK:', rows);
        } catch (userErr) {
            console.error('Users table test query failed:', userErr);
        }
    } catch (err) {
        console.error('Database pool test query failed', err);
    }
}

await testConnection();

// Keep-alive: periodically run a trivial query to keep connections from being
// closed by the server (some hosts drop idle connections overnight).
const KEEPALIVE_INTERVAL = Number(process.env.DB_KEEPALIVE_MS) || 5 * 60 * 1000; // 5 minutes
setInterval(async () => {
    try {
        await pool.query('SELECT 1');
    } catch (err) {
        console.error('Database keepalive error', err);
    }
}, KEEPALIVE_INTERVAL);

export default pool;
