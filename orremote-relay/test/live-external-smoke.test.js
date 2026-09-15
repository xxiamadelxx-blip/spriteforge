import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const RUN_LIVE = process.env.RUN_LIVE_EXTERNAL_SMOKE === '1';
const ORIGIN = String(process.env.LIVE_RELAY_ORIGIN || 'https://orremote-relay.onrender.com').replace(/\/+$/, '');
const WS_ORIGIN = ORIGIN.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const MCP_RESOURCE = `${ORIGIN}/mcp`;

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKey: der.toString('base64'),
    deviceId: crypto.createHash('sha256').update(der).digest('hex').slice(0, 24),
  };
}

function sign(privateKey, deviceId, nonce) {
  return crypto.sign('sha256', Buffer.from(`orremote-m3|${deviceId}|${nonce}`, 'utf8'), privateKey).toString('base64');
}

function queueFor(ws) {
  const queued = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  });
  ws.on('error', (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  return {
    next(timeoutMs = 10_000) {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for live relay websocket message'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

async function connectVirtualAndroid(id) {
  const params = new URLSearchParams({ device_id: id.deviceId, public_key: id.publicKey, paired: '0' });
  const ws = new WebSocket(`${WS_ORIGIN}/device?${params}`);
  const queue = queueFor(ws);
  await once(ws, 'open');
  const challenge = await queue.next();
  assert.equal(challenge.type, 'challenge');
  ws.send(JSON.stringify({ type: 'challenge_response', signature: sign(id.privateKey, id.deviceId, challenge.nonce) }));
  const authenticated = await queue.next();
  assert.equal(authenticated.type, 'authenticated');
  assert.equal(authenticated.device_id, id.deviceId);
  const pairing = await queue.next();
  assert.equal(pairing.type, 'pairing_required');
  assert.match(pairing.code, /^\d{8}$/);
  return { ws, queue, epoch: authenticated.session_epoch, pairingCode: pairing.code };
}

async function authorize(pairingCode) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: MCP_RESOURCE,
    scope: 'android.observe android.control',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  const page = await fetch(`${ORIGIN}/oauth/authorize?${query}`, { redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  const requestToken = html.match(/name="request_token" value="([^"]+)"/)?.[1];
  assert.ok(requestToken, 'authorization page must contain signed request_token');

  const approval = await fetch(`${ORIGIN}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_token: requestToken, pairing_code: pairingCode }),
  });
  assert.equal(approval.status, 302);
  const redirect = new URL(approval.headers.get('location'));
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URI);
  assert.equal(redirect.searchParams.get('state'), state);
  assert.equal(redirect.searchParams.get('iss'), ORIGIN);
  const code = redirect.searchParams.get('code');
  assert.ok(code);

  const token = await fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      resource: MCP_RESOURCE,
    }),
  });
  assert.equal(token.status, 200);
  const body = await token.json();
  assert.equal(body.token_type, 'Bearer');
  assert.ok(body.access_token);
  assert.ok(body.refresh_token);
  return body.access_token;
}

test('live public relay completes WSS pairing, OAuth PKCE and official MCP call', {
  skip: !RUN_LIVE,
  timeout: 45_000,
}, async (t) => {
  const health = await fetch(`${ORIGIN}/health?live_smoke=${Date.now()}`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.mcp_plugin, true);
  assert.equal(healthBody.oauth_configured, true);

  const id = identity();
  const device = await connectVirtualAndroid(id);
  t.after(() => { try { device.ws.close(); } catch {} });

  const tokenPromise = authorize(device.pairingCode);
  const accepted = await device.queue.next();
  assert.equal(accepted.type, 'pairing_accepted');
  assert.equal(accepted.device_id, id.deviceId);
  assert.ok(accepted.pair_id);
  const token = await tokenPromise;

  const client = new Client(
    { name: 'orremote-live-smoke', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'screen.observe', 'ui.click', 'ui.set_text', 'touch.tap', 'touch.swipe',
    'system.back', 'system.home', 'screen.screenshot', 'app.list', 'app.launch', 'skill.run',
  ]);

  const call = client.callTool({ name: 'screen.observe', arguments: {} });
  const forwarded = await device.queue.next();
  assert.equal(forwarded.type, 'mcp_request');
  assert.equal(forwarded.session_epoch, device.epoch);
  assert.equal(forwarded.pair_id, accepted.pair_id);
  assert.equal(forwarded.headers?.['mcp-method'], 'tools/call');
  assert.equal(forwarded.headers?.['mcp-name'], 'screen.observe');
  const forwardedBody = JSON.parse(forwarded.body);
  assert.equal(forwardedBody.method, 'tools/call');
  assert.equal(forwardedBody.params?.name, 'screen.observe');

  device.ws.send(JSON.stringify({
    type: 'mcp_response',
    request_id: forwarded.request_id,
    session_epoch: device.epoch,
    status: 200,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: forwardedBody.id,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'live virtual Android observed' }],
        structuredContent: {
          status: 'VERIFIED',
          revision: 9001,
          package: 'com.zeroremote.live.smoke',
          fingerprint: 'live-smoke-fingerprint',
          nodes: [],
        },
        isError: false,
      },
    }),
  }));

  const observed = await call;
  assert.equal(observed.isError, false);
  assert.equal(observed.structuredContent?.revision, 9001);
  assert.equal(observed.structuredContent?.status, 'VERIFIED');
});
