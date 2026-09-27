const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE_PATH = path.join(__dirname, 'monitored_targets.csv');
const HOST_LOG_PATH = path.join(__dirname, 'host_logs.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');

const activeConnections = new Map();
const tokenTargets = new Map();
const tokenStatus = new Map();

app.use(express.json({ limit: '1mb' }));

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

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function normalizeToken(token) {
  if (typeof token !== 'string') return '';
  return token.trim();
}

function parseTokenList(input) {
  if (Array.isArray(input)) {
    return input.map(normalizeToken).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input.split(/[\r\n,;]+/).map(normalizeToken).filter(Boolean);
  }
  return [];
}

function ensureTokenState(token) {
  const key = normalizeToken(token);
  if (!key) return null;

  if (!tokenStatus.has(key)) {
    tokenStatus.set(key, {
      token: key,
      status: 'idle',
      connected: false,
      targetCount: 0,
      startedAt: null,
      updatedAt: new Date().toISOString()
    });
  }

  return tokenStatus.get(key);
}

function updateTokenState(token, patch = {}) {
  const state = ensureTokenState(token);
  if (!state) return null;

  const merged = {
    ...state,
    ...patch,
    token: normalizeToken(token),
    updatedAt: new Date().toISOString(),
    targetCount: (tokenTargets.get(normalizeToken(token)) || []).length
  };

  tokenStatus.set(normalizeToken(token), merged);
  return merged;
}

if (!fs.existsSync(LOG_FILE_PATH)) {
  fs.writeFileSync(
    LOG_FILE_PATH,
    'Timestamp,User ID,Username,Global Name,Discriminator,Avatar,Bot,Guild ID,Joined At,Raw Data JSON\n',
    'utf8'
  );
}
if (!fs.existsSync(HOST_LOG_PATH)) {
  fs.writeFileSync(HOST_LOG_PATH, `=== Server started: ${new Date().toLocaleString()} ===\n`, 'utf8');
}

const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  appendHostLog(args.length > 1 ? args.map(safeStringify).join(' ') : safeStringify(args[0]), 'INFO');
  originalLog.apply(console, args);
};

console.error = function (...args) {
  appendHostLog(args.length > 1 ? args.map(safeStringify).join(' ') : safeStringify(args[0]), 'ERROR');
  originalError.apply(console, args);
};

function appendTargetEntry(entry, tokenKey = 'default') {
  const timestamp = entry && entry.timestamp ? entry.timestamp : new Date().toISOString();
  const user = entry && entry.user ? entry.user : {};
  const guildId = entry && entry.guildId ? entry.guildId : '';
  const joinedAt = entry && entry.joinedAt ? entry.joinedAt : '';
  const rawData = entry && entry.rawData ? entry.rawData : {};

  const row = [
    timestamp,
    user.id || '',
    user.username || '',
    user.global_name || '',
    user.discriminator || '',
    user.avatar || '',
    user.bot ? 'true' : 'false',
    guildId,
    joinedAt,
    JSON.stringify(rawData)
  ].map(csvEscape).join(',');

  fs.appendFileSync(LOG_FILE_PATH, `${row}\n`, 'utf8');

  if (!tokenTargets.has(tokenKey)) {
    tokenTargets.set(tokenKey, []);
  }

  tokenTargets.get(tokenKey).push({
    timestamp,
    userId: user.id || '',
    username: user.username || 'unknown',
    globalName: user.global_name || '',
    discriminator: user.discriminator || '',
    avatar: user.avatar || '',
    bot: Boolean(user.bot),
    guildId,
    joinedAt,
    rawData
  });

  console.log(`[TARGET LOGGED] User: ${user.username || 'unknown'} joined Guild: ${guildId}`);
}

