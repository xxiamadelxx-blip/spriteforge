import fs from 'node:fs';
import http from 'node:http';
import { createOAuthService } from './oauth.js';
import { createMcpPluginHandler } from './mcp-plugin.js';
import { createWorkConsole } from './work-console.js';

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function raw(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
  });
  res.end();
}

function seeOther(res, location, extraHeaders = {}) {
  res.writeHead(303, {
    location,
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end();
}

function unauthorized(res) {
  json(res, 401, { error: 'UNAUTHORIZED' });
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

async function readBody(req, maxBodyBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req, maxBodyBytes) {
  return new URLSearchParams(await readBody(req, maxBodyBytes));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPairingForm(requestToken) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ChatGPT to Ø Remote</title>
<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;background:#111;color:#f5f5f5}
main{border:1px solid #444;border-radius:16px;padding:1.5rem;background:#1a1a1a}
h1{font-size:1.4rem;margin-top:0}p{line-height:1.5;color:#ccc}label{display:block;margin:1rem 0 .4rem;font-weight:600}input{box-sizing:border-box;width:100%;font:inherit;font-size:1.4rem;letter-spacing:.15em;padding:.8rem;border-radius:10px;border:1px solid #666;background:#0d0d0d;color:#fff}button{margin-top:1rem;width:100%;padding:.85rem;border:0;border-radius:10px;font:inherit;font-weight:700;cursor:pointer}.fine{font-size:.85rem;color:#999}</style>
</head>
<body><main>
<h1>Connect ChatGPT to Ø Remote</h1>
<p>Enter the current 8-digit pairing code shown by Ø Remote on your Android phone. This links this ChatGPT connection to the phone's current pairing generation.</p>
<form method="post" action="/oauth/authorize" autocomplete="off">
<input type="hidden" name="request_token" value="${escapeHtml(requestToken)}">
<label for="pairing_code">Pairing code</label>
<input id="pairing_code" name="pairing_code" inputmode="numeric" pattern="[0-9]{8}" minlength="8" maxlength="8" autocomplete="one-time-code" required autofocus>
<button type="submit">Connect</button>
</form>
<p class="fine">PINs, biometrics, OTP, CAPTCHA and payment confirmation are not delegated by this connection.</p>
</main></body></html>`;
}

function oauthErrorResponse(res, error, status = 400) {
  const code = String(error?.message || 'invalid_request');
  const allowed = new Set([
    'invalid_request',
    'invalid_client',
    'invalid_redirect_uri',
    'invalid_resource',
    'invalid_scope',
    'invalid_grant',
    'unsupported_response_type',
    'unsupported_grant_type',
    'PKCE S256 required',
    'invalid_pairing_code',
  ]);
  json(res, status, { error: allowed.has(code) ? code : 'invalid_request' }, { pragma: 'no-cache' });
}

export function createRelayServer(config, deviceRelay, commandBus = null) {
  const pairAttempts = new Map();
  const oauth = createOAuthService({ config, deviceRelay });
  const mcpPluginHandler = createMcpPluginHandler({ config, oauth, deviceRelay });
  const work = createWorkConsole({ config, deviceRelay });

  async function registerPairWithBus(claim) {
    if (!commandBus?.enabled) return true;
    try {
      return await commandBus.registerPair({ deviceId: claim.deviceId, pairId: claim.pairId });
    } catch (error) {
      console.error('Supabase pair registration failed', error?.message || error);
      return false;
    }
  }

  function cleanupPairAttempts() {
    const now = Date.now();
    for (const [ip, value] of pairAttempts.entries()) {
      if (value.resetAt <= now) pairAttempts.delete(ip);
    }
  }

  function allowPairAttempt(req) {
    cleanupPairAttempts();
    const key = clientIp(req);
    const now = Date.now();
    const current = pairAttempts.get(key);
    if (!current || current.resetAt <= now) {
      pairAttempts.set(key, { count: 1, resetAt: now + config.pairAttemptWindowMs });
      return true;
    }
    if (current.count >= config.maxPairAttemptsPerIp) return false;
    current.count += 1;
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, {
          ok: true,
          service: 'orremote-relay',
          auth_mode: 'stateless-signed-credentials-v1',
          connected_devices: deviceRelay.connectedDeviceCount(),
          pending_pairs: deviceRelay.pendingPairCount(),
          pending_artifacts: deviceRelay.pendingArtifactCount?.() ?? 0,
          staged_artifacts: deviceRelay.stagedArtifactCount?.() ?? 0,
          capability_ttl_seconds: Math.floor(config.capabilityTtlMs / 1000),
          artifact_download_ttl_seconds: Math.floor(config.artifactDownloadTtlMs / 1000),
          mcp_plugin: true,
          oauth_configured: Boolean(config.allowedClientId && config.allowedRedirectUris.length),
          work_console: true,
          supabase_bus: Boolean(commandBus?.enabled),
        });
        return;
      }

      const downloadMatch = url.pathname.match(/^\/artifacts\/([^/]+)$/);
      if (req.method === 'GET' && downloadMatch) {
        const token = decodeURIComponent(downloadMatch[1]);
        if (token.length > 4096) {
          json(res, 401, { error: 'ARTIFACT_TOKEN_INVALID' });
          return;
        }
        const stage = deviceRelay.openArtifactDownload(token);
        res.writeHead(200, {
          'content-type': stage.mimeType,
          'content-length': stage.byteSize,
          'cache-control': 'private, no-store',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
          'content-disposition': stage.mimeType === 'image/png' ? 'inline' : `attachment; filename="${stage.artifactId}.json"`,
        });
        let consumed = false;
        res.once('finish', () => {
          if (consumed) return;
          consumed = true;
          deviceRelay.consumeArtifactStage(stage.stageId);
        });
        const stream = fs.createReadStream(stage.filePath);
        stream.on('error', () => {
          if (!res.headersSent) json(res, 404, { error: 'ARTIFACT_NOT_FOUND' });
          else res.destroy();
        });
        stream.pipe(res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/work') {
        const session = work.sessionFromCookie(req.headers.cookie);
        if (!session) {
          html(res, 200, work.renderPairing());
          return;
        }
        html(res, 200, await work.renderSession(session));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/work/pair') {
        if (!allowPairAttempt(req)) {
          html(res, 429, work.renderPairing('Too many pairing attempts. Wait and request a new code if needed.'));
          return;
        }
        const form = await readForm(req, config.maxBodyBytes);
        const pairingCode = String(form.get('pairing_code') || '');
        if (!/^\d{8}$/.test(pairingCode)) {
          html(res, 400, work.renderPairing('Pairing code must contain exactly 8 digits.'));
          return;
        }
        const claim = deviceRelay.claimPairing(pairingCode);
        if (!claim) {
          html(res, 400, work.renderPairing('Pairing code is invalid or expired.'));
          return;
        }
        await registerPairWithBus(claim);
        const session = work.createSession(claim);
        seeOther(res, '/work', { 'set-cookie': work.sessionCookie(session.token) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/work/click') {
        const session = work.sessionFromCookie(req.headers.cookie);
        if (!session) {
          html(res, 401, work.renderPairing('Work session expired. Pair this browser again.'));
          return;
        }
        const form = await readForm(req, config.maxBodyBytes);
        if (!work.csrfMatches(session, String(form.get('csrf') || ''))) {
          json(res, 403, { error: 'CSRF_INVALID' });
          return;
        }
        const args = work.parseClickForm(form);
        if (!args) {
          json(res, 400, { error: 'INVALID_WORK_ACTION' });
          return;
        }
        await work.callTool(session, 'ui.click', args);
        seeOther(res, '/work');
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
        json(res, 200, oauth.protectedResourceMetadata());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        json(res, 200, oauth.authorizationServerMetadata());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        try {
          const request = oauth.validateAuthorizeRequest(url);
          const requestToken = oauth.sealAuthorizeRequest(request);
          html(res, 200, renderPairingForm(requestToken));
        } catch (error) {
          oauthErrorResponse(res, error);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
        if (!allowPairAttempt(req)) {
          oauthErrorResponse(res, new Error('invalid_pairing_code'), 429);
          return;
        }
        const form = await readForm(req, config.maxBodyBytes);
        try {
          const location = oauth.completeAuthorization({
            requestToken: String(form.get('request_token') || ''),
            pairingCode: String(form.get('pairing_code') || ''),
          });
          redirect(res, location);
        } catch (error) {
          oauthErrorResponse(res, error);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        const form = await readForm(req, config.maxBodyBytes);
        const grantType = String(form.get('grant_type') || '');
        try {
          let tokens;
          if (grantType === 'authorization_code') {
            tokens = oauth.exchangeAuthorizationCode({
              code: String(form.get('code') || ''),
              codeVerifier: String(form.get('code_verifier') || ''),
              clientId: String(form.get('client_id') || ''),
              redirectUri: String(form.get('redirect_uri') || ''),
              resource: String(form.get('resource') || ''),
            });
          } else if (grantType === 'refresh_token') {
            tokens = oauth.refresh({
              refreshToken: String(form.get('refresh_token') || ''),
              clientId: String(form.get('client_id') || ''),
              resource: String(form.get('resource') || ''),
              scope: form.has('scope') ? String(form.get('scope') || '') : null,
            });
          } else {
            throw new Error('unsupported_grant_type');
          }
          json(res, 200, tokens, { pragma: 'no-cache' });
        } catch (error) {
          oauthErrorResponse(res, error);
        }
        return;
      }

      if (url.pathname === '/mcp') {
        await mcpPluginHandler(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pair/claim') {
        if (!allowPairAttempt(req)) {
          json(res, 429, { error: 'PAIR_RATE_LIMITED' });
          return;
        }
        const body = JSON.parse(await readBody(req, config.maxBodyBytes) || '{}');
        const claim = deviceRelay.claimPairing(String(body.code || ''));
        if (!claim) {
          json(res, 404, { error: 'PAIR_CODE_NOT_FOUND' });
          return;
        }
        await registerPairWithBus(claim);
        json(res, 200, {
          paired: true,
          device_id: claim.deviceId,
          pair_id: claim.pairId,
          pair_token: claim.pairToken,
          pair_token_expires_in_seconds: claim.pairTokenExpiresInSeconds,
          capability_token: claim.capabilityToken,
          capability_expires_in_seconds: claim.capabilityExpiresInSeconds,
        });
        return;
      }

      const exchangeMatch = url.pathname.match(/^\/token\/exchange\/([a-f0-9]{24})$/);
      if (req.method === 'POST' && exchangeMatch) {
        const deviceId = exchangeMatch[1];
        let requestedScopes = ['presence', 'mcp'];
        const rawBody = await readBody(req, config.maxBodyBytes);
        if (rawBody.trim()) {
          const body = JSON.parse(rawBody);
          if (Array.isArray(body.scopes)) {
            const allowed = new Set(['presence', 'mcp']);
            requestedScopes = body.scopes.map(String).filter((scope) => allowed.has(scope));
            if (!requestedScopes.length) {
              json(res, 400, { error: 'NO_ALLOWED_SCOPES' });
              return;
            }
          }
        }
        const exchange = deviceRelay.exchangePairCredential(deviceId, bearerToken(req), requestedScopes);
        if (!exchange) {
          unauthorized(res);
          return;
        }
        json(res, 200, {
          device_id: exchange.deviceId,
          pair_id: exchange.pairId,
          capability_token: exchange.capabilityToken,
          scopes: exchange.scopes,
          expires_in_seconds: exchange.expiresInSeconds,
        });
        return;
      }

      const presenceMatch = url.pathname.match(/^\/presence\/([a-f0-9]{24})$/);
      if (req.method === 'GET' && presenceMatch) {
        const deviceId = presenceMatch[1];
        if (!deviceRelay.verifyCapability(bearerToken(req), deviceId, 'presence')) {
          unauthorized(res);
          return;
        }
        const presence = deviceRelay.presence(deviceId);
        json(res, 200, {
          device_id: presence.deviceId,
          connected: presence.connected,
          session_epoch: presence.sessionEpoch,
        });
        return;
      }

      const artifactRequestMatch = url.pathname.match(/^\/artifact\/request\/([a-f0-9]{24})$/);
      if (req.method === 'POST' && artifactRequestMatch) {
        const deviceId = artifactRequestMatch[1];
        const capability = deviceRelay.verifyCapability(bearerToken(req), deviceId, 'mcp');
        if (!capability) {
          unauthorized(res);
          return;
        }
        const body = JSON.parse(await readBody(req, config.maxBodyBytes) || '{}');
        const artifactId = String(body.artifact_id || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId)) {
          json(res, 400, { error: 'INVALID_ARTIFACT_ID' });
          return;
        }
        const artifact = await deviceRelay.requestArtifact({
          deviceId,
          pairId: capability.pair_id,
          artifactId,
        });
        json(res, 200, {
          artifact_id: artifact.artifactId,
          mime_type: artifact.mimeType,
          byte_size: artifact.byteSize,
          sha256: artifact.sha256,
          expires_at: new Date(artifact.expiresAt).toISOString(),
          download_url: `${config.publicOrigin}/artifacts/${encodeURIComponent(artifact.downloadToken)}`,
        });
        return;
      }

      const mcpMatch = url.pathname.match(/^\/mcp\/([a-f0-9]{24})$/);
      if (req.method === 'POST' && mcpMatch) {
        const deviceId = mcpMatch[1];
        const capability = deviceRelay.verifyCapability(bearerToken(req), deviceId, 'mcp');
        if (!capability) {
          unauthorized(res);
          return;
        }
        const body = await readBody(req, config.maxBodyBytes);
        const result = await deviceRelay.forwardMcp({
          deviceId,
          pairId: capability.pair_id,
          headers: {
            'mcp-protocol-version': req.headers['mcp-protocol-version'] || '',
            'mcp-method': req.headers['mcp-method'] || '',
            'mcp-name': req.headers['mcp-name'] || '',
            'content-type': req.headers['content-type'] || 'application/json',
          },
          body,
        });
        raw(res, result.status, result.body, result.headers);
        return;
      }

      json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        json(res, 413, { error: 'BODY_TOO_LARGE' });
        return;
      }
      if (error?.code === 'DEVICE_TIMEOUT') {
        json(res, 504, { error: 'DEVICE_TIMEOUT' });
        return;
      }
      if (error?.code === 'DEVICE_OFFLINE' || error?.code === 'DEVICE_DISCONNECTED' || error?.code === 'SESSION_SUPERSEDED') {
        json(res, 503, { error: error.code });
        return;
      }
      if (String(error?.code || '').startsWith('ARTIFACT_')) {
        json(res, Number(error.status || 400), { error: error.code });
        return;
      }
      console.error('request failed', error);
      json(res, 500, { error: 'INTERNAL_ERROR' });
    }
  });

  server.on('upgrade', (req, socket, head) => deviceRelay.handleUpgrade(req, socket, head));
  return server;
}
