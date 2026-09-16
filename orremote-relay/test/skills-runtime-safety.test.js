import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function skill() {
  return { id: 'safe.read', packages: ['com.example.safe'], safety: { effect: 'read_only', risk: 'R0' }, createContext() { return {}; }, recognize() { return 'READY'; }, async next() { return { type: 'COMPLETE', output: { ok: true } }; } };
}

test('runtime stops before observing when skill policy denies execution', async () => {
  let calls = 0;
  const runtime = createSkillRuntime({ invokePrimitive: async () => { calls += 1; return {}; }, registry: createSkillRegistry([skill()]), authorizeSkill: () => ({ ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'denied' }) });
  const result = await runtime.run({ skillId: 'safe.read' });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'SKILL_PACKAGE_NOT_ALLOWED');
  assert.equal(calls, 0);
});

test('runtime panic switch stops execution before any primitive call', async () => {
  let calls = 0;
  const runtime = createSkillRuntime({ invokePrimitive: async () => { calls += 1; return {}; }, registry: createSkillRegistry([skill()]), panicSwitch: () => true });
  const result = await runtime.run({ skillId: 'safe.read' });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'PANIC_SWITCH_ACTIVE');
  assert.equal(calls, 0);
});
