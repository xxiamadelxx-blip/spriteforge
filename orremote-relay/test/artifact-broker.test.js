import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactBroker } from '../src/artifact-broker.js';

function config(root) {
  return {
    relayTokenSecret: 'x'.repeat(64),
    artifactStagingDir: root,
    artifactTransferTimeoutMs: 2_000,
    artifactDownloadTtlMs: 15 * 60 * 1000,
    artifactMaxBytes: 32 * 1024 * 1024,
    artifactMaxConcurrentPerDevice: 2,
  };
}

async function completeTransfer(broker, bytes = Buffer.from('evidence')) {
  const requestId = crypto.randomUUID();
  const deviceId = 'a'.repeat(24);
  const pairId = 'pair-generation-current';
  const artifactId = crypto.randomUUID();
  const sessionEpoch = 42;
  const pending = broker.beginRequest({ requestId, deviceId, pairId, artifactId, sessionEpoch });
  broker.acceptFrame({ deviceId, sessionEpoch, message: {
    type: 'artifact_begin', request_id: requestId, artifact_id: artifactId,
    mime_type: 'image/png', byte_size: bytes.length, session_epoch: sessionEpoch,
  }});
  broker.acceptFrame({ deviceId, sessionEpoch, message: {
    type: 'artifact_chunk', request_id: requestId, sequence: 0,
    data_b64: bytes.toString('base64'), session_epoch: sessionEpoch,
  }});
  broker.acceptFrame({ deviceId, sessionEpoch, message: {
    type: 'artifact_complete', request_id: requestId,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), session_epoch: sessionEpoch,
  }});
  return { result: await pending, bytes };
}

test('stages exact bytes behind a signed short-lived token', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = createArtifactBroker(config(root));

  const { result, bytes } = await completeTransfer(broker);
  const opened = broker.openDownload(result.downloadToken);

  assert.equal(opened.mimeType, 'image/png');
  assert.equal(opened.byteSize, bytes.length);
  assert.deepEqual(fs.readFileSync(opened.filePath), bytes);
  assert.ok(result.expiresAt > Date.now());
  assert.equal(result.downloadToken.includes('pair-generation-current'), false);
});

test('sequence gaps fail closed and remove partial file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = createArtifactBroker(config(root));
  const requestId = crypto.randomUUID();
  const deviceId = 'b'.repeat(24);
  const sessionEpoch = 7;
  const artifactId = crypto.randomUUID();
  const pending = broker.beginRequest({
    requestId, deviceId, pairId: 'pair-current', artifactId, sessionEpoch,
  });
  broker.acceptFrame({ deviceId, sessionEpoch, message: {
    type: 'artifact_begin', request_id: requestId, artifact_id: artifactId,
    mime_type: 'image/png', byte_size: 3, session_epoch: sessionEpoch,
  }});
  broker.acceptFrame({ deviceId, sessionEpoch, message: {
    type: 'artifact_chunk', request_id: requestId, sequence: 1,
    data_b64: Buffer.from('abc').toString('base64'), session_epoch: sessionEpoch,
  }});

  await assert.rejects(pending, (error) => error.code === 'ARTIFACT_SEQUENCE_INVALID');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('stale session frames cannot complete a current transfer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = createArtifactBroker(config(root));
  const requestId = crypto.randomUUID();
  const pending = broker.beginRequest({
    requestId, deviceId: 'c'.repeat(24), pairId: 'pair-current', artifactId: crypto.randomUUID(), sessionEpoch: 9,
  });
  broker.acceptFrame({ deviceId: 'c'.repeat(24), sessionEpoch: 8, message: {
    type: 'artifact_error', request_id: requestId, code: 'ARTIFACT_NOT_FOUND', session_epoch: 8,
  }});
  assert.equal(broker.pendingCount(), 1);
  broker.cancelForDevice('c'.repeat(24), 'SESSION_SUPERSEDED');
  await assert.rejects(pending, (error) => error.code === 'SESSION_SUPERSEDED');
});

test('tampered and expired download tokens are rejected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let nowMs = 1_000;
  const broker = createArtifactBroker(config(root), { now: () => nowMs });
  const { result } = await completeTransfer(broker);

  assert.throws(() => broker.openDownload(`${result.downloadToken}x`), /ARTIFACT_TOKEN_INVALID/);
  nowMs = result.expiresAt + 1;
  assert.throws(() => broker.openDownload(result.downloadToken), /ARTIFACT_EXPIRED/);
});
