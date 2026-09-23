import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryCartPlanSkill } from '../src/skills/delivery/cart-plan.js';
import { createMediaDiscoveryPlanSkill } from '../src/skills/media/discovery-plan.js';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';

test('media discovery policy accepts observed media package and bounded search plan', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const result = policy.authorizeSkill(createMediaDiscoveryPlanSkill(), {
    inputs: {
      package: 'ru.yandex.music',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'search' },
        value: 'Bring Me The Horizon',
        sensitive: false,
      }],
    },
  });
  assert.deepEqual(result, { ok: true });
});

test('media discovery policy rejects persistent account action', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const result = policy.authorizeSkill(createMediaDiscoveryPlanSkill(), {
    inputs: {
      package: 'ru.yandex.music',
      steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Добавить в избранное' }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
});

test('delivery policy accepts add-to-cart plan on observed consumer app', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const result = policy.authorizeSkill(createDeliveryCartPlanSkill(), {
    inputs: {
      package: 'ru.foodfox.client',
      steps: [
        { type: 'SET_TEXT_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'search' }, value: 'бургер', sensitive: false },
        { type: 'CLICK_EXACT_TEXT', text: 'Добавить' },
      ],
    },
  });
  assert.deepEqual(result, { ok: true });
});

test('delivery policy blocks checkout/payment and Yandex Pro package', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const skill = createDeliveryCartPlanSkill();
  const checkout = policy.authorizeSkill(skill, {
    inputs: { package: 'ru.sbcs.store', steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Оформить заказ' }] },
  });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.code, 'SKILL_ACTION_NOT_ALLOWED');

  const pro = policy.authorizeSkill(skill, {
    inputs: { package: 'ru.yandex.taximeter', steps: [] },
  });
  assert.equal(pro.ok, false);
  assert.equal(pro.code, 'SKILL_PACKAGE_NOT_ALLOWED');
});


test('media discovery policy treats semantic center tap as an action and blocks persistent or commercial targets', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const skill = createMediaDiscoveryPlanSkill();
  for (const value of ['Like', 'Favorite', 'Collection', 'Download', 'Buy', 'Rent']) {
    const result = policy.authorizeSkill(skill, {
      inputs: {
        package: 'ru.yandex.music',
        steps: [{
          type: 'TAP_EXACT_SELECTOR_CENTER',
          selector: { kind: 'TEXT', value },
        }],
      },
    });
    assert.equal(result.ok, false, value);
    assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED', value);
  }
});
