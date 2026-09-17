import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeExactPlanSkill } from '../src/skills/native/exact-plan.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function snapshot(revision, extra = {}) {
  return { isError: false, structuredContent: { status: 'OK', package: 'com.deepseek.chat', revision, display_id: 0, authorization_required: false, nodes: [{ handle: 'placeholder', text: 'Напишите или удерживайте, чтобы говорить', class_name: 'android.widget.TextView', bounds: { left: 77, top: 2095, right: 998, bottom: 2162 }, enabled: true, editable: false, clickable: false, sensitive: false, depth: 3, ...extra }] } };
}

test('native exact plan taps the center of a fresh exact semantic node instead of using fixed coordinates', async () => {
  const calls = [];
  let observes = 0;
  const skill = createNativeExactPlanSkill({ id: 'test.native.tap', packages: ['com.deepseek.chat'], effect: 'conversation_write', risk: 'R2' });
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') { observes += 1; return snapshot(observes === 1 ? 235 : 236); }
      if (name === 'touch.tap') return { isError: false, structuredContent: { status: 'VERIFIED', after_revision: 236 } };
      throw new Error(`Unexpected primitive ${name}`);
    },
  });
  const output = await runtime.run({ skillId: 'test.native.tap', inputs: { package: 'com.deepseek.chat', steps: [{ type: 'TAP_EXACT_SELECTOR_CENTER', selector: { kind: 'TEXT', value: 'Напишите или удерживайте, чтобы говорить' } }] }, limits: { maxTransitions: 8, deadlineMs: 10_000 } });
  assert.equal(output.status, 'COMPLETED');
  const taps = calls.filter((entry) => entry.name === 'touch.tap');
  assert.equal(taps.length, 1);
  assert.deepEqual(taps[0].args, { expected_revision: 235, x: 538, y: 2129 });
});

test('semantic anchored tap refuses sensitive targets', async () => {
  const skill = createNativeExactPlanSkill({ id: 'test.native.tap.sensitive', packages: ['com.deepseek.chat'], effect: 'conversation_write', risk: 'R2' });
  const runtime = createSkillRuntime({ registry: createSkillRegistry([skill]), invokePrimitive: async (name) => { if (name === 'screen.observe') return snapshot(235, { sensitive: true }); throw new Error(`Unexpected primitive ${name}`); } });
  const output = await runtime.run({ skillId: 'test.native.tap.sensitive', inputs: { package: 'com.deepseek.chat', steps: [{ type: 'TAP_EXACT_SELECTOR_CENTER', selector: { kind: 'TEXT', value: 'Напишите или удерживайте, чтобы говорить' } }] } });
  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'USER_AUTH_REQUIRED');
});
