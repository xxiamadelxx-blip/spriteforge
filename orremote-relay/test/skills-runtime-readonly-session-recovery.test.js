import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function snapshot(revision = 1) {
  return {
    status: 'OK',
    revision,
    package: 'com.example',
    display_id: 0,
    authorization_required: false,
    nodes: [],
  };
}

function result(structuredContent, isError = false) {
  return { structuredContent, isError };
}

function createRuntime(skill, invokePrimitive) {
  return createSkillRuntime({
    invokePrimitive,
    registry: createSkillRegistry([skill]),
    sleep: async () => {},
    now: () => 1000,
  });
}

function baseSkill(effect = 'read_only') {
  return {
    id: `test.${effect}`,
    version: 1,
    packages: ['com.example'],
    safety: { effect, risk: effect === 'read_only' ? 'R0' : 'R1' },
    createContext: () => ({}),
    recognize: () => 'READY',
    next: () => ({ type: 'COMPLETE', output: { ok: true } }),
    validateDirective: () => ({ ok: true }),
  };
}

test('read-only observe retries transient DEVICE_OFFLINE within the configured bound', async () => {
  const calls = [];
  let attempts = 0;
  const skill = baseSkill('read_only');
  const runtime = createRuntime(skill, async (name) => {
    calls.push(name);
    attempts += 1;
    if (attempts <= 2) throw new Error('DEVICE_OFFLINE');
    return result(snapshot(7));
  });

  const output = await runtime.run({ skillId: skill.id, limits: { maxReadOnlySessionRecoveries: 2 } });

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(calls, ['screen.observe', 'screen.observe', 'screen.observe']);
  assert.deepEqual(
    output.trace.filter((entry) => entry.type === 'RECOVERY').map((entry) => entry.recovery),
    ['DEVICE_OFFLINE', 'DEVICE_OFFLINE'],
  );
});

test('non-read-only skill does not retry DEVICE_OFFLINE observation', async () => {
  const calls = [];
  const skill = baseSkill('configuration');
  const runtime = createRuntime(skill, async (name) => {
    calls.push(name);
    throw new Error('DEVICE_OFFLINE');
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'SKILL_OBSERVE_FAILED');
  assert.deepEqual(calls, ['screen.observe']);
});

test('DEVICE_OFFLINE from an action is never replayed by read-only observe recovery', async () => {
  const calls = [];
  let planned = false;
  const skill = {
    ...baseSkill('read_only'),
    next: () => {
      if (!planned) {
        planned = true;
        return { type: 'BACK', purpose: 'SAFE_READ_NAVIGATION' };
      }
      return { type: 'COMPLETE', output: { ok: true } };
    },
    validateDirective: () => ({ ok: true }),
  };
  const runtime = createRuntime(skill, async (name) => {
    calls.push(name);
    if (name === 'screen.observe') return result(snapshot(9));
    throw new Error('DEVICE_OFFLINE');
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'SKILL_PRIMITIVE_FAILED');
  assert.deepEqual(calls, ['screen.observe', 'system.back']);
});

test('approved read-only action ambiguity reobserves before replanning and never blindly replays', async () => {
  const calls = [];
  let observeCount = 0;
  const skill = {
    ...baseSkill('read_only'),
    recognize: (value) => value.revision >= 2 ? 'DONE' : 'READY',
    next: ({ state }) => state === 'READY'
      ? { type: 'BACK', purpose: 'SAFE_READ_NAVIGATION' }
      : { type: 'COMPLETE', output: { ok: true } },
    recoverPrimitiveError: ({ directive, error_code }) => ({
      reobserve: directive?.purpose === 'SAFE_READ_NAVIGATION' && error_code === 'SESSION_SUPERSEDED',
    }),
  };
  const runtime = createRuntime(skill, async (name) => {
    calls.push(name);
    if (name === 'screen.observe') {
      observeCount += 1;
      return result(snapshot(observeCount));
    }
    throw new Error('SESSION_SUPERSEDED');
  });

  const output = await runtime.run({ skillId: skill.id, limits: { maxReadOnlySessionRecoveries: 1 } });

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(calls, ['screen.observe', 'system.back', 'screen.observe']);
  const recovery = output.trace.find((entry) => entry.type === 'RECOVERY');
  assert.equal(recovery?.operation, 'system.back');
  assert.equal(recovery?.action_replayed, false);
});

test('SESSION_SUPERSEDED remains bounded under the same read-only observe recovery contract', async () => {
  const calls = [];
  let attempts = 0;
  const skill = baseSkill('read_only');
  const runtime = createRuntime(skill, async (name) => {
    calls.push(name);
    attempts += 1;
    if (attempts === 1) throw new Error('SESSION_SUPERSEDED');
    return result(snapshot(11));
  });

  const output = await runtime.run({ skillId: skill.id, limits: { maxReadOnlySessionRecoveries: 1 } });

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(calls, ['screen.observe', 'screen.observe']);
  assert.equal(output.trace[0].recovery, 'SESSION_SUPERSEDED');
});
