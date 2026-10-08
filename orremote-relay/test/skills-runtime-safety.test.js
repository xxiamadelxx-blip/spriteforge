import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function skill() {
  return {
    id: 'safe.read',
    packages: ['com.example.safe'],
    safety: { effect: 'read_only', risk: 'R0' },
    createContext() { return {}; },
    recognize() { return 'READY'; },
    async next() { return { type: 'COMPLETE', output: { ok: true } }; },
  };
}

test('runtime stops before observing when skill policy denies execution', async () => {
  let calls = 0;
  const runtime = createSkillRuntime({
    invokePrimitive: async () => { calls += 1; return {}; },
    registry: createSkillRegistry([skill()]),
    authorizeSkill: () => ({ ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'denied' }),
  });
  const result = await runtime.run({ skillId: 'safe.read' });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'SKILL_PACKAGE_NOT_ALLOWED');
  assert.equal(calls, 0);
});

test('runtime panic switch stops execution before any primitive call', async () => {
  let calls = 0;
  const runtime = createSkillRuntime({
    invokePrimitive: async () => { calls += 1; return {}; },
    registry: createSkillRegistry([skill()]),
    panicSwitch: () => true,
  });
  const result = await runtime.run({ skillId: 'safe.read' });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'PANIC_SWITCH_ACTIVE');
  assert.equal(calls, 0);
});

test('runtime never replays an action whose dispatch outcome is unverified', async () => {
  let clickCalls = 0;
  const clickSkill = {
    id: 'click.read',
    packages: ['com.example.safe'],
    safety: { effect: 'read_only', risk: 'R0' },
    createContext() { return {}; },
    recognize() { return 'READY'; },
    async next() { return { type: 'CLICK_HANDLE', handle: 'row-1', purpose: 'OPEN_READ_ONLY_ROW' }; },
    async validateDirective() { return { ok: true }; },
  };
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([clickSkill]),
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        return { structuredContent: { status: 'OK', package: 'com.example.safe', revision: 9, nodes: [] } };
      }
      if (name === 'ui.click') {
        clickCalls += 1;
        return {
          isError: true,
          structuredContent: {
            status: 'ACTION_DISPATCHED_NOT_VERIFIED',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
            verified_change: false,
          },
        };
      }
      throw new Error(`unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({ skillId: 'click.read' });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(clickCalls, 1);
});
