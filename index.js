const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const LOG_FILE_PATH = path.join(BASE_DIR, 'monitored_targets.csv');
const HOST_LOG_PATH = path.join(BASE_DIR, 'host_logs.txt');

let wsConnection = null;
let heartbeatTimer = null;
let reconnectTimer = null;

app.use(express.json({ limit: '1mb' }));

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

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
  const timestamp = new Date().toLocaleTimeString();
  const text = safeStringify(message);
  const prefix = level === 'ERROR' ? ' [ERROR]' : '';
  fs.appendFileSync(HOST_LOG_PATH, `[${timestamp}]${prefix} ${text}\n`, 'utf8');
}

function initializeFiles() {
  ensureDirectoryExists(PUBLIC_DIR);

  if (!fs.existsSync(LOG_FILE_PATH)) {
    fs.writeFileSync(LOG_FILE_PATH, 'Timestamp,User ID,Username,Server ID\n', 'utf8');
  }

  if (!fs.existsSync(HOST_LOG_PATH)) {
    const startupMessage = `=== Server started: ${new Date().toLocaleString()} ===\n`;
    fs.writeFileSync(HOST_LOG_PATH, startupMessage, 'utf8');
  }
}

function patchConsoleLogging() {
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    const message = args.length > 1 ? args.map(safeStringify).join(' ') : safeStringify(args[0]);
    appendHostLog(message, 'INFO');
    originalLog.apply(console, args);
  };

  console.error = (...args) => {
    const message = args.length > 1 ? args.map(safeStringify).join(' ') : safeStringify(args[0]);
    appendHostLog(message, 'ERROR');
    originalError.apply(console, args);
  };
}

function logNewTarget(userId, username, guildId) {
  const timestamp = new Date().toISOString();
  const safeUser = String(username || 'unknown').replace(/"/g, '""');
  const safeGuildId = String(guildId || 'unknown').replace(/"/g, '""');
  const logLine = `"${timestamp}","${userId}","${safeUser}","${safeGuildId}"\n`;

  fs.appendFileSync(LOG_FILE_PATH, logLine, 'utf8');
  console.log(`[TARGET LOGGED] User: ${safeUser} joined Guild: ${safeGuildId}`);
}

function connectToDiscordGateway(token) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('Token is missing or invalid.');
  }

  if (
    wsConnection &&
    (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.log('Connecting to Discord Gateway...');
  wsConnection = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

  wsConnection.on('open', () => {
    console.log('WebSocket connection opened.');
  });

  wsConnection.on('message', (data) => {
    let payload;

    try {
      payload = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch (error) {
      console.error(`Failed to parse WebSocket message: ${error.message}`);
      return;
    }

    const { op, d, t } = payload || {};

    switch (op) {
      case 10: {
        const heartbeatIntervalMs = Number(d && d.heartbeat_interval) || 30000;

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }

        heartbeatTimer = setInterval(() => {
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
            presence: {
              status: 'online',
              since: 0,
              afk: false
            },
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
          const username = d && d.user ? d.user.username : 'unknown';
          console.log(`[SUCCESS] Logged in successfully as: ${username}`);
        }

        if (t === 'GUILD_MEMBER_ADD') {
          const guildId = d && d.guild_id;
          const user = d && d.user;

          if (user) {
            logNewTarget(user.id, user.username, guildId);
          }
        }
        break;

      default:
        break;
    }
  });

  wsConnection.on('close', () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    console.log('Discord connection lost. Reconnecting in 5 seconds...');
    reconnectTimer = setTimeout(() => connectToDiscordGateway(token), 5000);
  });

  wsConnection.on('error', (error) => {
    console.error(`Discord WebSocket error: ${error && error.message ? error.message : error}`);
  });
}

function serveHomePage(req, res) {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');

  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }

  return res.send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Monitoring Panel</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 32px;">
        <h1>Monitoring Panel</h1>
        <p>Server is running successfully.</p>
        <p>Open the monitoring panel API or create a public/index.html file.</p>
      </body>
    </html>
  `);
}

app.get('/', serveHomePage);
app.use(express.static(PUBLIC_DIR));

app.post('/api/start-monitor', (req, res) => {
  const { token } = req.body || {};

  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({
      status: 'error',
      message: 'A valid Discord token is required.'
    });
  }

  try {
    connectToDiscordGateway(token);
    return res.json({
      status: 'success',
      message: 'Live monitoring started successfully.'
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error && error.message ? error.message : 'Unknown server error.'
    });
  }
});

app.get('/api/download-targets', (req, res) => {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    return res.status(404).send('No recorded data available yet.');
  }

  return res.download(LOG_FILE_PATH, 'targets.csv');
});

app.get('/api/download-host-logs', (req, res) => {
  if (!fs.existsSync(HOST_LOG_PATH)) {
    return res.status(404).send('Host log file not found.');
  }

  return res.download(HOST_LOG_PATH, 'host_logs.txt');
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

  const malformedQuotePath =
    rawPath.includes('%22') ||
    decodedPath.includes('"') ||
    decodedPath === '/"' ||
    decodedPath === '"';

  if (malformedQuotePath || decodedPath === '/') {
    return res.redirect('/');
  }

  if (rawPath.startsWith('/api/')) {
    return res.status(404).json({
      status: 'error',
      message: `Route not found: ${rawPath}`
    });
  }

  return res.status(404).send(`Route not found: ${rawPath}`);
});

initializeFiles();
patchConsoleLogging();

app.listen(PORT, () => {
  console.log(`Monitoring panel is running at: http://localhost:${PORT}`);
});
