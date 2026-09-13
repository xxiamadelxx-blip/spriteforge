import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 15000);
const PAIR_TTL_MS = Number(process.env.PAIR_TTL_MS || 10 * 60 * 1000);
const PAIR_CREDENTIAL_TTL_MS = Number(process.env.PAIR_CREDENTIAL_TTL_MS || 365 * 24 * 60 * 60 * 1000);
const CAPABILITY_TTL_MS = Number(process.env.CAPABILITY_TTL_MS || 10 * 60 * 1000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const PAIR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_PAIR_ATTEMPTS_PER_IP = 8;
const RELAY_TOKEN_SECRET = String(process.env.RELAY_TOKEN_SECRET || '');

if (Buffer.byteLength(RELAY_TOKEN_SECRET, 'utf8') < 32) {
  throw new Error('RELAY_TOKEN_SECRET must be configured with at least 32 bytes');
}

const pairingByCode = new Map();
const connectedDevices = new Map();
const pendingMcp = new Map();
const pairAttempts = new Map();
const lastEpochByDevice = new Map();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function unauthorized(res) {
  json(res, 401, { error: 'UNAUTHORIZED' });
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
  const der = Buffer.from(publicKeyDerBase64, 'base64');
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 24);
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
    if (value.expiresAt <= now) pairingByCode.delete(code);
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

function nextSessionEpoch(deviceId) {
  const wallClock = Date.now() * 1000 + crypto.randomInt(1000);
  const previous = Number(lastEpochByDevice.get(deviceId) || 0);
  const next = Math.max(wallClock, previous + 1);
  lastEpochByDevice.set(deviceId, next);
  return next;
}

function encodeCredential(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', RELAY_TOKEN_SECRET).update(body, 'utf8').digest('base64url');
  return `${body}.${signature}`;
}

function createCredential(deviceId, kind, ttlMs, scopes, pairId) {
  const now = Date.now();
  return encodeCredential({
    v: 1,
    kind,
    device_id: deviceId,
    pair_id: pairId,
    scopes,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: crypto.randomBytes(16).toString('base64url'),
  });
}

function verifyCredential(token, deviceId, kind, requiredScope = null) {
  const [body, signature, extra] = String(token || '').split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', RELAY_TOKEN_SECRET).update(body, 'utf8').digest('base64url');
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return null;
  if (payload?.kind !== kind) return null;
  if (payload?.device_id !== deviceId) return null;
  if (typeof payload?.pair_id !== 'string' || payload.pair_id.length < 16) return null;
  if (!Number.isInteger(payload?.iat) || payload.iat > nowSeconds + 60) return null;
  if (!Number.isInteger(payload?.exp) || payload.exp <= nowSeconds) return null;
  if (!Array.isArray(payload?.scopes)) return null;
  if (requiredScope && !payload.scopes.includes(requiredScope)) return null;
  return payload;
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function capabilityAuth(req, deviceId, scope) {
  return verifyCredential(bearerToken(req), deviceId, 'capability', scope);
}

function pairAuth(req, deviceId) {
  return verifyCredential(bearerToken(req), deviceId, 'pair', 'exchange');
}

function createCapabilityToken(deviceId, pairId, scopes = ['presence', 'mcp']) {
  return createCredential(deviceId, 'capability', CAPABILITY_TTL_MS, scopes, pairId);
}

function createPairCredential(deviceId, pairId) {
  return createCredential(deviceId, 'pair', PAIR_CREDENTIAL_TTL_MS, ['exchange'], pairId);
}

function authenticateSocket(ws, signatureBase64) {
  const state = ws.orremote;
  const nonce = state.challenge;
  if (!nonce) return false;
  const canonical = `orremote-m3|${state.deviceId}|${nonce}`;
  let valid = false;
  try {
    valid = crypto.verify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      publicKeyObject(state.publicKey),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return false;

  const previous = connectedDevices.get(state.deviceId);
  if (previous && previous.ws !== ws) {
    cancelPendingForDevice(state.deviceId, 'SESSION_SUPERSEDED');
    try { previous.ws.close(4000, 'superseded by new session'); } catch {}
  }

  const nextEpoch = nextSessionEpoch(state.deviceId);
  state.authenticated = true;
  state.sessionEpoch = nextEpoch;
  state.challenge = null;
  connectedDevices.set(state.deviceId, { ws, epoch: nextEpoch, connectedAt: Date.now() });
  ws.send(JSON.stringify({
    type: 'authenticated',
    device_id: state.deviceId,
    session_epoch: nextEpoch,
  }));

  if (!state.pairedHint) {
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
    if (!authenticateSocket(ws, String(message.signature || ''))) {
      ws.close(4001, 'authentication failed');
    }
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

  if (message.type === 'pong') return;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        service: 'orremote-relay',
        auth_mode: 'stateless-signed-credentials-v1',
        connected_devices: connectedDevices.size,
        pending_pairs: pairingByCode.size,
        capability_ttl_seconds: Math.floor(CAPABILITY_TTL_MS / 1000),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/pair/claim') {
      cleanupExpiredPairs();
      if (!allowPairAttempt(req)) {
        json(res, 429, { error: 'PAIR_RATE_LIMITED' });
        return;
      }
      const body = JSON.parse(await readBody(req) || '{}');
      const code = String(body.code || '');
      const pending = pairingByCode.get(code);
      if (!pending || pending.expiresAt <= Date.now()) {
        json(res, 404, { error: 'PAIR_CODE_NOT_FOUND' });
        return;
      }
      pairingByCode.delete(code);

      const pairId = crypto.randomBytes(16).toString('base64url');
      const pairToken = createPairCredential(pending.deviceId, pairId);
      const capabilityToken = createCapabilityToken(pending.deviceId, pairId);
      if (pending.ws.readyState === WebSocket.OPEN) {
        pending.ws.orremote.pairedHint = true;
        pending.ws.send(JSON.stringify({
          type: 'pairing_accepted',
          device_id: pending.deviceId,
          pair_id: pairId,
          session_epoch: pending.ws.orremote.sessionEpoch,
        }));
      }
      json(res, 200, {
        paired: true,
        device_id: pending.deviceId,
        pair_id: pairId,
        pair_token: pairToken,
        pair_token_expires_in_seconds: Math.floor(PAIR_CREDENTIAL_TTL_MS / 1000),
        capability_token: capabilityToken,
        capability_expires_in_seconds: Math.floor(CAPABILITY_TTL_MS / 1000),
      });
      return;
    }

    const exchangeMatch = url.pathname.match(/^\/token\/exchange\/([a-f0-9]{24})$/);
    if (req.method === 'POST' && exchangeMatch) {
      const deviceId = exchangeMatch[1];
      const pairCredential = pairAuth(req, deviceId);
      if (!pairCredential) return unauthorized(res);
      let requestedScopes = ['presence', 'mcp'];
      const rawBody = await readBody(req);
      if (rawBody.trim()) {
        const body = JSON.parse(rawBody);
        if (Array.isArray(body.scopes)) {
          const allowed = new Set(['presence', 'mcp']);
          requestedScopes = body.scopes.filter((scope) => allowed.has(scope));
          if (!requestedScopes.length) {
            json(res, 400, { error: 'NO_ALLOWED_SCOPES' });
            return;
          }
        }
      }
      json(res, 200, {
        device_id: deviceId,
        pair_id: pairCredential.pair_id,
        capability_token: createCapabilityToken(deviceId, pairCredential.pair_id, requestedScopes),
        scopes: requestedScopes,
        expires_in_seconds: Math.floor(CAPABILITY_TTL_MS / 1000),
      });
      return;
    }

    const presenceMatch = url.pathname.match(/^\/presence\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && presenceMatch) {
      const deviceId = presenceMatch[1];
      if (!capabilityAuth(req, deviceId, 'presence')) return unauthorized(res);
      const connected = connectedDevices.get(deviceId);
      json(res, 200, {
        device_id: deviceId,
        connected: Boolean(connected),
        session_epoch: connected?.epoch ?? null,
      });
      return;
    }

    const mcpMatch = url.pathname.match(/^\/mcp\/([a-f0-9]{24})$/);
    if (req.method === 'POST' && mcpMatch) {
      const deviceId = mcpMatch[1];
      const capability = capabilityAuth(req, deviceId, 'mcp');
      if (!capability) return unauthorized(res);
      const connection = connectedDevices.get(deviceId);
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
        json(res, 503, { error: 'DEVICE_OFFLINE' });
        return;
      }

      const body = await readBody(req);
      const requestId = crypto.randomUUID();
      const epoch = connection.epoch;
      const forwardedHeaders = {
        'mcp-protocol-version': req.headers['mcp-protocol-version'] || '',
        'mcp-method': req.headers['mcp-method'] || '',
        'mcp-name': req.headers['mcp-name'] || '',
        'content-type': req.headers['content-type'] || 'application/json',
      };

      const timer = setTimeout(() => {
        const pending = pendingMcp.get(requestId);
        if (!pending) return;
        pendingMcp.delete(requestId);
        json(res, 504, { error: 'DEVICE_TIMEOUT' });
      }, MCP_TIMEOUT_MS);

      pendingMcp.set(requestId, { res, timer, deviceId, epoch });
      connection.ws.send(JSON.stringify({
        type: 'mcp_request',
        request_id: requestId,
        session_epoch: epoch,
        pair_id: capability.pair_id,
        headers: forwardedHeaders,
        body,
      }));
      return;
    }

    json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      json(res, 413, { error: 'BODY_TOO_LARGE' });
      return;
    }
    console.error('request failed', error);
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
  const pairedHint = url.searchParams.get('paired') === '1';
  if (!/^[a-f0-9]{24}$/.test(deviceId) || !publicKey || deviceIdFromPublicKey(publicKey) !== deviceId) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.orremote = {
      deviceId,
      publicKey,
      pairedHint,
      authenticated: false,
      sessionEpoch: null,
      challenge: null,
    };
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const state = ws.orremote;
  beginChallenge(ws);

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
