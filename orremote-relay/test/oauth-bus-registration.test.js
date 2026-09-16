import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelayServer } from '../src/server.js';

function config() {
  const publicOrigin = 'https://relay.test';
  return {
    host: '127.0.0.1',
    port: 0,
    publicOrigin,
    oauthIssuer: publicOrigin,
    mcpResource: `${publicOrigin}/mcp`,
    relayTokenSecret: 'r'.repeat(48),
    mcpTimeoutMs: 2500,
    pairTtlMs: 5000,
    pairCredentialTtlMs: 365 * 24 * 60 * 60 * 1000,
    capabilityTtlMs: 10 * 60 * 1000,
    oauthCodeTtlMs: 5 * 60 * 1000,
    oauthAccessTtlMs: 10 * 60 * 1000,
    oauthRefreshTtlMs: 30 * 24 * 60 * 60 * 1000,
    maxBodyBytes: 1024 * 1024,
    pairAttemptWindowMs: 10 * 60 * 1000,
    maxPairAttemptsPerIp: 8,
    allowedClientId: 'https://chatgpt.test/client-metadata.json',
    allowedRedirectUris: ['https://chatgpt.test/oauth/callback'],
  };
}

function deviceRelayStub() {
  return {
    handleUpgrade(_req, socket) { socket.destroy(); },
    connectedDeviceCount() { return 0; },
    pendingPairCount() { return 1; },
    pendingArtifactCount() { return 0; },
    stagedArtifactCount() { return 0; },
    claimPairing(code) {
      if (code !== '12345678') return null;
      return {
        deviceId: 'b'.repeat(24),
        pairId: 'pair_generation_bus_sync_1234',
      };
    },
    exchangePairCredential() { return null; },
    verifyCapability() { return null; },
    presence() { return { deviceId: 'b'.repeat(24), connected: false, sessionEpoch: null }; },
    async forwardMcp() { throw new Error('device forwarding not expected'); },
  };
}

function challenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

test('OAuth pairing registers the claimed pair with the command bus before redirect', async (t) => {
  const cfg = config();
  const registrations = [];
  const commandBus = {
    enabled: true,
    async registerPair(pairing) {
      registrations.push(pairing);
      return true;
    },
  };
  const server = createRelayServer(cfg, deviceRelayStub(), commandBus);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const verifier = 'pkce-verifier-abcdefghijklmnopqrstuvwxyz-1234567890';
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.allowedClientId,
    redirect_uri: cfg.allowedRedirectUris[0],
    resource: cfg.mcpResource,
    scope: 'android.observe android.control',
    state: 'bus-sync-state',
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256',
  });
  const authorize = await fetch(`${base}/oauth/authorize?${query}`);
  assert.equal(authorize.status, 200);
  const html = await authorize.text();
  const requestToken = html.match(/name="request_token" value="([^"]+)"/)?.[1];
  assert.ok(requestToken);

  const approval = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_token: requestToken, pairing_code: '12345678' }),
  });

  assert.equal(approval.status, 302);
  assert.deepEqual(registrations, [{
    deviceId: 'b'.repeat(24),
    pairId: 'pair_generation_bus_sync_1234',
  }]);
  const redirect = new URL(approval.headers.get('location'));
  assert.equal(`${redirect.origin}${redirect.pathname}`, cfg.allowedRedirectUris[0]);
});
