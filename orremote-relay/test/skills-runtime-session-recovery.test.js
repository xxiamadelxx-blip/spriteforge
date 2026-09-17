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

function runtimeWith(skill, invokePrimitive, sleep = async () => {}) {
  return createSkillRuntime({
    invokePrimitive,
    registry: createSkillRegistry([skill]),
    now: () => 1000,
    sleep,
  });
}

const readOnlySkill = {
  id: 'test.read_only',
  version: 1,
  packages: ['com.example'],
  safety: { effect: 'read_only', risk: 'R0' },
  createContext: () => ({}),
  recognize: () => 'READY',
  next: () => ({ type: 'COMPLETE', output: { ok: true } }),
};

test('read-only skill retries screen.observe after SESSION_SUPERSEDED and preserves the run', async () => {
  let observeCalls = 0;
  const sleeps = [];
  const runtime = runtimeWith(
    readOnlySkill,
    async (name) => {
      assert.equal(name, 'screen.observe');
      observeCalls += 1;
      if (observeCalls === 1) throw new Error('SESSION_SUPERSEDED');
      return result(snapshot(7));
    },
    async (ms) => { sleeps.push(ms); },
  );

  const output = await runtime.run({ skillId: readOnlySkill.id, inputs: {} });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(observeCalls, 2);
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(output.trace[0], {
    type: 'RECOVERY',
    recovery: 'SESSION_SUPERSEDED',
    operation: 'screen.observe',
    attempt: 1,
  });
  assert.equal(output.trace[1].type, 'OBSERVE');
});

test('read-only SESSION_SUPERSEDED recovery is bounded', async () => {
  let observeCalls = 0;
  const runtime = runtimeWith(readOnlySkill, async () => {
    observeCalls += 1;
    throw new Error('SESSION_SUPERSEDED');
  });

  const output = await runtime.run({
    skillId: readOnlySkill.id,
    inputs: {},
    limits: { maxReadOnlySessionRecoveries: 1 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'SKILL_OBSERVE_FAILED');
  assert.equal(output.message, 'SESSION_SUPERSEDED');
  assert.equal(observeCalls, 2);
  assert.equal(output.trace.filter((entry) => entry.type === 'RECOVERY').length, 1);
});

test('non-read-only skill never retries SESSION_SUPERSEDED observation', async () => {
  let observeCalls = 0;
  const skill = {
    ...readOnlySkill,
    id: 'test.configuration',
    safety: { effect: 'configuration', risk: 'R1' },
  };
  const runtime = runtimeWith(skill, async () => {
    observeCalls += 1;
    throw new Error('SESSION_SUPERSEDED');
  });

  const output = await runtime.run({ skillId: skill.id, inputs: {} });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'SKILL_OBSERVE_FAILED');
  assert.equal(observeCalls, 1);
  assert.equal(output.trace.length, 0);
});

test('read-only recovery never replays an action that hit SESSION_SUPERSEDED', async () => {
  let clickCalls = 0;
  const skill = {
    ...readOnlySkill,
    id: 'test.read_only_action',
    next: () => ({ type: 'CLICK_HANDLE', handle: 'safe-row' }),
    validateDirective: () => ({ ok: true }),
  };
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return result(snapshot(11));
    if (name === 'ui.click') {
      clickCalls += 1;
      throw new Error('SESSION_SUPERSEDED');
    }
    throw new Error(`unexpected primitive: ${name}`);
  });

  const output = await runtime.run({ skillId: skill.id, inputs: {} });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'SKILL_PRIMITIVE_FAILED');
  assert.equal(output.message, 'SESSION_SUPERSEDED');
  assert.equal(clickCalls, 1);
});
