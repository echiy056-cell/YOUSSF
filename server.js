// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration ---
const USER_TOKEN = process.env.USER_TOKEN; // Your User Token (starts with MTA...)
const JWT_SECRET = process.env.JWT_SECRET || 'covert-user-secret';
const BASE_URL = 'https://discord.com/api/v10';

// --- In-Memory Store ---
let monitorLog = [];

// --- Helper: Get Headers ---
const getHeaders = () => ({
    'Authorization': USER_TOKEN,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' // Spoof User-Agent
});

/**
 * 1. INITIALIZE MONITORING
 */
async function initMonitor() {
    try {
        // Verify token by fetching current user
        const { data } = await axios.get(`${BASE_URL}/users/@me`, { headers: getHeaders() });
        console.log(`Covert Monitor active as: ${data.username}#${data.discriminator}`);
        
        // Start listening for events (Polling method for simplicity)
        startEventPolling();
    } catch (error) {
        console.error('Failed to authenticate:', error.response?.data || error.message);
        process.exit(1);
    }
}

/**
 * 2. EVENT POLLING (Simplified Covert Monitoring)
 * Discord doesn't provide a simple "listen" endpoint for users via REST like bots do with WebSockets.
 * We will poll recent messages in key channels.
 */
async function startEventPolling() {
    // Example: Monitor a specific channel ID
    const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID; 

    if (!TARGET_CHANNEL_ID) {
        console.log('No target channel set. Polling general activity...');
    }

    setInterval(async () => {
        try {
            let messages = [];
            
            // If a specific channel is set, monitor that
            if (TARGET_CHANNEL_ID) {
                const { data } = await axios.get(`${BASE_URL}/channels/${TARGET_CHANNEL_ID}/messages?limit=10`, { 
                    headers: getHeaders() 
                });
                messages = data;
            } else {
                // Fallback: Fetch recent messages from a few known channels (requires knowing IDs)
                console.log('Polling general activity...');
            }

            // Process new messages
            messages.forEach(msg => {
                const logEntry = {
                    event: 'MESSAGE',
                    timestamp: msg.timestamp,
                    author: msg.author.username,
                    content: msg.content.substring(0, 100),
                    channel_id: msg.channel_id,
                    id: msg.id
                };

                // Avoid duplicates (simple check)
                if (!monitorLog.some(log => log.id === logEntry.id)) {
                    monitorLog.unshift(logEntry); // Add to front
                    console.log(`[LOGGED] ${logEntry.author}: ${logEntry.content}`);
                }
            });

        } catch (error) {
            console.error('Polling error:', error.response?.data || error.message);
        }
    }, 5000); // Poll every 5 seconds
}

/**
 * 3. API ROUTES
 */
app.use(morgan('dev'));
app.use(express.json());

// Middleware: Verify JWT Token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ message: 'Access denied' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid token' });
        req.user = user;
        next();
    });
};

// GET /api/logs - Retrieve monitoring logs
app.get('/api/logs', authenticateToken, (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    res.json({
        count: monitorLog.length,
        logs: monitorLog.slice(0, limit) // Return latest N logs
    });
});

// GET /api/status - Check if token is valid
app.get('/api/status', authenticateToken, async (req, res) => {
    try {
        const { data } = await axios.get(`${BASE_URL}/users/@me`, { headers: getHeaders() });
        res.json({
            status: 'online',
            user: `${data.username}#${data.discriminator}`,
            id: data.id
        });
    } catch (error) {
        res.status(500).json({ message: 'Token invalid or rate limited' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Covert User Monitor API running on port ${PORT}`);
});

// Initialize
initMonitor();
