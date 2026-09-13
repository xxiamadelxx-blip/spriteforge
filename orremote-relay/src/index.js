import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const STORE_PATH = process.env.DEVICE_STORE_PATH || path.join(process.cwd(), 'data', 'trusted-devices.json');
const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 15000);
const PAIR_TTL_MS = Number(process.env.PAIR_TTL_MS || 10 * 60 * 1000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const PAIR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_PAIR_ATTEMPTS_PER_IP = 8;

const trustedDevices = loadTrustedDevices();
const pairingByCode = new Map();
const connectedDevices = new Map();
const pendingMcp = new Map();
const pairAttempts = new Map();

function loadTrustedDevices() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))));
  } catch {
    return new Map();
  }
}

function persistTrustedDevices() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(trustedDevices), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function hasDeviceAuth(req, deviceId) {
  const record = trustedDevices.get(deviceId);
  if (!record?.agentTokenHash) return false;
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) return false;
  const provided = Buffer.from(tokenHash(value.slice(7)));
  const expected = Buffer.from(String(record.agentTokenHash));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function allowPairAttempt(req) {
  const key = clientIp(req);
  const now = Date.now();
  const current = pairAttempts.get(key);
  if (!current || current.resetAt <= now) {
    pairAttempts.set(key, { count: 1, resetAt: now + PAIR_ATTEMPT_WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_PAIR_ATTEMPTS_PER_IP) return false;
  current.count += 1;
  return true;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function deviceIdFromPublicKey(publicKeyDerBase64) {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyDerBase64, 'base64')).digest('hex').slice(0, 24);
}

function createPairCode() {
  for (let i = 0; i < 20; i += 1) {
    const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    if (!pairingByCode.has(code)) return code;
  }
  throw new Error('could not allocate pair code');
}

function cleanupExpiredPairs() {
  const now = Date.now();
  for (const [code, value] of pairingByCode.entries()) {
    if (value.expiresAt <= now) {
      pairingByCode.delete(code);
      try { value.ws.close(4003, 'pairing expired'); } catch {}
    }
  }
  for (const [ip, value] of pairAttempts.entries()) {
    if (value.resetAt <= now) pairAttempts.delete(ip);
  }
}

function publicKeyObject(publicKeyDerBase64) {
  return crypto.createPublicKey({
    key: Buffer.from(publicKeyDerBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function beginChallenge(ws) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  ws.orremote.challenge = nonce;
  ws.send(JSON.stringify({ type: 'challenge', nonce }));
}

function cancelPendingForDevice(deviceId, reason = 'DEVICE_DISCONNECTED') {
  for (const [requestId, pending] of pendingMcp.entries()) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    pendingMcp.delete(requestId);
    json(pending.res, 503, { error: reason });
  }
}

function authenticateSocket(ws, signatureBase64) {
  const state = ws.orremote;
  const record = trustedDevices.get(state.deviceId);
  if (!record || record.publicKey !== state.publicKey || !state.challenge) return false;

  const canonical = `orremote-m3|${state.deviceId}|${state.challenge}`;
  let valid = false;
  try {
    valid = crypto.verify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      publicKeyObject(state.publicKey),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {}
  if (!valid) return false;

  const previous = connectedDevices.get(state.deviceId);
  if (previous && previous.ws !== ws) {
    cancelPendingForDevice(state.deviceId, 'SESSION_SUPERSEDED');
    try { previous.ws.close(4000, 'superseded by new session'); } catch {}
  }

  const nextEpoch = Number(record.lastEpoch || 0) + 1;
  record.lastEpoch = nextEpoch;
  trustedDevices.set(state.deviceId, record);
  persistTrustedDevices();

  state.authenticated = true;
  state.sessionEpoch = nextEpoch;
  state.challenge = null;
  connectedDevices.set(state.deviceId, { ws, epoch: nextEpoch, connectedAt: Date.now() });
  ws.send(JSON.stringify({ type: 'authenticated', device_id: state.deviceId, session_epoch: nextEpoch }));
  return true;
}

function handleDeviceMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    ws.close(4002, 'invalid json');
    return;
  }

  const state = ws.orremote;
  if (message.type === 'challenge_response') {
    if (!authenticateSocket(ws, String(message.signature || ''))) ws.close(4001, 'authentication failed');
    return;
  }

  if (!state.authenticated) {
    ws.close(4001, 'authentication required');
    return;
  }

  if (message.type === 'mcp_response') {
    const requestId = String(message.request_id || '');
    const pending = pendingMcp.get(requestId);
    if (!pending) return;
    if (pending.deviceId !== state.deviceId || pending.epoch !== state.sessionEpoch) return;
    if (Number(message.session_epoch) !== state.sessionEpoch) return;

    clearTimeout(pending.timer);
    pendingMcp.delete(requestId);
    const body = typeof message.body === 'string' ? message.body : JSON.stringify(message.body ?? {});
    pending.res.writeHead(Number(message.status || 200), {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    pending.res.end(body);
    return;
  }

  if (message.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        service: 'orremote-relay',
        connected_devices: connectedDevices.size,
        paired_devices: trustedDevices.size,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/pair/claim') {
      cleanupExpiredPairs();
      if (!allowPairAttempt(req)) {
        json(res, 429, { error: 'PAIR_RATE_LIMITED' });
        return;
      }

      const input = JSON.parse(await readBody(req) || '{}');
      const code = String(input.code || '');
      const pending = pairingByCode.get(code);
      if (!pending || pending.expiresAt <= Date.now()) {
        json(res, 404, { error: 'PAIR_CODE_NOT_FOUND' });
        return;
      }

      pairingByCode.delete(code);
      const agentToken = crypto.randomBytes(32).toString('base64url');
      trustedDevices.set(pending.deviceId, {
        publicKey: pending.publicKey,
        agentTokenHash: tokenHash(agentToken),
        lastEpoch: 0,
        pairedAt: new Date().toISOString(),
      });
      persistTrustedDevices();
      if (pending.ws.readyState === WebSocket.OPEN) beginChallenge(pending.ws);
      json(res, 200, { paired: true, device_id: pending.deviceId, agent_token: agentToken });
      return;
    }

    let match = url.pathname.match(/^\/presence\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && match) {
      const deviceId = match[1];
      if (!hasDeviceAuth(req, deviceId)) {
        json(res, 401, { error: 'UNAUTHORIZED' });
        return;
      }
      const connected = connectedDevices.get(deviceId);
      json(res, 200, {
        device_id: deviceId,
        paired: trustedDevices.has(deviceId),
        connected: Boolean(connected),
        session_epoch: connected?.epoch ?? null,
      });
      return;
    }

    match = url.pathname.match(/^\/mcp\/([a-f0-9]{24})$/);
    if (req.method === 'POST' && match) {
      const deviceId = match[1];
      if (!hasDeviceAuth(req, deviceId)) {
        json(res, 401, { error: 'UNAUTHORIZED' });
        return;
      }

      const connection = connectedDevices.get(deviceId);
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
        json(res, 503, { error: 'DEVICE_OFFLINE' });
        return;
      }

      const requestBody = await readBody(req);
      const requestId = crypto.randomUUID();
      const epoch = connection.epoch;
      const headers = {
        'mcp-protocol-version': req.headers['mcp-protocol-version'] || '',
        'mcp-method': req.headers['mcp-method'] || '',
        'mcp-name': req.headers['mcp-name'] || '',
        'content-type': req.headers['content-type'] || 'application/json',
      };

      const timer = setTimeout(() => {
        if (!pendingMcp.has(requestId)) return;
        pendingMcp.delete(requestId);
        json(res, 504, { error: 'DEVICE_TIMEOUT' });
      }, MCP_TIMEOUT_MS);

      pendingMcp.set(requestId, { res, timer, deviceId, epoch });
      connection.ws.send(JSON.stringify({
        type: 'mcp_request',
        request_id: requestId,
        session_epoch: epoch,
        headers,
        body: requestBody,
      }));
      return;
    }

    json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      json(res, 413, { error: 'BODY_TOO_LARGE' });
      return;
    }
    console.error(error);
    json(res, 500, { error: 'INTERNAL_ERROR' });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/device') {
    socket.destroy();
    return;
  }

  const deviceId = String(url.searchParams.get('device_id') || '');
  const publicKey = String(url.searchParams.get('public_key') || '');
  if (!/^[a-f0-9]{24}$/.test(deviceId) || !publicKey || deviceIdFromPublicKey(publicKey) !== deviceId) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.orremote = { deviceId, publicKey, authenticated: false, sessionEpoch: null, challenge: null };
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const state = ws.orremote;
  const trusted = trustedDevices.get(state.deviceId);

  if (trusted) {
    if (trusted.publicKey !== state.publicKey) {
      ws.close(4001, 'public key mismatch');
      return;
    }
    beginChallenge(ws);
  } else {
    cleanupExpiredPairs();
    const code = createPairCode();
    pairingByCode.set(code, {
      deviceId: state.deviceId,
      publicKey: state.publicKey,
      ws,
      expiresAt: Date.now() + PAIR_TTL_MS,
    });
    ws.send(JSON.stringify({
      type: 'pairing_required',
      code,
      expires_in_seconds: Math.floor(PAIR_TTL_MS / 1000),
      device_id: state.deviceId,
    }));
  }

  ws.on('message', (raw) => handleDeviceMessage(ws, raw));
  ws.on('close', () => {
    const current = connectedDevices.get(state.deviceId);
    if (current?.ws === ws) {
      connectedDevices.delete(state.deviceId);
      cancelPendingForDevice(state.deviceId);
    }
    for (const [code, pending] of pairingByCode.entries()) {
      if (pending.ws === ws) pairingByCode.delete(code);
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  cleanupExpiredPairs();
  for (const { ws } of connectedDevices.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch {}
    }
  }
}, 25_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Ø Remote relay listening on ${HOST}:${PORT}`);
});
