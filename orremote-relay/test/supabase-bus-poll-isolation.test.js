import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCommandBus } from '../src/supabase-command-bus.js';

const config = (more = {}) => ({
  supabaseUrl: 'https://supabase.invalid',
  supabasePublishableKey: 'test-publishable-only',
  orremoteBusSecret: 'fixture-secret-only',
  orremoteBusPollMs: 15,
  ...more,
});
const ok = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const pending = () => new Promise(() => {});

test('a hung artifact claim does not starve subsequent Android command polling or replay a write', async () => {
  let claims = 0;
  let dispatched = 0;
  let completed = 0;
  let artifacts = 0;
  const bus = createSupabaseCommandBus({
    config: config({ orremoteBusRpcTimeoutMs: 250 }),
    deviceRelay: {
      async forwardMcp() {
        dispatched += 1;
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', result: { structuredContent: { status: 'OK' } } }) };
      },
    },
    fetchImpl: async (url) => {
      const rpc = url.split('/').pop();
      if (rpc === 'orremote_claim_artifact') { artifacts += 1; return pending(); }
      if (rpc === 'orremote_claim_command') {
        claims += 1;
        return ok(claims === 1 ? [{
          command_id: '88888888-8888-4888-8888-888888888888',
          device_id: 'a'.repeat(24),
          pair_id: 'pair-generation-synthetic',
          tool_name: 'ui.click',
          arguments: { expected_revision: 1 },
        }] : []);
      }
      if (rpc === 'orremote_complete_command') { completed += 1; return ok(true); }
      throw new Error('Unexpected RPC ' + rpc);
    },
    onM8Metric() {},
  });
  bus.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.ok(artifacts >= 1, 'artifact lane actually stalled');
    assert.ok(claims >= 2, 'command lane must continue polling while artifact lane hangs');
    assert.equal(dispatched, 1, 'no blind duplicate action');
    assert.equal(completed, 1, 'result persisted once');
  } finally {
    bus.stop();
  }
});

test('an unresponsive command claim RPC ends at its deadline without dispatching an Android action', async () => {
  let calls = 0;
  const bus = createSupabaseCommandBus({
    config: config({ orremoteBusRpcTimeoutMs: 30 }),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.ok(options.signal, 'HTTP request must receive a cancellable AbortSignal');
      return pending(); // deliberately ignores AbortSignal; timeout still must settle
    },
    deviceRelay: { async forwardMcp() { throw new Error('must not dispatch'); } },
  });
  await assert.rejects(bus.processOnce(), (error) => error?.code === 'SUPABASE_BUS_RPC_TIMEOUT');
  assert.equal(calls, 1, 'do not retry an ambiguous claim');
});

test('stopping the bus does not start a new command claim after the in-flight poll resolves', async () => {
  let claims = 0;
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const bus = createSupabaseCommandBus({
    config: config(),
    fetchImpl: async (url) => {
      const rpc = url.split('/').pop();
      if (rpc === 'orremote_claim_command') { claims += 1; return delayed; }
      return ok([]);
    },
    deviceRelay: {},
  });
  bus.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  bus.stop();
  release(ok([]));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(claims, 1);
});
