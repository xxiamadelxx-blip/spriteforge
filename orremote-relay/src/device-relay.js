import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createCredential, verifyCredential } from './credentials.js';

function relayError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function deviceIdFromPublicKey(publicKeyDerBase64) {
  const der = Buffer.from(publicKeyDerBase64, 'base64');
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 24);
}

function publicKeyObject(publicKeyDerBase64) {
  return crypto.createPublicKey({
    key: Buffer.from(publicKeyDerBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

export function createDeviceRelay(config) {
  const pairingByCode = new Map();
  const connectedDevices = new Map();
  const pendingMcp = new Map();
  const lastEpochByDevice = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxBodyBytes });

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
  }

  function nextSessionEpoch(deviceId) {
    const wallClock = Date.now() * 1000 + crypto.randomInt(1000);
    const previous = Number(lastEpochByDevice.get(deviceId) || 0);
    const next = Math.max(wallClock, previous + 1);
    lastEpochByDevice.set(deviceId, next);
    return next;
  }

  function createPairCredential(deviceId, pairId) {
    return createCredential(config, {
      kind: 'pair', device_id: deviceId, pair_id: pairId, scopes: ['exchange'], ttlMs: config.pairCredentialTtlMs,
    });
  }

  function createCapabilityToken(deviceId, pairId, scopes = ['presence', 'mcp']) {
    return createCredential(config, {
      kind: 'capability', device_id: deviceId, pair_id: pairId, scopes, ttlMs: config.capabilityTtlMs,
    });
  }

  function verifyPairCredential(token, deviceId) {
    const payload = verifyCredential(config, token, { kind: 'pair', deviceId, requiredScope: 'exchange' });
    if (!payload || typeof payload.pair_id !== 'string' || payload.pair_id.length < 16) return null;
    return payload;
  }

  function verifyCapability(token, deviceId, requiredScope) {
    const payload = verifyCredential(config, token, { kind: 'capability', deviceId, requiredScope });
    if (!payload || typeof payload.pair_id !== 'string' || payload.pair_id.length < 16) return null;
    return payload;
  }

  function cancelPendingForDevice(deviceId, reason = 'DEVICE_DISCONNECTED') {
    for (const [requestId, pending] of pendingMcp.entries()) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timer);
      pendingMcp.delete(requestId);
      pending.reject(relayError(reason, 503));
    }
  }

  function beginChallenge(ws) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    ws.orremote.challenge = nonce;
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
  }

  function authenticateSocket(ws, signatureBase64) {
    const state = ws.orremote;
    const nonce = state.challenge;
    if (!nonce) return false;
    const canonical = `orremote-m3|${state.deviceId}|${nonce}`;
    let valid = false;
    try {
      valid = crypto.verify('sha256', Buffer.from(canonical, 'utf8'), publicKeyObject(state.publicKey), Buffer.from(signatureBase64, 'base64'));
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
    ws.send(JSON.stringify({ type: 'authenticated', device_id: state.deviceId, session_epoch: nextEpoch }));

    if (!state.pairedHint) {
      cleanupExpiredPairs();
      const code = createPairCode();
      pairingByCode.set(code, { deviceId: state.deviceId, publicKey: state.publicKey, ws, expiresAt: Date.now() + config.pairTtlMs });
      ws.send(JSON.stringify({ type: 'pairing_required', code, expires_in_seconds: Math.floor(config.pairTtlMs / 1000), device_id: state.deviceId }));
    }
    return true;
  }

  function handleDeviceMessage(ws, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { ws.close(4002, 'invalid json'); return; }
    const state = ws.orremote;
    if (message.type === 'challenge_response') {
      if (!authenticateSocket(ws, String(message.signature || ''))) ws.close(4001, 'authentication failed');
      return;
    }
    if (!state.authenticated) { ws.close(4001, 'authentication required'); return; }
    if (message.type === 'mcp_response') {
      const requestId = String(message.request_id || '');
      const pending = pendingMcp.get(requestId);
      if (!pending) return;
      if (pending.deviceId !== state.deviceId || pending.epoch !== state.sessionEpoch) return;
      if (Number(message.session_epoch) !== state.sessionEpoch) return;
      clearTimeout(pending.timer);
      pendingMcp.delete(requestId);
      const body = typeof message.body === 'string' ? message.body : JSON.stringify(message.body ?? {});
      pending.resolve({ status: Number(message.status || 200), body, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      return;
    }
    if (message.type === 'pong') return;
  }

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { socket.destroy(); return; }
    if (url.pathname !== '/device') { socket.destroy(); return; }
    const deviceId = String(url.searchParams.get('device_id') || '');
    const publicKey = String(url.searchParams.get('public_key') || '');
    const pairedHint = url.searchParams.get('paired') === '1';
    if (!/^[a-f0-9]{24}$/.test(deviceId) || !publicKey || deviceIdFromPublicKey(publicKey) !== deviceId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.orremote = { deviceId, publicKey, pairedHint, authenticated: false, sessionEpoch: null, challenge: null };
      wss.emit('connection', ws, req);
    });
  }

  wss.on('connection', (ws) => {
    const state = ws.orremote;
    beginChallenge(ws);
    ws.on('message', (raw) => handleDeviceMessage(ws, raw));
    ws.on('close', () => {
      const current = connectedDevices.get(state.deviceId);
      if (current?.ws === ws) { connectedDevices.delete(state.deviceId); cancelPendingForDevice(state.deviceId); }
      for (const [code, pending] of pairingByCode.entries()) if (pending.ws === ws) pairingByCode.delete(code);
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    cleanupExpiredPairs();
    for (const { ws } of connectedDevices.values()) {
      if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch {}
    }
  }, 25_000);
  heartbeat.unref();

  function claimPairing(code) {
    cleanupExpiredPairs();
    const pending = pairingByCode.get(String(code || ''));
    if (!pending || pending.expiresAt <= Date.now()) return null;
    pairingByCode.delete(String(code || ''));
    const pairId = crypto.randomBytes(16).toString('base64url');
    const pairToken = createPairCredential(pending.deviceId, pairId);
    const capabilityToken = createCapabilityToken(pending.deviceId, pairId);
    if (pending.ws.readyState === WebSocket.OPEN) {
      pending.ws.orremote.pairedHint = true;
      pending.ws.send(JSON.stringify({ type: 'pairing_accepted', device_id: pending.deviceId, pair_id: pairId, session_epoch: pending.ws.orremote.sessionEpoch }));
    }
    return { deviceId: pending.deviceId, pairId, pairToken, capabilityToken, pairTokenExpiresInSeconds: Math.floor(config.pairCredentialTtlMs / 1000), capabilityExpiresInSeconds: Math.floor(config.capabilityTtlMs / 1000) };
  }

  function exchangePairCredential(deviceId, token, requestedScopes = ['presence', 'mcp']) {
    const pair = verifyPairCredential(token, deviceId);
    if (!pair) return null;
    const allowed = new Set(['presence', 'mcp']);
    const scopes = requestedScopes.filter((scope) => allowed.has(scope));
    if (!scopes.length) return null;
    return { deviceId, pairId: pair.pair_id, scopes, capabilityToken: createCapabilityToken(deviceId, pair.pair_id, scopes), expiresInSeconds: Math.floor(config.capabilityTtlMs / 1000) };
  }

  function presence(deviceId) {
    const connected = connectedDevices.get(deviceId);
    return { deviceId, connected: Boolean(connected), sessionEpoch: connected?.epoch ?? null };
  }

  function forwardMcp({ deviceId, pairId, headers, body }) {
    const connection = connectedDevices.get(deviceId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return Promise.reject(relayError('DEVICE_OFFLINE', 503));
    const requestId = crypto.randomUUID();
    const epoch = connection.epoch;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingMcp.get(requestId);
        if (!pending) return;
        pendingMcp.delete(requestId);
        reject(relayError('DEVICE_TIMEOUT', 504));
      }, config.mcpTimeoutMs);
      pendingMcp.set(requestId, { resolve, reject, timer, deviceId, epoch });
      try {
        connection.ws.send(JSON.stringify({ type: 'mcp_request', request_id: requestId, session_epoch: epoch, pair_id: pairId, headers, body }));
      } catch (error) {
        clearTimeout(timer); pendingMcp.delete(requestId); reject(relayError(error?.message || 'DEVICE_SEND_FAILED', 503));
      }
    });
  }

  return { handleUpgrade, claimPairing, exchangePairCredential, verifyCapability, presence, forwardMcp, connectedDeviceCount: () => connectedDevices.size, pendingPairCount: () => pairingByCode.size };
}