function logNewTarget(user, guildId, extra = {}, tokenKey = 'default') {
  const entry = {
    timestamp: new Date().toISOString(),
    user: {
      id: user && user.id ? user.id : '',
      username: user && user.username ? user.username : 'unknown',
      global_name: user && user.global_name ? user.global_name : '',
      discriminator: user && user.discriminator ? user.discriminator : '',
      avatar: user && user.avatar ? user.avatar : '',
      bot: Boolean(user && user.bot)
    },
    guildId: guildId || '',
    joinedAt: extra.joinedAt || new Date().toISOString(),
    rawData: {
      ...extra,
      user: user || {},
      guild_id: guildId || '',
      joined_at: extra.joinedAt || new Date().toISOString()
    }
  };

  appendTargetEntry(entry, tokenKey);
}

function connectToDiscordGateway(token) {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) {
    throw new Error('Token is missing or invalid.');
  }

  const tokenKey = normalizedToken.slice(0, 12);
  const existing = activeConnections.get(normalizedToken);

  updateTokenState(normalizedToken, {
    status: 'connecting',
    connected: false,
    startedAt: new Date().toISOString()
  });

  if (existing && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (existing && existing.reconnectTimer) {
    clearTimeout(existing.reconnectTimer);
    existing.reconnectTimer = null;
  }

  if (!tokenTargets.has(normalizedToken)) {
    tokenTargets.set(normalizedToken, []);
  }

  console.log('Connecting to Discord Gateway...');
  const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
  const connection = { ws, heartbeat: null, reconnectTimer: null, token: normalizedToken, tokenKey };
  activeConnections.set(normalizedToken, connection);

  ws.on('open', () => {
    updateTokenState(normalizedToken, {
      status: 'online',
      connected: true,
      startedAt: new Date().toISOString()
    });
    console.log('WebSocket connected.');
  });

  ws.on('message', (data) => {
    let payload;
    try {
      payload = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch (error) {
      console.error(`Failed to parse message: ${error.message}`);
      return;
    }

    const { op, d, t } = payload || {};

    switch (op) {
      case 10: {
        const heartbeatMs = Number(d && d.heartbeat_interval) || 30000;
        if (connection.heartbeat) {
          clearInterval(connection.heartbeat);
        }

        connection.heartbeat = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: null }));
          }
        }, heartbeatMs);

        const identifyPayload = {
          op: 2,
          d: {
            token: normalizedToken,
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

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(identifyPayload));
        }
        break;
      }

      case 0:
        if (t === 'READY') {
          const username = d && d.user ? d.user.username : 'unknown';
          console.log(`[SUCCESS] Logged in as: ${username}`);
        }

        if (t === 'GUILD_MEMBER_ADD') {
          const guildId = d && d.guild_id;
          const user = d && d.user;
          const member = d && d.member ? d.member : {};

          if (user) {
            logNewTarget(
              user,
              guildId,
              {
                joinedAt: member.joined_at || new Date().toISOString(),
                nick: member.nick || '',
                pending: Boolean(member.pending),
                premium_since: member.premium_since || '',
                roles: Array.isArray(member.roles) ? member.roles : []
              },
              normalizedToken
            );
          }
        }
        break;
    }
  });

  ws.on('close', () => {
    if (connection.heartbeat) {
      clearInterval(connection.heartbeat);
      connection.heartbeat = null;
    }

    updateTokenState(normalizedToken, {
      status: 'reconnecting',
      connected: false
    });

    console.log('Gateway disconnected. Reconnecting in 5 seconds...');
    connection.reconnectTimer = setTimeout(() => connectToDiscordGateway(normalizedToken), 5000);
  });

  ws.on('error', (error) => {
    updateTokenState(normalizedToken, {
      status: 'error',
      connected: false,
      error: error && error.message ? error.message : String(error)
    });
    console.error(`Gateway error: ${error && error.message ? error.message : error}`);
  });
}

app.get('/', (req, res) => {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }

  return res.send(`<!doctype html><html><body><h1>Server is running</h1><p>Create a public/index.html file or use the monitoring API.</p></body></html>`);
});
app.use(express.static(PUBLIC_DIR));

