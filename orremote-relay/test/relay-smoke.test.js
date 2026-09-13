import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const RELAY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY_ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

function deviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKeyBase64: publicDer.toString('base64'),
    deviceId: crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 24),
  };
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

async function startRelay(port, tokenSecret) {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_TOKEN_SECRET: tokenSecret,
      MCP_TIMEOUT_MS: '2500',
      PAIR_TTL_MS: '5000',
      CAPABILITY_TTL_MS: '5000',
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
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function connectDevice(port, identity, paired = false) {
  const params = new URLSearchParams({
    device_id: identity.deviceId,
    public_key: identity.publicKeyBase64,
    paired: paired ? '1' : '0',
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device?${params}`);
  const queue = createQueue(ws);
  await once(ws, 'open');
  return { ws, queue };
}

async function authenticate(ws, queue, identity) {
  const challenge = await queue.next();
  assert.equal(challenge.type, 'challenge');
  ws.send(JSON.stringify({
    type: 'challenge_response',
    signature: signChallenge(identity.privateKey, identity.deviceId, challenge.nonce),
  }));
  const authenticated = await queue.next();
  assert.equal(authenticated.type, 'authenticated');
  assert.equal(authenticated.device_id, identity.deviceId);
  assert.ok(Number.isSafeInteger(authenticated.session_epoch));
  return authenticated.session_epoch;
}

async function exchangeCapability(baseUrl, deviceId, pairToken) {
  const response = await fetch(`${baseUrl}/token/exchange/${deviceId}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pairToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ scopes: ['presence', 'mcp'] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.capability_token);
  assert.deepEqual(body.scopes, ['presence', 'mcp']);
  return body.capability_token;
}

async function remoteMcp(baseUrl, deviceId, capabilityToken, id, name = 'screen.observe') {
  return fetch(`${baseUrl}/mcp/${deviceId}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${capabilityToken}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }),
  });
}

test('stateless pairing survives relay restart and capabilities remain short-lived', { timeout: 20_000 }, async (t) => {
  const port = 31_000 + crypto.randomInt(10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenSecret = crypto.randomBytes(48).toString('base64url');
  const identity = deviceIdentity();
  let relay = await startRelay(port, tokenSecret);
  let ws;

  t.after(async () => {
    try { ws?.close(); } catch {}
    await stopRelay(relay);
  });

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).auth_mode, 'stateless-signed-credentials-v1');

  const first = await connectDevice(port, identity, false);
  ws = first.ws;
  let queue = first.queue;
  const epoch1 = await authenticate(ws, queue, identity);

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
  assert.ok(claim.pair_token);
  assert.ok(claim.capability_token);
  const pairToken = claim.pair_token;

  const accepted = await queue.next();
  assert.equal(accepted.type, 'pairing_accepted');
  assert.equal(accepted.device_id, identity.deviceId);

  const pairTokenCannotCallPresence = await fetch(`${baseUrl}/presence/${identity.deviceId}`, {
    headers: { authorization: `Bearer ${pairToken}` },
  });
  assert.equal(pairTokenCannotCallPresence.status, 401);

  const capability1 = await exchangeCapability(baseUrl, identity.deviceId, pairToken);
  const presence = await fetch(`${baseUrl}/presence/${identity.deviceId}`, {
    headers: { authorization: `Bearer ${capability1}` },
  });
  assert.equal(presence.status, 200);
  assert.equal((await presence.json()).session_epoch, epoch1);

  const firstMcpPromise = remoteMcp(baseUrl, identity.deviceId, capability1, 7);
  const firstMcpRequest = await queue.next();
  assert.equal(firstMcpRequest.type, 'mcp_request');
  assert.equal(firstMcpRequest.session_epoch, epoch1);
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

  const second = await connectDevice(port, identity, true);
  ws = second.ws;
  queue = second.queue;
  const epoch2 = await authenticate(ws, queue, identity);
  assert.ok(epoch2 > epoch1);

  const capability2 = await exchangeCapability(baseUrl, identity.deviceId, pairToken);
  const staleMcpPromise = remoteMcp(baseUrl, identity.deviceId, capability2, 8, 'ui.click');
  const staleMcpRequest = await queue.next();
  assert.equal(staleMcpRequest.type, 'mcp_request');
  assert.equal(staleMcpRequest.session_epoch, epoch2);

  ws.send(JSON.stringify({
    type: 'mcp_response',
    request_id: staleMcpRequest.request_id,
    session_epoch: epoch1,
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, result: { stale: true } }),
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

  relay = await startRelay(port, tokenSecret);
  const third = await connectDevice(port, identity, true);
  ws = third.ws;
  queue = third.queue;
  const epoch3 = await authenticate(ws, queue, identity);
  assert.ok(epoch3 > epoch2);

  const capabilityAfterRestart = await exchangeCapability(baseUrl, identity.deviceId, pairToken);
  const persistedPresence = await fetch(`${baseUrl}/presence/${identity.deviceId}`, {
    headers: { authorization: `Bearer ${capabilityAfterRestart}` },
  });
  assert.equal(persistedPresence.status, 200);
  const persistedBody = await persistedPresence.json();
  assert.equal(persistedBody.connected, true);
  assert.equal(persistedBody.session_epoch, epoch3);
});
