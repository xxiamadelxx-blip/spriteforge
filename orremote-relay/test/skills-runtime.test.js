import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function snapshot(revision = 1, extra = {}) {
  return {
    status: 'OK',
    revision,
    package: 'com.example',
    display_id: 0,
    authorization_required: false,
    nodes: [],
    ...extra,
  };
}

function result(structuredContent, isError = false) {
  return { structuredContent, isError };
}

function runtimeWith({ skill, invokePrimitive, now = () => 1000 }) {
  const registry = createSkillRegistry([skill]);
  return createSkillRuntime({ invokePrimitive, registry, now });
}

const baseSkill = {
  id: 'test.skill',
  version: 1,
  packages: ['com.example'],
  createContext: () => ({}),
  recognize: () => 'READY',
  validateDirective: () => ({ ok: true }),
  acceptResult: () => {},
};

test('first primitive call is screen.observe and click uses latest revision plus HANDLE', async () => {
  const calls = [];
  let step = 0;
  const skill = {
    ...baseSkill,
    next() {
      step += 1;
      return step === 1
        ? { type: 'CLICK_HANDLE', handle: 'node-7' }
        : { type: 'COMPLETE', output: { ok: true } };
    },
  };
  const runtime = runtimeWith({
    skill,
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') return result(snapshot(calls.length === 1 ? 7 : 8));
      return result({ status: 'VERIFIED' });
    },
  });

  const output = await runtime.run({ skillId: 'test.skill', inputs: {} });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(calls[0].name, 'screen.observe');
  assert.deepEqual(calls[1], {
    name: 'ui.click',
    args: {
      expected_revision: 7,
      selector_kind: 'HANDLE',
      selector_value: 'node-7',
      exact: true,
    },
  });
  assert.equal(calls[2].name, 'screen.observe');
});

test('directive is stopped when skill safety validation rejects it', async () => {
  const calls = [];
  const skill = {
    ...baseSkill,
    next: () => ({ type: 'CLICK_HANDLE', handle: 'danger' }),
    validateDirective: () => ({ ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' }),
  };
  const runtime = runtimeWith({
    skill,
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      return result(snapshot(4));
    },
  });

  const output = await runtime.run({ skillId: 'test.skill', inputs: {} });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'SKILL_ACTION_NOT_ALLOWED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'screen.observe');
});

test('STALE_STATE re-observes instead of replaying the action', async () => {
  const calls = [];
  let accepted = false;
  const skill = {
    ...baseSkill,
    next: () => accepted
      ? { type: 'COMPLETE', output: { ok: true } }
      : { type: 'CLICK_HANDLE', handle: 'node-1' },
    acceptResult({ primitiveResult }) {
      if (!primitiveResult.isError) accepted = true;
    },
  };
  let clickCount = 0;
  const runtime = runtimeWith({
    skill,
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        const observes = calls.filter((entry) => entry.name === 'screen.observe').length;
        return result(snapshot(observes === 1 ? 10 : 11));
      }
      clickCount += 1;
      if (clickCount === 1) return result({ status: 'ERROR', error_code: 'STALE_STATE' }, true);
      return result({ status: 'VERIFIED' });
    },
  });

  const output = await runtime.run({ skillId: 'test.skill', inputs: {} });

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(calls.map((entry) => entry.name), [
    'screen.observe',
    'ui.click',
    'screen.observe',
    'ui.click',
    'screen.observe',
  ]);
  assert.equal(calls[1].args.expected_revision, 10);
  assert.equal(calls[3].args.expected_revision, 11);
});

test('authorization surface stops without dispatching a skill action', async () => {
  const calls = [];
  const skill = {
    ...baseSkill,
    next: () => ({ type: 'CLICK_HANDLE', handle: 'node-1' }),
  };
  const runtime = runtimeWith({
    skill,
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      return result(snapshot(3, {
        authorization_required: true,
        privacy_mode: 'USER_AUTH_REDACTED',
      }));
    },
  });

  const output = await runtime.run({ skillId: 'test.skill', inputs: {} });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'USER_AUTH_REQUIRED');
  assert.equal(calls.length, 1);
});

test('transition and deadline limits fail closed', async () => {
  const loopingSkill = {
    ...baseSkill,
    next: () => ({ type: 'SWIPE', start_x: 500, start_y: 1500, end_x: 500, end_y: 500 }),
  };
  const transitionRuntime = runtimeWith({
    skill: loopingSkill,
    invokePrimitive: async (name) => name === 'screen.observe'
      ? result(snapshot(1))
      : result({ status: 'VERIFIED' }),
  });
  const transitionResult = await transitionRuntime.run({
    skillId: 'test.skill',
    inputs: {},
    limits: { maxTransitions: 2 },
  });
  assert.equal(transitionResult.error_code, 'SKILL_TRANSITION_LIMIT');

  let clock = 0;
  const deadlineRuntime = runtimeWith({
    skill: loopingSkill,
    now: () => { clock += 1000; return clock; },
    invokePrimitive: async (name) => name === 'screen.observe'
      ? result(snapshot(1))
      : result({ status: 'VERIFIED' }),
  });
  const deadlineResult = await deadlineRuntime.run({
    skillId: 'test.skill',
    inputs: {},
    limits: { deadlineMs: 500 },
  });
  assert.equal(deadlineResult.error_code, 'SKILL_DEADLINE_EXCEEDED');
});
