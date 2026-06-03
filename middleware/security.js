// Security middleware for role-based access
import jwt from 'jsonwebtoken';

function authenticateToken(req, res, next) {
    const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    console.log('[AUTH] Incoming token:', token);
    if (!token) return res.status(401).json({ error: 'No token provided' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.warn('[AUTH] Invalid token:', err.message);
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        console.log('[AUTH] Token decoded user:', user);
        next();
    });
}

function authorizeRoles(...roles) {
    return (req, res, next) => {
        console.log('[AUTH] authorizeRoles check:', {
            user: req.user,
            allowedRoles: roles
        });
        if (!roles.includes(req.user.role_id)) {
            console.warn('[AUTH] Forbidden: user role_id', req.user.role_id, 'not in', roles);
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}

export { authenticateToken, authorizeRoles };
