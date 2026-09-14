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
  return {
    handleUpgrade() {},
    connectedDeviceCount: () => 1,
    pendingPairCount: () => 1,
    claimPairing(code) {
      if (code !== '12345678') return null;
      return {
        deviceId: 'a'.repeat(24),
        pairId: 'pair-generation-auth-test',
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
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'Authorization surface detected' }],
            structuredContent: {
              status: 'OK',
              revision: 77,
              package: 'com.example.auth',
              authorization_required: true,
              privacy_mode: 'USER_AUTH_REDACTED',
              node_count: 1,
              nodes: [{
                handle: 's1',
                text: 'SHOULD_NOT_RENDER',
                content_description: 'SHOULD_NOT_RENDER',
                resource_id: 'com.example:id/password',
                class_name: 'android.widget.EditText',
                clickable: true,
                enabled: true,
                editable: true,
                sensitive: true,
                depth: 2,
              }],
            },
            isError: false,
          },
        }),
      };
    },
  };
}

async function start() {
  const server = createRelayServer(config(), fakeDeviceRelay());
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

test('Work console hands authorization to the user and renders no protected controls or text', async (t) => {
  const env = await start();
  t.after(() => env.server.close());

  const paired = await fetch(`${env.base}/work/pair`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pairing_code: '12345678' }),
  });
  assert.equal(paired.status, 303);

  const page = await fetch(`${env.base}/work`, {
    headers: { cookie: cookieFrom(paired) },
  });
  assert.equal(page.status, 200);
  const html = await page.text();

  assert.match(html, /User authorization required on phone/i);
  assert.doesNotMatch(html, /SHOULD_NOT_RENDER/);
  assert.doesNotMatch(html, /\/work\/click/);
  assert.doesNotMatch(html, /\/work\/set-text/);
  assert.doesNotMatch(html, /\/work\/tap/);
  assert.doesNotMatch(html, /\/work\/swipe/);
});
