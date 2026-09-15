import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createRelayServer } from '../src/server.js';

function config() {
  const publicOrigin = 'https://relay.test';
  return {
    host: '127.0.0.1', port: 0, publicOrigin,
    oauthIssuer: publicOrigin, mcpResource: `${publicOrigin}/mcp`,
    relayTokenSecret: 'h'.repeat(48), mcpTimeoutMs: 2500,
    pairTtlMs: 5000, pairCredentialTtlMs: 365 * 24 * 60 * 60 * 1000,
    capabilityTtlMs: 10 * 60 * 1000, oauthCodeTtlMs: 5 * 60 * 1000,
    oauthAccessTtlMs: 10 * 60 * 1000, oauthRefreshTtlMs: 30 * 24 * 60 * 60 * 1000,
    workSessionTtlMs: 60 * 60 * 1000, maxBodyBytes: 1024 * 1024,
    pairAttemptWindowMs: 10 * 60 * 1000, maxPairAttemptsPerIp: 8,
    allowedClientId: '', allowedRedirectUris: [], artifactDownloadTtlMs: 15 * 60 * 1000,
  };
}

function relayForFile(filePath, bytes) {
  let consumed = false;
  return {
    handleUpgrade(_req, socket) { socket.destroy(); },
    connectedDeviceCount() { return 1; }, pendingPairCount() { return 0; },
    pendingArtifactCount() { return 0; }, stagedArtifactCount() { return consumed ? 0 : 1; },
    claimPairing() { return null; }, exchangePairCredential() { return null; },
    verifyCapability(_token, deviceId, scope) {
      if (deviceId === 'a'.repeat(24) && scope === 'mcp') return { pair_id: 'pair-secret-never-returned' };
      return null;
    },
    presence() { return { deviceId: 'a'.repeat(24), connected: true, sessionEpoch: 1 }; },
    async forwardMcp() { throw new Error('not expected'); },
    async requestArtifact({ artifactId }) {
      return {
        artifactId, mimeType: 'image/png', byteSize: bytes.length,
        sha256: '1'.repeat(64), expiresAt: Date.now() + 60_000, downloadToken: 'signed.download.token',
      };
    },
    openArtifactDownload(token) {
      if (token !== 'signed.download.token' || consumed) {
        const error = new Error('ARTIFACT_NOT_FOUND'); error.code = 'ARTIFACT_NOT_FOUND'; error.status = 404; throw error;
      }
      return { stageId: 'stage', artifactId: '11111111-1111-4111-8111-111111111111', mimeType: 'image/png', byteSize: bytes.length, filePath };
    },
    consumeArtifactStage(stageId) { if (stageId === 'stage') consumed = true; return true; },
  };
}

async function start(t, relay) {
  const server = createRelayServer(config(), relay);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('artifact request returns metadata and short-lived URL without pair material', async (t) => {
  const bytes = Buffer.from('png-bytes');
  const filePath = path.join(os.tmpdir(), `orremote-${Date.now()}.png`);
  fs.writeFileSync(filePath, bytes); t.after(() => fs.rmSync(filePath, { force: true }));
  const base = await start(t, relayForFile(filePath, bytes));
  const artifactId = '11111111-1111-4111-8111-111111111111';

  const response = await fetch(`${base}/artifact/request/${'a'.repeat(24)}`, {
    method: 'POST', headers: { authorization: 'Bearer capability', 'content-type': 'application/json' },
    body: JSON.stringify({ artifact_id: artifactId }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.artifact_id, artifactId);
  assert.equal(body.mime_type, 'image/png');
  assert.equal(body.download_url, 'https://relay.test/artifacts/signed.download.token');
  assert.equal(JSON.stringify(body).includes('pair-secret-never-returned'), false);
  assert.equal(JSON.stringify(body).includes(filePath), false);
});

test('artifact download streams exact bytes privately and is consumed after success', async (t) => {
  const bytes = Buffer.from('png-bytes');
  const filePath = path.join(os.tmpdir(), `orremote-${Date.now()}.png`);
  fs.writeFileSync(filePath, bytes); t.after(() => fs.rmSync(filePath, { force: true }));
  const base = await start(t, relayForFile(filePath, bytes));

  const response = await fetch(`${base}/artifacts/signed.download.token`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await fetch(`${base}/artifacts/signed.download.token`);
  assert.equal(second.status, 404);
  assert.deepEqual(await second.json(), { error: 'ARTIFACT_NOT_FOUND' });
});
