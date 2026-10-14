import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCommandBus } from '../src/supabase-command-bus.js';

const config = {
  supabaseUrl: 'https://example.supabase.co',
  supabasePublishableKey: 'sb_publishable_test',
  orremoteBusSecret: 's'.repeat(48),
  orremoteBusPollMs: 1000,
};

function transportError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function scriptedFetch(command, lastRpc, calls) {
  const steps = [
    { name: 'orremote_claim_command', result: [command] },
    { name: lastRpc, result: true },
  ];
  return async (url, options) => {
    const name = String(url).split('/rpc/')[1];
    const expected = steps.shift();
    assert.ok(expected, 'no unexpected extra claim/complete/fail');
    assert.equal(name, expected.name);
    calls.push({ name, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify(expected.result), { status: 200 });
  };
}

function command(tool, id) {
  return {
    command_id: id, device_id: 'a'.repeat(24),
    pair_id: 'paired-generation-1234567890', tool_name: tool,
    arguments: tool === 'ui.click' ? { expected_revision: 7, selector_kind: 'TEXT', selector_value: 'do-not-retry' } : {},
  };
}

test('verified new-session rollover may retry screen.observe and app.list once, completing each only once', async () => {
  for (const tool of ['screen.observe', 'app.list']) {
    const calls = [];
    const forwards = [];
    const metrics = [];
    const item = command(tool, '66666666-6666-4666-8666-666666666666');
    const bus = createSupabaseCommandBus({
      config,
      fetchImpl: scriptedFetch(item, 'orremote_complete_command', calls),
      onM8Metric: (m) => metrics.push(m),
      deviceRelay: {
        async forwardMcp(request) {
          forwards.push(request);
          if (forwards.length === 1) throw transportError('SESSION_SUPERSEDED');
          return {
            status: 200,
            body: JSON.stringify({ jsonrpc: '2.0', result: { isError: false, structuredContent: { status: 'OK' } } }),
          };
        },
      },
    });
    assert.equal(await bus.processOnce(), 'completed', tool);
    assert.equal(forwards.length, 2, tool);
    assert.equal(forwards[0].traceId, item.command_id);
    assert.equal(forwards[1].traceId, item.command_id);
    assert.equal(forwards[0].pairId, item.pair_id);
    assert.equal(forwards[1].pairId, item.pair_id);
    assert.equal(JSON.parse(forwards[0].body).params.name, tool);
    assert.equal(JSON.parse(forwards[1].body).params.name, tool);
    assert.deepEqual(calls.map((x) => x.name), ['orremote_claim_command', 'orremote_complete_command']);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].outcome, 'completed');
    assert.equal(metrics[0].read_only_retry_count, 1);
    assert.equal(JSON.stringify(metrics).includes(item.pair_id), false);
  }
});

test('write commands are never retried after session supersession', async () => {
  const calls = [];
  const metrics = [];
  let forwards = 0;
  const item = command('ui.click', '77777777-7777-4777-8777-777777777777');
  const bus = createSupabaseCommandBus({
    config,
    fetchImpl: scriptedFetch(item, 'orremote_fail_command', calls),
    onM8Metric: (m) => metrics.push(m),
    deviceRelay: {
      async forwardMcp() {
        forwards++;
        throw transportError('SESSION_SUPERSEDED');
      },
    },
  });
  assert.equal(await bus.processOnce(), 'failed');
  assert.equal(forwards, 1);
  assert.deepEqual(calls.map(x => x.name), ['orremote_claim_command', 'orremote_fail_command']);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].failure_code, 'SESSION_SUPERSEDED');
  assert.equal(metrics[0].read_only_retry_count, undefined);
});

test('repeated session supersession stops after one read-only retry, failing exactly once', async () => {
  const calls = [];
  const metrics = [];
  let forwards = 0;
  const bus = createSupabaseCommandBus({
    config,
    fetchImpl: scriptedFetch(command('screen.observe', '88888888-8888-4888-8888-888888888888'), 'orremote_fail_command', calls),
    onM8Metric: m => metrics.push(m),
    deviceRelay: { async forwardMcp() { forwards++; throw transportError('SESSION_SUPERSEDED'); } },
  });
  assert.equal(await bus.processOnce(), 'failed');
  assert.equal(forwards, 2);
  assert.deepEqual(calls.map(x => x.name), ['orremote_claim_command', 'orremote_fail_command']);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].read_only_retry_count, 1);
  assert.equal(metrics[0].failure_code, 'SESSION_SUPERSEDED');
});

test('screen.observe DEVICE_TIMEOUT remains terminal rather than replaying an ambiguous response', async () => {
  const calls = [];
  let forwards = 0;
  const bus = createSupabaseCommandBus({
    config,
    fetchImpl: scriptedFetch(command('screen.observe', '99999999-9999-4999-8999-999999999999'), 'orremote_fail_command', calls),
    deviceRelay: { async forwardMcp() { forwards++; throw transportError('DEVICE_TIMEOUT'); } },
  });
  assert.equal(await bus.processOnce(), 'failed');
  assert.equal(forwards, 1);
  assert.deepEqual(calls.map(x => x.name), ['orremote_claim_command', 'orremote_fail_command']);
});
