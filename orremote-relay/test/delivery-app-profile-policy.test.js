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


test('delivery cart policy allows cart edits but blocks address or location commitment', () => {
  assert.deepEqual(authorize({
    provider: 'samokat',
    steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Добавить в корзину' }],
  }), { ok: true });

  for (const step of [
    { type: 'CLICK_EXACT_TEXT', text: 'Изменить адрес' },
    {
      type: 'SET_TEXT_EXACT_SELECTOR',
      selector: { kind: 'RESOURCE_ID', value: 'delivery_address' },
      value: 'some address',
      sensitive: false,
    },
    { type: 'CLICK_EXACT_TEXT', text: 'Текущее местоположение' },
  ]) {
    const result = authorize({ provider: 'samokat', steps: [step] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
  }
});


test('delivery cart planner itself rejects address controls', async () => {
  const context = skill.createContext({
    inputs: {
      provider: 'samokat',
      steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Изменить адрес' }],
    },
  });
  const snapshot = {
    package: 'ru.sbcs.store',
    revision: 1,
    nodes: [
      {
        handle: 'row', depth: 1, clickable: true, enabled: true, editable: false, sensitive: false,
        bounds: { left: 0, top: 0, right: 1000, bottom: 120 },
      },
      {
        handle: 'label', depth: 2, text: 'Изменить адрес', clickable: false, enabled: true, editable: false, sensitive: false,
        bounds: { left: 20, top: 20, right: 600, bottom: 100 },
      },
    ],
  };
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});


test('delivery cart policy does not enter account or sign-in controls', () => {
  for (const text of ['Войти', 'Sign in', 'Account']) {
    const result = authorize({
      provider: 'samokat',
      steps: [{ type: 'CLICK_EXACT_TEXT', text }],
    });
    assert.equal(result.ok, false, text);
    assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
  }
});


test('delivery cart planner itself rejects address text entry', async () => {
  const context = skill.createContext({
    inputs: {
      provider: 'samokat',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'delivery_address' },
        value: 'some address',
        sensitive: false,
      }],
    },
  });
  const snapshot = { package: 'ru.sbcs.store', revision: 2, nodes: [] };
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});


test('delivery semantic center tap permits cart add but rejects checkout, payment, address and account targets', () => {
  const add = authorize({
    provider: 'samokat',
    steps: [{
      type: 'TAP_EXACT_SELECTOR_CENTER',
      selector: { kind: 'RESOURCE_ID', value: 'CATALOG_PRODUCT_CARD_ADD_TO_CART_example' },
    }],
  });
  assert.deepEqual(add, { ok: true });

  for (const value of ['checkout_button', 'payment_button', 'delivery_address', 'account_button']) {
    const result = authorize({
      provider: 'samokat',
      steps: [{
        type: 'TAP_EXACT_SELECTOR_CENTER',
        selector: { kind: 'RESOURCE_ID', value },
      }],
    });
    assert.equal(result.ok, false, value);
    assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED', value);
  }
});

test('delivery policy rejects arbitrary raw coordinate tap plans', () => {
  const result = authorize({
    provider: 'samokat',
    steps: [{ type: 'TAP_POINT', x: 300, y: 460 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
});
