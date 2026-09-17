import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_PONG_STALE_MS, shouldTerminateForStalePong } from '../src/device-liveness.js';

test('authenticated device is terminated after pong silence reaches the stale threshold', () => {
  const now = 100_000;
  assert.equal(
    shouldTerminateForStalePong({
      authenticated: true,
      lastPongAt: now - DEVICE_PONG_STALE_MS,
      now,
    }),
    true,
  );
});

test('recent pong keeps an authenticated device alive', () => {
  const now = 100_000;
  assert.equal(
    shouldTerminateForStalePong({
      authenticated: true,
      lastPongAt: now - DEVICE_PONG_STALE_MS + 1,
      now,
    }),
    false,
  );
});

test('unauthenticated socket is never killed by authenticated pong policy', () => {
  assert.equal(
    shouldTerminateForStalePong({
      authenticated: false,
      lastPongAt: 1,
      now: Number.MAX_SAFE_INTEGER,
    }),
    false,
  );
});
