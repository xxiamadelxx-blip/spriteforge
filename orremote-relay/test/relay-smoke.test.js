import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const RELAY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY_ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

function deviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyBase64 = publicDer.toString('base64');
  const deviceId = crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 24);
  return { privateKey, publicKeyBase64, deviceId };
}

function signChallenge(privateKey, deviceId, nonce) {
  return crypto.sign(
    'sha256',
    Buffer.from(`orremote-m3|${deviceId}|${nonce}`, 'utf8'),
    privateKey,
  ).toString('base64');
}

function createQueue(ws) {
  const queued = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });
  ws.on('error', (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  return {
    next(timeoutMs = 4_000) {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for relay websocket message'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function startRelay(port, storePath) {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DEVICE_STORE_PATH: storePath,
      MCP_TIMEOUT_MS: '2500',
      PAIR_TTL_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await Promise.race([
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (stdout.includes(`Ø Remote relay listening on 0.0.0.0:${port}`)) {
          clearInterval(timer);
          resolve();
        }
        if (child.exitCode !== null) {
          clearInterval(timer);
          reject(new Error(`relay exited early (${child.exitCode})\n${stderr}\n${stdout}`));
        }
      }, 25);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`relay start timeout\n${stderr}\n${stdout}`)), 5_000)),
  ]);
  return child;
}

async function stopRelay(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function connectDevice(port, identity) {
  const params = new URLSearchParams({
    device_id: identity.deviceId,
    public_key: identity.publicKeyBase64,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device?${params}`);
  const queue = createQueue(ws);
  await once(ws, 'open');
  return { ws, queue };
}

async function authenticateFromChallenge(ws, queue, identity) {
  const challenge = await queue.next();
  assert.equal(challenge.type, 'challenge');
  assert.ok(challenge.nonce);
  ws.send(JSON.stringify({
    type: 'challenge_response',
    signature: signChallenge(identity.privateKey, identity.deviceId, challenge.nonce),
  }));
  const authenticated = await queue.next();
  assert.equal(authenticated.type, 'authenticated');
  assert.equal(authenticated.device_id, identity.deviceId);
  assert.ok(Number.isInteger(authenticated.session_epoch));
  return authenticated.session_epoch;
}

async function remoteMcp(baseUrl, deviceId, token, id, name = 'screen.observe') {
  return fetch(`${baseUrl}/mcp/${deviceId}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }),
  });
}

test('pairing, authenticated MCP, stale epoch rejection, reconnect and persisted identity', { timeout: 20_000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orremote-relay-test-'));
  const storePath = path.join(tempDir, 'trusted-devices.json');
  const port = 31_000 + crypto.randomInt(10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const identity = deviceIdentity();
  let relay = await startRelay(port, storePath);
  let ws;

  t.after(async () => {
    try { ws?.close(); } catch {}
    await stopRelay(relay);
    await rm(tempDir, { recursive: true, force: true });
  });

  const first = await connectDevice(port, identity);
  ws = first.ws;
  let queue = first.queue;

  const pairing = await queue.next();
  assert.equal(pairing.type, 'pairing_required');
  assert.match(pairing.code, /^\d{8}$/);
  assert.equal(pairing.device_id, identity.deviceId);

  const claimResponse = await fetch(`${baseUrl}/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();
  assert.equal(claim.paired, true);
  assert.equal(claim.device_id, identity.deviceId);
  assert.ok(claim.agent_token);
  const agentToken = claim.agent_token;

  const epoch1 = await authenticateFromChallenge(ws, queue, identity);

  const unauthorized = await fetch(`${baseUrl}/presence/${identity.deviceId}`, {
    headers: { authorization: 'Bearer definitely-wrong' },
  });
  assert.equal(unauthorized.status, 401);

  const presence = await fetch(`${baseUrl}/presence/${identity.deviceId}`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(presence.status, 200);
  const presenceBody = await presence.json();
  assert.equal(presenceBody.connected, true);
  assert.equal(presenceBody.session_epoch, epoch1);

  const firstMcpPromise = remoteMcp(baseUrl, identity.deviceId, agentToken, 7);
  const firstMcpRequest = await queue.next();
  assert.equal(firstMcpRequest.type, 'mcp_request');
  assert.equal(firstMcpRequest.session_epoch, epoch1);
  assert.equal(firstMcpRequest.headers['mcp-name'], 'screen.observe');
  ws.send(JSON.stringify({
    type: 'mcp_response',
    request_id: firstMcpRequest.request_id,
    session_epoch: epoch1,
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, result: { observed: true } }),
  }));
  const firstMcpResponse = await firstMcpPromise;
  assert.equal(firstMcpResponse.status, 200);
  assert.deepEqual(await firstMcpResponse.json(), { jsonrpc: '2.0', id: 7, result: { observed: true } });

  ws.close(1000, 'test reconnect');
  await once(ws, 'close');

  const second = await connectDevice(port, identity);
  ws = second.ws;
  queue = second.queue;
  const epoch2 = await authenticateFromChallenge(ws, queue, identity);
  assert.ok(epoch2 > epoch1);

  const staleMcpPromise = remoteMcp(baseUrl, identity.deviceId, agentToken, 8, 'ui.click');
  const staleMcpRequest = await queue.next();
  assert.equal(staleMcpRequest.type, 'mcp_request');
  assert.equal(staleMcpRequest.session_epoch, epoch2);

  ws.send(JSON.stringify({
    type: 'mcp_response',
    request_id: staleMcpRequest.request_id,
    session_epoch: epoch1,
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, result: { should_not_be_accepted: true } }),
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  ws.send(JSON.stringify({
    type: 'mcp_response',
    request_id: staleMcpRequest.request_id,
    session_epoch: epoch2,
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, result: { verified: true } }),
  }));
  const staleMcpResponse = await staleMcpPromise;
  assert.equal(staleMcpResponse.status, 200);
  assert.deepEqual(await staleMcpResponse.json(), { jsonrpc: '2.0', id: 8, result: { verified: true } });

  ws.close(1000, 'test restart');
  await once(ws, 'close');
  await stopRelay(relay);

  relay = await startRelay(port, storePath);
  const third = await connectDevice(port, identity);
  ws = third.ws;
  queue = third.queue;
  const epoch3 = await authenticateFromChallenge(ws, queue, identity);
  assert.ok(epoch3 > epoch2);

  const persistedPresence = await fetch(`${baseUrl}/presence/${identity.deviceId}`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(persistedPresence.status, 200);
  const persistedBody = await persistedPresence.json();
  assert.equal(persistedBody.paired, true);
  assert.equal(persistedBody.connected, true);
  assert.equal(persistedBody.session_epoch, epoch3);
});
