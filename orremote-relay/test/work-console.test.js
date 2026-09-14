import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/server.js';

function config() {
  return {
    publicOrigin: 'https://orremote-relay.onrender.com',
    mcpResource: 'https://orremote-relay.onrender.com/mcp',
    oauthIssuer: 'https://orremote-relay.onrender.com',
    relayTokenSecret: 'w'.repeat(64),
    mcpTimeoutMs: 1000,
    pairTtlMs: 600000,
    pairCredentialTtlMs: 31536000000,
    capabilityTtlMs: 600000,
    oauthCodeTtlMs: 300000,
    oauthAccessTtlMs: 600000,
    oauthRefreshTtlMs: 2592000000,
    maxBodyBytes: 1024 * 1024,
    pairAttemptWindowMs: 600000,
    maxPairAttemptsPerIp: 8,
    allowedClientId: '',
    allowedRedirectUris: [],
    workSessionTtlMs: 60 * 60 * 1000,
  };
}

function fakeDeviceRelay() {
  const calls = [];
  return {
    calls,
    handleUpgrade() {},
    connectedDeviceCount: () => 1,
    pendingPairCount: () => 1,
    claimPairing(code) {
      if (code !== '12345678') return null;
      return {
        deviceId: 'a'.repeat(24),
        pairId: 'pair-generation-1234567890',
        pairToken: 'unused',
        capabilityToken: 'unused',
        pairTokenExpiresInSeconds: 3600,
        capabilityExpiresInSeconds: 600,
      };
    },
    verifyCapability() { return null; },
    exchangePairCredential() { return null; },
    presence(deviceId) { return { deviceId, connected: true, sessionEpoch: 99 }; },
    async forwardMcp(request) {
      const body = JSON.parse(request.body);
      calls.push({ request, body });
      const tool = body.params?.name;
      if (tool === 'screen.observe') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: body.id,
            result: {
              content: [{ type: 'text', text: 'Observed demo screen' }],
              structuredContent: {
                status: 'OK', revision: 42, package: 'com.example.demo', activity: '.MainActivity',
                fingerprint: 'demo-fingerprint', node_count: 2, truncated: false,
                nodes: [
                  { handle: 'h1', text: 'Refresh', content_description: null, resource_id: 'com.example:id/refresh', class_name: 'android.widget.Button', bounds: { left: 10, top: 20, right: 210, bottom: 100 }, clickable: true, enabled: true, editable: false, depth: 2 },
                  { handle: 'h2', text: null, content_description: 'Search', resource_id: 'com.example:id/search', class_name: 'android.widget.EditText', bounds: { left: 10, top: 120, right: 500, bottom: 200 }, clickable: true, enabled: true, editable: true, depth: 2 },
                ],
              },
              isError: false,
            },
          }),
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: {
            content: [{ type: 'text', text: `${tool} verified` }],
            structuredContent: { status: 'VERIFIED', before_revision: 42, after_revision: 43, verified_change: true },
            isError: false,
          },
        }),
      };
    },
  };
}

async function start() {
  const relay = fakeDeviceRelay();
  const server = createRelayServer(config(), relay);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return { relay, server, base: `http://127.0.0.1:${address.port}` };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  return match?.[1] || '';
}

test('Work console pairs with short-lived secure HttpOnly session and renders semantic Android state', async (t) => {
  const env = await start();
  t.after(() => env.server.close());

  const login = await fetch(`${env.base}/work`);
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.match(loginHtml, /Pair this browser with Ø Remote/);

  const paired = await fetch(`${env.base}/work/pair`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pairing_code: '12345678' }),
  });
  assert.equal(paired.status, 303);
  assert.equal(paired.headers.get('location'), '/work');
  const setCookie = paired.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/work/i);
  const cookie = cookieFrom(paired);
  assert.ok(cookie.startsWith('orremote_work='));

  const page = await fetch(`${env.base}/work`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /com\.example\.demo/);
  assert.match(html, /revision 42/i);
  assert.match(html, /Refresh/);
  assert.match(html, /Search/);
  assert.ok(hidden(html, 'csrf'));
  assert.equal(env.relay.calls.at(-1).body.params.name, 'screen.observe');
});

test('Work console rejects write action without CSRF and forwards semantic click with revision when valid', async (t) => {
  const env = await start();
  t.after(() => env.server.close());

  const paired = await fetch(`${env.base}/work/pair`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pairing_code: '12345678' }),
  });
  const cookie = cookieFrom(paired);
  const page = await fetch(`${env.base}/work`, { headers: { cookie } });
  const html = await page.text();
  const csrf = hidden(html, 'csrf');
  const before = env.relay.calls.length;

  const denied = await fetch(`${env.base}/work/click`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ expected_revision: '42', selector_kind: 'RESOURCE_ID', selector_value: 'com.example:id/refresh', exact: 'true' }),
  });
  assert.equal(denied.status, 403);
  assert.equal(env.relay.calls.length, before);

  const ok = await fetch(`${env.base}/work/click`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, expected_revision: '42', selector_kind: 'RESOURCE_ID', selector_value: 'com.example:id/refresh', exact: 'true' }),
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/work');
  const forwarded = env.relay.calls.at(-1);
  assert.equal(forwarded.request.deviceId, 'a'.repeat(24));
  assert.equal(forwarded.request.pairId, 'pair-generation-1234567890');
  assert.equal(forwarded.body.params.name, 'ui.click');
  assert.deepEqual(forwarded.body.params.arguments, {
    expected_revision: 42,
    selector_kind: 'RESOURCE_ID',
    selector_value: 'com.example:id/refresh',
    exact: true,
  });
});

test('Work console fails closed on tampered session cookie', async (t) => {
  const env = await start();
  t.after(() => env.server.close());

  const response = await fetch(`${env.base}/work`, { headers: { cookie: 'orremote_work=forged.invalid' } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Pair this browser with Ø Remote/);
  assert.equal(env.relay.calls.length, 0);
});
