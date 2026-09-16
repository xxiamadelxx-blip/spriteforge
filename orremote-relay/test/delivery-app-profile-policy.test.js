import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryCartPlanSkill } from '../src/skills/delivery/cart-plan.js';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';

const skill = createDeliveryCartPlanSkill();
const policy = createDefaultSkillSafetyPolicy({ panicSwitch: () => false });

function authorize(inputs) {
  return policy.authorizeSkill(skill, { inputs });
}

test('delivery provider profile authorizes its installed package without raw package input', () => {
  assert.deepEqual(authorize({ provider: 'samokat', steps: [] }), { ok: true });
});

test('delivery provider profile rejects a conflicting package', () => {
  const result = authorize({ provider: 'samokat', package: 'ru.vkusvill', steps: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_PACKAGE_NOT_ALLOWED');
});

test('unknown delivery provider fails closed', () => {
  const result = authorize({ provider: 'unknown', steps: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_PROVIDER_NOT_ALLOWED');
});
