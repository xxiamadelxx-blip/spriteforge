import http from 'node:http';

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}
function raw(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function unauthorized(res) { json(res, 401, { error: 'UNAUTHORIZED' }); }
function bearerToken(req) { const value = String(req.headers.authorization || ''); return value.startsWith('Bearer ') ? value.slice(7) : ''; }
function clientIp(req) { const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); return forwarded || req.socket.remoteAddress || 'unknown'; }
async function readBody(req, maxBodyBytes) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > maxBodyBytes) { const error = new Error('body too large'); error.code = 'BODY_TOO_LARGE'; throw error; } chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRelayServer(config, deviceRelay) {
  const pairAttempts = new Map();
  function cleanupPairAttempts() { const now = Date.now(); for (const [ip, value] of pairAttempts.entries()) if (value.resetAt <= now) pairAttempts.delete(ip); }
  function allowPairAttempt(req) {
    cleanupPairAttempts(); const key = clientIp(req); const now = Date.now(); const current = pairAttempts.get(key);
    if (!current || current.resetAt <= now) { pairAttempts.set(key, { count: 1, resetAt: now + config.pairAttemptWindowMs }); return true; }
    if (current.count >= config.maxPairAttemptsPerIp) return false; current.count += 1; return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, service: 'orremote-relay', auth_mode: 'stateless-signed-credentials-v1', connected_devices: deviceRelay.connectedDeviceCount(), pending_pairs: deviceRelay.pendingPairCount(), capability_ttl_seconds: Math.floor(config.capabilityTtlMs / 1000) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/pair/claim') {
        if (!allowPairAttempt(req)) { json(res, 429, { error: 'PAIR_RATE_LIMITED' }); return; }
        const body = JSON.parse(await readBody(req, config.maxBodyBytes) || '{}'); const claim = deviceRelay.claimPairing(String(body.code || ''));
        if (!claim) { json(res, 404, { error: 'PAIR_CODE_NOT_FOUND' }); return; }
        json(res, 200, { paired: true, device_id: claim.deviceId, pair_id: claim.pairId, pair_token: claim.pairToken, pair_token_expires_in_seconds: claim.pairTokenExpiresInSeconds, capability_token: claim.capabilityToken, capability_expires_in_seconds: claim.capabilityExpiresInSeconds }); return;
      }
      const exchangeMatch = url.pathname.match(/^\/token\/exchange\/([a-f0-9]{24})$/);
      if (req.method === 'POST' && exchangeMatch) {
        const deviceId = exchangeMatch[1]; let requestedScopes = ['presence', 'mcp']; const rawBody = await readBody(req, config.maxBodyBytes);
        if (rawBody.trim()) { const body = JSON.parse(rawBody); if (Array.isArray(body.scopes)) requestedScopes = body.scopes.map(String); }
        const exchange = deviceRelay.exchangePairCredential(deviceId, bearerToken(req), requestedScopes);
        if (!exchange) { unauthorized(res); return; }
        json(res, 200, { device_id: exchange.deviceId, pair_id: exchange.pairId, capability_token: exchange.capabilityToken, scopes: exchange.scopes, expires_in_seconds: exchange.expiresInSeconds }); return;
      }
      const presenceMatch = url.pathname.match(/^\/presence\/([a-f0-9]{24})$/);
      if (req.method === 'GET' && presenceMatch) {
        const deviceId = presenceMatch[1]; if (!deviceRelay.verifyCapability(bearerToken(req), deviceId, 'presence')) { unauthorized(res); return; }
        const presence = deviceRelay.presence(deviceId); json(res, 200, { device_id: presence.deviceId, connected: presence.connected, session_epoch: presence.sessionEpoch }); return;
      }
      const mcpMatch = url.pathname.match(/^\/mcp\/([a-f0-9]{24})$/);
      if (req.method === 'POST' && mcpMatch) {
        const deviceId = mcpMatch[1]; const capability = deviceRelay.verifyCapability(bearerToken(req), deviceId, 'mcp'); if (!capability) { unauthorized(res); return; }
        const body = await readBody(req, config.maxBodyBytes);
        const result = await deviceRelay.forwardMcp({ deviceId, pairId: capability.pair_id, headers: { 'mcp-protocol-version': req.headers['mcp-protocol-version'] || '', 'mcp-method': req.headers['mcp-method'] || '', 'mcp-name': req.headers['mcp-name'] || '', 'content-type': req.headers['content-type'] || 'application/json' }, body });
        raw(res, result.status, result.body, result.headers); return;
      }
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') { json(res, 413, { error: 'BODY_TOO_LARGE' }); return; }
      if (error?.code === 'DEVICE_TIMEOUT') { json(res, 504, { error: 'DEVICE_TIMEOUT' }); return; }
      if (error?.code === 'DEVICE_OFFLINE' || error?.code === 'DEVICE_DISCONNECTED' || error?.code === 'SESSION_SUPERSEDED') { json(res, 503, { error: error.code }); return; }
      console.error('request failed', error); json(res, 500, { error: 'INTERNAL_ERROR' });
    }
  });
  server.on('upgrade', (req, socket, head) => deviceRelay.handleUpgrade(req, socket, head));
  return server;
}
