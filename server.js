import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateToken, authorizeRoles } from './middleware/security.js';
import usersRouter from './routes/users.js';
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';
import reportRouter from './routes/report.js';
import swaggerRouter from './routes/swagger.js';
import itemsRouter from './routes/items.js';
import partiesRouter from './routes/parties.js';
import salesRouter from './routes/sales.js';
import estimatesRouter from './routes/estimates.js';
import deliveryChallansRouter from './routes/deliveryChallans.js';
import creditNotesRouter from './routes/creditNotes.js';
import purchasesRouter from './routes/purchases.js';
import paymentInRouter from './routes/paymentIn.js';
import paymentOutRouter from './routes/paymentOut.js';
import debitNotesRouter from './routes/debitNotes.js';
import settingsRouter from './routes/settings.js';

console.log('JWT_SECRET in use:', process.env.JWT_SECRET);

const app = express();

app.use(express.json());
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Basic health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Serve uploaded files (e.g. company logos) statically.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Public routes
app.use('/api/auth', authRouter);
app.use('/api/docs', swaggerRouter);

// Protected routes
app.use('/api/dashboard', authenticateToken, authorizeRoles(1, 2), dashboardRouter);
app.use('/api/users', authenticateToken, authorizeRoles(1), usersRouter);
app.use('/api/report', authenticateToken, authorizeRoles(1), reportRouter);
app.use('/api/items', authenticateToken, authorizeRoles(1, 2), itemsRouter);
app.use('/api/parties', authenticateToken, authorizeRoles(1, 2), partiesRouter);
app.use('/api/sales', authenticateToken, authorizeRoles(1, 2), salesRouter);
app.use('/api/estimates', authenticateToken, authorizeRoles(1, 2), estimatesRouter);
app.use('/api/delivery-challans', authenticateToken, authorizeRoles(1, 2), deliveryChallansRouter);
app.use('/api/credit-notes', authenticateToken, authorizeRoles(1, 2), creditNotesRouter);
app.use('/api/purchases', authenticateToken, authorizeRoles(1, 2), purchasesRouter);
app.use('/api/payment-in', authenticateToken, authorizeRoles(1, 2), paymentInRouter);
app.use('/api/payment-out', authenticateToken, authorizeRoles(1, 2), paymentOutRouter);
app.use('/api/debit-notes', authenticateToken, authorizeRoles(1, 2), debitNotesRouter);
app.use('/api/settings', authenticateToken, authorizeRoles(1, 2), settingsRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