app.post('/api/start-monitor', (req, res) => {
  const { token, tokens } = req.body || {};
  const tokenList = parseTokenList(tokens || token);

  if (!tokenList.length) {
    return res.status(400).json({ status: 'error', message: 'A valid Discord token is required.' });
  }

  try {
    tokenList.forEach((singleToken) => {
      const normalized = normalizeToken(singleToken);
      if (!normalized) return;
      ensureTokenState(normalized);
      updateTokenState(normalized, { status: 'connecting', connected: false, startedAt: new Date().toISOString() });
      connectToDiscordGateway(normalized);
    });

    return res.json({
      status: 'success',
      message: `Monitoring started for ${tokenList.length} token(s).`,
      count: tokenList.length
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error && error.message ? error.message : 'Unknown server error.'
    });
  }
});

app.post('/api/remove-token', (req, res) => {
  const { token } = req.body || {};
  const normalized = normalizeToken(token);

  if (!normalized) {
    return res.status(400).json({ status: 'error', message: 'Token is required.' });
  }

  const connection = activeConnections.get(normalized);
  if (connection) {
    if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close();
    }

    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
    }

    activeConnections.delete(normalized);
  }

  tokenTargets.delete(normalized);
  tokenStatus.delete(normalized);

  return res.json({ status: 'success', removed: normalized });
});

app.post('/api/clear-tokens', (req, res) => {
  for (const [token, connection] of activeConnections.entries()) {
    if (connection && connection.ws && (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING)) {
      connection.ws.close();
    }
    if (connection && connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
    }
    activeConnections.delete(token);
  }

  tokenTargets.clear();
  tokenStatus.clear();

  return res.json({ status: 'success', cleared: true });
});

app.get('/api/token-status', (req, res) => {
  const response = {};
  for (const [token, state] of tokenStatus.entries()) {
    response[token] = {
      ...state,
      targetCount: (tokenTargets.get(token) || []).length
    };
  }
  return res.json(response);
});

app.get('/api/token-targets', (req, res) => {
  const response = {};
  for (const [token, entries] of tokenTargets.entries()) {
    response[token] = (entries || []).slice(-40).reverse();
  }
  return res.json(response);
});

app.get('/api/targets', (req, res) => {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    return res.json([]);
  }

  const content = fs.readFileSync(LOG_FILE_PATH, 'utf8').trim();
  if (!content) {
    return res.json([]);
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    return res.json([]);
  }

  const rows = lines.slice(1).map((line) => {
    const values = line.match(/"([^"]*(?:""[^"]*)*)"|([^,]+)/g) || [];
    const cleaned = values.map((value) => value.replace(/^"|"$/g, '').replace(/""/g, '"'));

    let rawData = {};
    try {
      rawData = JSON.parse(cleaned[9] || '{}');
    } catch (error) {
      rawData = {};
    }

    return {
      timestamp: cleaned[0] || '',
      userId: cleaned[1] || '',
      username: cleaned[2] || '',
      globalName: cleaned[3] || '',
      discriminator: cleaned[4] || '',
      avatar: cleaned[5] || '',
      bot: cleaned[6] === 'true',
      guildId: cleaned[7] || '',
      joinedAt: cleaned[8] || '',
      rawData
    };
  }).filter((row) => row.timestamp || row.userId || row.username || row.guildId);

  return res.json(rows);
});

app.get('/api/download-targets', (req, res) => {
  if (fs.existsSync(LOG_FILE_PATH)) {
    return res.download(LOG_FILE_PATH, 'targets.csv');
  }
  return res.status(404).send('No recorded data yet.');
});

app.get('/api/download-host-logs', (req, res) => {
  if (fs.existsSync(HOST_LOG_PATH)) {
    return res.download(HOST_LOG_PATH, 'host_logs.txt');
  }
  return res.status(404).send('Host logs not found.');
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

  const malformed = rawPath.includes('%22') || decodedPath.includes('"') || decodedPath === '/"' || decodedPath === '"';
  if (malformed || decodedPath === '/') {
    return res.redirect('/');
  }

  if (rawPath.startsWith('/api/')) {
    return res.status(404).json({ status: 'error', message: `Route not found: ${rawPath}` });
  }

  return res.status(404).send(`Route not found: ${rawPath}`);
});

app.listen(PORT, () => {
  console.log(`Monitoring panel is running at: http://localhost:${PORT}`);
});
