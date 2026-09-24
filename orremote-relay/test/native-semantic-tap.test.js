import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeExactPlanSkill } from '../src/skills/native/exact-plan.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function snapshot(revision, extra = {}) {
  return {
    isError: false,
    structuredContent: {
      status: 'OK',
      package: 'com.deepseek.chat',
      revision,
      display_id: 0,
      authorization_required: false,
      hit_topology_signature: 'topology-235',
      nodes: [
        {
          handle: 'placeholder',
          window_id: 17,
          visible_to_user: true,
          center_hit: 'OWNED',
          text: 'Напишите или удерживайте, чтобы говорить',
          class_name: 'android.widget.TextView',
          bounds: { left: 77, top: 2095, right: 998, bottom: 2162 },
          enabled: true,
          editable: false,
          clickable: false,
          sensitive: false,
          depth: 3,
          ...extra,
        },
      ],
    },
  };
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
  assert.deepEqual(taps[0].args, {
    expected_revision: 235,
    x: 538,
    y: 2129,
    target_handle: 'placeholder',
    target_window_id: 17,
    expected_hit_topology_signature: 'topology-235',
  });
});

test('semantic anchored tap refuses sensitive targets', async () => {
  const skill = createNativeExactPlanSkill({ id: 'test.native.tap.sensitive', packages: ['com.deepseek.chat'], effect: 'conversation_write', risk: 'R2' });
  const runtime = createSkillRuntime({ registry: createSkillRegistry([skill]), invokePrimitive: async (name) => { if (name === 'screen.observe') return snapshot(235, { sensitive: true }); throw new Error(`Unexpected primitive ${name}`); } });
  const output = await runtime.run({ skillId: 'test.native.tap.sensitive', inputs: { package: 'com.deepseek.chat', steps: [{ type: 'TAP_EXACT_SELECTOR_CENTER', selector: { kind: 'TEXT', value: 'Напишите или удерживайте, чтобы говорить' } }] } });
  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'USER_AUTH_REQUIRED');
});

test('semantic anchored tap stops before touch dispatch when Android reports the center occluded', async () => {
  const calls = [];
  const skill = createNativeExactPlanSkill({ id: 'test.native.tap.occluded', packages: ['com.deepseek.chat'], effect: 'conversation_write', risk: 'R2' });
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async (name) => {
      calls.push(name);
      if (name === 'screen.observe') return snapshot(235, { center_hit: 'OCCLUDED' });
      throw new Error(`Unexpected primitive ${name}`);
    },
  });
  const output = await runtime.run({ skillId: 'test.native.tap.occluded', inputs: { package: 'com.deepseek.chat', steps: [{ type: 'TAP_EXACT_SELECTOR_CENTER', selector: { kind: 'TEXT', value: 'Напишите или удерживайте, чтобы говорить' } }] } });
  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'TARGET_OCCLUDED');
  assert.equal(calls.includes('touch.tap'), false);
});

test('semantic anchored tap fails closed before touch dispatch when hit evidence is incomplete', async () => {
  const calls = [];
  const skill = createNativeExactPlanSkill({ id: 'test.native.tap.unknown-hit', packages: ['com.deepseek.chat'], effect: 'conversation_write', risk: 'R2' });
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async (name) => {
      calls.push(name);
      if (name === 'screen.observe') {
        const observed = snapshot(235, { center_hit: 'UNKNOWN' });
        delete observed.structuredContent.hit_topology_signature;
        return observed;
      }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });
  const output = await runtime.run({ skillId: 'test.native.tap.unknown-hit', inputs: { package: 'com.deepseek.chat', steps: [{ type: 'TAP_EXACT_SELECTOR_CENTER', selector: { kind: 'TEXT', value: 'Напишите или удерживайте, чтобы говорить' } }] } });
  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'TARGET_HIT_UNVERIFIABLE');
  assert.equal(calls.includes('touch.tap'), false);
});
