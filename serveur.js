const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE_PATH = path.join(__dirname, 'monitored_targets.csv');
const HOST_LOG_PATH = path.join(__dirname, 'host_logs.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '1mb' }));
app.get('/', (req, res) => {
    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexFile)) {
        return res.sendFile(indexFile);
    }
    return res.send(`<!doctype html><html><body><h1>Server is running</h1><p>Open the monitoring panel API or create a public/index.html file.</p></body></html>`);
});
app.use(express.static(PUBLIC_DIR));

let wsConnection = null;
let heartbeatInterval = null;
let reconnectTimer = null;

function safeStringify(value) {
    try {
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') return value;
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return String(value);
    }
}

function appendHostLog(message, level = 'INFO') {
    const timeStamp = new Date().toLocaleTimeString();
    const text = safeStringify(message);
    const prefix = level === 'ERROR' ? ' [ERROR]' : '';
    fs.appendFileSync(HOST_LOG_PATH, `[${timeStamp}]${prefix} ${text}\n`, 'utf8');
}

// تجهيز الملفات الأساسية عند التشغيل لمنع الأخطاء
if (!fs.existsSync(LOG_FILE_PATH)) {
    fs.writeFileSync(LOG_FILE_PATH, 'Timestamp,User ID,Username,Server ID\n', 'utf8');
}
if (!fs.existsSync(HOST_LOG_PATH)) {
    fs.writeFileSync(HOST_LOG_PATH, `=== بداية تشغيل السيرفر التاريخ: ${new Date().toLocaleString()} ===\n`, 'utf8');
}

const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
    appendHostLog(args.length > 1 ? args.map(safeStringify).join(' ') : args[0], 'INFO');
    originalLog.apply(console, args);
};

console.error = function(...args) {
    appendHostLog(args.length > 1 ? args.map(safeStringify).join(' ') : args[0], 'ERROR');
    originalError.apply(console, args);
};

function logNewTarget(userId, username, guildId) {
    const timestamp = new Date().toISOString();
    const safeUser = String(username || 'unknown').replace(/"/g, '""');
    const safeGuildId = String(guildId || 'unknown');
    const logLine = `"${timestamp}","${userId}","${safeUser}","${safeGuildId}"\n`;

    fs.appendFileSync(LOG_FILE_PATH, logLine, 'utf8');
    console.log(`[TARGET LOGGED] User: ${safeUser} joined Guild: ${safeGuildId}`);
}

function connectToDiscordGateway(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
        throw new Error('التوكن غير صالح أو مفقود.');
    }

    if (wsConnection && (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING)) {
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    console.log('جاري الاتصال بـ Discord Gateway...');
    wsConnection = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

    wsConnection.on('open', () => {
        console.log('تم فتح الاتصال الأولي بالبوابة.');
    });

    wsConnection.on('message', (data) => {
        let payload;
        try {
            payload = JSON.parse(typeof data === 'string' ? data : data.toString());
        } catch (error) {
            console.error(`تعذر تحليل رسالة WebSocket: ${error.message}`);
            return;
        }

        const { op, d, t } = payload || {};

        switch (op) {
            case 10: {
                const heartbeatIntervalMs = Number(d && d.heartbeat_interval) || 30000;
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                }

                heartbeatInterval = setInterval(() => {
                    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                        wsConnection.send(JSON.stringify({ op: 1, d: null }));
                    }
                }, heartbeatIntervalMs);

                const identifyPayload = {
                    op: 2,
                    d: {
                        token: token.trim(),
                        capabilities: 125,
                        properties: {
                            os: 'Windows',
                            browser: 'Chrome',
                            device: ''
                        },
                        presence: { status: 'online', since: 0, afk: false },
                        compress: false
                    }
                };

                if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                    wsConnection.send(JSON.stringify(identifyPayload));
                }
                break;
            }

            case 0:
                if (t === 'READY') {
                    console.log(`[SUCCESS] تم تسجيل الدخول بنجاح باسم الحساب: ${d && d.user ? d.user.username : 'غير معروف'}`);
                }

                if (t === 'GUILD_MEMBER_ADD') {
                    const guildId = d && d.guild_id;
                    const user = d && d.user;
                    if (user) {
                        logNewTarget(user.id, user.username, guildId);
                    }
                }
                break;
        }
    });

    wsConnection.on('close', () => {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        console.log('تم قطع الاتصال بالبوابة. جاري محاولة إعادة الاتصال التلقائي بعد 5 ثوانٍ...');
        reconnectTimer = setTimeout(() => connectToDiscordGateway(token), 5000);
    });

    wsConnection.on('error', (error) => {
        console.error(`حدث خطأ في الاتصال بالبوابة: ${error && error.message ? error.message : error}`);
    });
}

app.post('/api/start-monitor', (req, res) => {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
        return res.status(400).json({ status: 'error', message: 'التوكن مطلوب لتشغيل الخدمة.' });
    }

    try {
        connectToDiscordGateway(token);
        res.json({ status: 'success', message: 'بدأت عملية المراقبة الحية بنجاح.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err && err.message ? err.message : 'حدث خطأ غير معروف.' });
    }
});

app.get('/api/download-targets', (req, res) => {
    if (fs.existsSync(LOG_FILE_PATH)) {
        res.download(LOG_FILE_PATH, 'targets.csv');
    } else {
        res.status(404).send('لا توجد بيانات مسجلة بعد.');
    }
});

app.get('/api/download-host-logs', (req, res) => {
    if (fs.existsSync(HOST_LOG_PATH)) {
        res.download(HOST_LOG_PATH, 'host_logs.txt');
    } else {
        res.status(404).send('ملف السجلات غير موجود.');
    }
});

app.use((req, res) => {
    const rawPath = req.originalUrl || req.url || '';
    const decodedPath = (() => {
        try {
            return decodeURIComponent(rawPath);
        } catch (error) {
            return rawPath;
        }
    })();

    const isMalformedQuotePath = rawPath.includes('%22') || decodedPath.includes('"') || decodedPath === '/"' || decodedPath === '"';
    if (isMalformedQuotePath || decodedPath === '/') {
        return res.redirect('/');
    }

    if (rawPath.startsWith('/api/')) {
        return res.status(404).json({ status: 'error', message: `Route not found: ${rawPath}` });
    }

    return res.status(404).send(`Route not found: ${rawPath}`);
});

app.listen(PORT, () => {
    console.log(`اللوحة تعمل الآن بنجاح على الرابط التالي: http://localhost:${PORT}`);
});
