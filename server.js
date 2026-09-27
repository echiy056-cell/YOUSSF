require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

// Middleware to parse JSON
app.use(express.json());

// Morgan logger for general HTTP access logs (visible in Railway)
app.use(morgan('combined'));

/**
 * COVERT MONITORING LOGGING
 * This function logs activity silently. In a real scenario, 
 * you might send this to a separate DB or CloudWatch stream 
 * that is not tied to your main SIEM alerts.
 */
const covertLog = (event, data) => {
    const logEntry = {
        timestamp: new Date().toISOString(),
        event: event,
        ...data
    };
    // Log to stdout so Railway captures it
    console.log(JSON.stringify(logEntry));
};

/**
 * 1. AUTH ENDPOINT
 * Issues a JWT with hidden monitoring metadata
 */
app.post('/auth/login', (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }

    // Generate a unique ID for this session/user to track covertly
    const monitoringId = `monitor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create JWT payload with hidden claims
    const payload = {
        sub: username,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24), // 24 hours
        // Hidden claim for monitoring
        meta: {
            monitoring_id: monitoringId,
            device_fingerprint: req.headers['x-device-id'] || 'unknown',
            ip: req.ip
        }
    };

    const token = jwt.sign(payload, JWT_SECRET);

    // Log the issuance covertly
    covertLog('TOKEN_ISSUED', { username, monitoring_id: monitoringId });

    res.json({
        token,
        monitoring_id: monitoringId // You can hide this in a cookie or send it only if needed
    });
});

/**
 * 2. COVERT MONITORING MIDDLEWARE
 * Intercepts requests, validates token, and logs activity
 */
const covertMonitorMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        // Verify token (without checking expiration for monitoring purposes if you want to track expired tokens too)
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Extract hidden monitoring ID
        const monitoringId = decoded.meta?.monitoring_id || 'unknown';
        
        // Log the activity covertly
        covertLog('API_ACCESS', {
            monitoring_id: monitoringId,
            endpoint: req.originalUrl,
            method: req.method,
            user: decoded.sub,
            timestamp: new Date().toISOString()
        });

        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

/**
 * 3. PROTECTED ENDPOINT
 */
app.get('/api/covert-data', covertMonitorMiddleware, (req, res) => {
    // Simulate sensitive data retrieval
    const sensitiveData = {
        secret_key: "123456789",
        user_profile: req.user || "Unknown"
    };

    return res.json({
        message: "Covert monitoring active",
        data: sensitiveData
    });
});

/**
 * 4. HEALTH CHECK (For Railway)
 */
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Covert Monitor API running on port ${PORT}`);
});
