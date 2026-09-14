import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/server.js';

function config() {
  return {
    publicOrigin: 'https://orremote-relay.onrender.com',
    mcpResource: 'https://orremote-relay.onrender.com/mcp', oauthIssuer: 'https://orremote-relay.onrender.com',
    relayTokenSecret: 'w'.repeat(64), mcpTimeoutMs: 1000, pairTtlMs: 600000,
    pairCredentialTtlMs: 31536000000, capabilityTtlMs: 600000, oauthCodeTtlMs: 300000,
    oauthAccessTtlMs: 600000, oauthRefreshTtlMs: 2592000000, workSessionTtlMs: 3600000,
    maxBodyBytes: 1024 * 1024, pairAttemptWindowMs: 600000, maxPairAttemptsPerIp: 8,
    allowedClientId: '', allowedRedirectUris: [],
  };
}

async function start() {
  const registrations = [];
  const relay = {
    handleUpgrade() {}, connectedDeviceCount: () => 1, pendingPairCount: () => 1,
    claimPairing(code) {
      if (code !== '12345678') return null;
      return { deviceId: 'a'.repeat(24), pairId: 'pair-generation-1234567890' };
    },
    async forwardMcp() { throw new Error('not used'); },
  };
  const commandBus = {
    enabled: true,
    async registerPair(pair) { registrations.push(pair); return true; },
  };
  const server = createRelayServer(config(), relay, commandBus);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, registrations, base: `http://127.0.0.1:${server.address().port}` };
}

test('successful manual Work pairing registers only device and pair generation with command bus', async (t) => {
  const env = await start();
  t.after(() => env.server.close());
  const response = await fetch(`${env.base}/work/pair`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pairing_code: '12345678' }),
  });
  assert.equal(response.status, 303);
  assert.equal(env.registrations.length, 1);
  assert.deepEqual(env.registrations[0], { deviceId: 'a'.repeat(24), pairId: 'pair-generation-1234567890' });
  assert.equal('pairingCode' in env.registrations[0], false);
});
