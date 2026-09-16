import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';

const yandex = { id: 'yandex_pro.planned_slot_orders.read', packages: ['ru.yandex.taximeter'], safety: { effect: 'read_only', risk: 'R1' } };
const settings = { id: 'settings.device_info.read', packages: ['com.android.settings'], safety: { effect: 'read_only', risk: 'R0' } };

test('default M6 policy allows only explicitly approved read-only packages', () => {
  const policy = createDefaultSkillSafetyPolicy({ panicSwitch: () => false });
  assert.deepEqual(policy.authorizeSkill(yandex), { ok: true });
  assert.deepEqual(policy.authorizeSkill(settings), { ok: true });
  const unknown = policy.authorizeSkill({ id: 'unknown.read', packages: ['com.example.unknown'], safety: { effect: 'read_only', risk: 'R0' } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'SKILL_PACKAGE_NOT_ALLOWED');
  const mutating = policy.authorizeSkill({ id: 'settings.mutate', packages: ['com.android.settings'], safety: { effect: 'settings_write', risk: 'R2' } });
  assert.equal(mutating.ok, false);
  assert.equal(mutating.code, 'SKILL_EFFECT_NOT_ALLOWED');
});

test('panic switch is dynamically observable', () => {
  let panic = false;
  const policy = createDefaultSkillSafetyPolicy({ panicSwitch: () => panic });
  assert.equal(policy.isPanicked(), false);
  panic = true;
  assert.equal(policy.isPanicked(), true);
});
