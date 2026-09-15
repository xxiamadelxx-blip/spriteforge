import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCommandBus } from '../src/supabase-command-bus.js';

function configured() {
  return {
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    orremoteBusSecret: 's'.repeat(48),
    orremoteBusPollMs: 1000,
  };
}

function fakeFetch(sequence, calls) {
  return async (url, options = {}) => {
    const rpc = String(url).split('/rpc/')[1] || '';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ rpc, body, headers: options.headers });
    const next = sequence.shift();
    if (!next) throw new Error(`unexpected RPC ${rpc}`);
    assert.equal(rpc, next.rpc);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('Supabase command bus stays disabled when configuration is incomplete', async () => {
  let fetched = false;
  const bus = createSupabaseCommandBus({
    config: { supabaseUrl: '', supabasePublishableKey: '', orremoteBusSecret: '' },
    deviceRelay: { forwardMcp: async () => { throw new Error('must not run'); } },
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assert.equal(bus.enabled, false);
  assert.equal(await bus.processOnce(), 'disabled');
  assert.equal(fetched, false);
});

test('claimed command forwards exact MCP request and completes once', async () => {
  const calls = [];
  const forwarded = [];
  const fetchImpl = fakeFetch([
    { rpc: 'orremote_claim_command', body: [{ command_id: '11111111-1111-4111-8111-111111111111', device_id: 'a'.repeat(24), pair_id: 'pair-generation-1234567890', tool_name: 'screen.observe', arguments: {} }] },
    { rpc: 'orremote_complete_command', body: true },
  ], calls);
  const bus = createSupabaseCommandBus({
    config: configured(),
    fetchImpl,
    deviceRelay: {
      async forwardMcp(request) {
        forwarded.push(request);
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 'bus', result: { structuredContent: { status: 'OK', revision: 42 } } }) };
      },
    },
  });

  assert.equal(await bus.processOnce(), 'completed');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].deviceId, 'a'.repeat(24));
  assert.equal(forwarded[0].pairId, 'pair-generation-1234567890');
  const body = JSON.parse(forwarded[0].body);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'screen.observe');
  assert.deepEqual(body.params.arguments, {});
  assert.equal(calls.filter((c) => c.rpc === 'orremote_complete_command').length, 1);
  assert.equal(calls.filter((c) => c.rpc === 'orremote_fail_command').length, 0);
});

test('skill.run executes in relay and completes through the same command result RPC', async () => {
  const calls = [];
  const skillRuns = [];
  const fetchImpl = fakeFetch([
    { rpc: 'orremote_claim_command', body: [{
      command_id: '44444444-4444-4444-8444-444444444444',
      device_id: 'e'.repeat(24),
      pair_id: 'pair-generation-skill1234',
      tool_name: 'skill.run',
      arguments: {
        skill_id: 'yandex_pro.planned_slot_orders.read',
        inputs: { date: '2026-09-15' },
      },
    }] },
    { rpc: 'orremote_complete_command', body: true },
  ], calls);
  const bus = createSupabaseCommandBus({
    config: configured(),
    fetchImpl,
    deviceRelay: {
      async forwardMcp() { throw new Error('skill.run must not be forwarded to Android'); },
    },
    skillsRuntime: {
      async run(request) {
        skillRuns.push(request);
        return {
          status: 'COMPLETED',
          skill_id: request.skillId,
          output: { orders: [] },
          trace: [],
        };
      },
    },
  });

  assert.equal(await bus.processOnce(), 'completed');
  assert.deepEqual(skillRuns, [{
    skillId: 'yandex_pro.planned_slot_orders.read',
    inputs: { date: '2026-09-15' },
    deviceId: 'e'.repeat(24),
    pairId: 'pair-generation-skill1234',
  }]);
  const complete = calls.find((call) => call.rpc === 'orremote_complete_command');
  assert.equal(complete.body.p_result.http_status, 200);
  assert.equal(complete.body.p_result.body.result.structuredContent.status, 'COMPLETED');
  assert.equal(complete.body.p_result.body.result.structuredContent.output.orders.length, 0);
});

test('transport failure is recorded once and never replayed by processOnce', async () => {
  const calls = [];
  let forwarded = 0;
  const fetchImpl = fakeFetch([
    { rpc: 'orremote_claim_command', body: [{ command_id: '22222222-2222-4222-8222-222222222222', device_id: 'b'.repeat(24), pair_id: 'pair-generation-abcdefghij', tool_name: 'ui.click', arguments: { expected_revision: 7, selector_kind: 'TEXT', selector_value: 'Test', exact: true } }] },
    { rpc: 'orremote_fail_command', body: true },
    { rpc: 'orremote_claim_command', body: [] },
  ], calls);
  const bus = createSupabaseCommandBus({
    config: configured(), fetchImpl,
    deviceRelay: { async forwardMcp() { forwarded += 1; const e = new Error('DEVICE_TIMEOUT'); e.code = 'DEVICE_TIMEOUT'; throw e; } },
  });
  assert.equal(await bus.processOnce(), 'failed');
  assert.equal(await bus.processOnce(), 'idle');
  assert.equal(forwarded, 1);
  assert.equal(calls.filter((c) => c.rpc === 'orremote_fail_command').length, 1);
});

test('MCP authorization error body is preserved in completed result', async () => {
  const calls = [];
  const authBody = { jsonrpc: '2.0', id: 'bus', error: { code: -32043, message: 'USER_AUTH_REQUIRED', data: { authorization_required: true, user_only: true } } };
  const fetchImpl = fakeFetch([
    { rpc: 'orremote_claim_command', body: [{ command_id: '33333333-3333-4333-8333-333333333333', device_id: 'c'.repeat(24), pair_id: 'pair-generation-auth1234', tool_name: 'screen.screenshot', arguments: {} }] },
    { rpc: 'orremote_complete_command', body: true },
  ], calls);
  const bus = createSupabaseCommandBus({
    config: configured(), fetchImpl,
    deviceRelay: { async forwardMcp() { return { status: 403, body: JSON.stringify(authBody) }; } },
  });
  assert.equal(await bus.processOnce(), 'completed');
  const complete = calls.find((c) => c.rpc === 'orremote_complete_command');
  assert.deepEqual(complete.body.p_result.body, authBody);
  assert.equal(complete.body.p_result.http_status, 403);
});

test('pair registration sends only device and pair generation to runtime RPC', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([{ rpc: 'orremote_register_pair', body: true }], calls);
  const bus = createSupabaseCommandBus({ config: configured(), fetchImpl, deviceRelay: {} });
  assert.equal(await bus.registerPair({ deviceId: 'd'.repeat(24), pairId: 'pair-generation-register' }), true);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['p_bus_secret', 'p_device_id', 'p_pair_id'].sort());
  assert.equal('pairing_code' in calls[0].body, false);
});
