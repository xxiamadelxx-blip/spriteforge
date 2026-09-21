import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryCartPlanSkill } from '../src/skills/delivery/cart-plan.js';
import { createMediaDiscoveryPlanSkill } from '../src/skills/media/discovery-plan.js';

function node(overrides = {}) {
  return {
    depth: 1,
    handle: 'h',
    enabled: true,
    clickable: false,
    editable: false,
    sensitive: false,
    bounds: { left: 0, top: 0, right: 500, bottom: 100 },
    ...overrides,
  };
}

function snap(pkg, nodes = [], revision = 4) {
  return { package: pkg, revision, authorization_required: false, nodes };
}

test('media discovery launches selected observed media package', async () => {
  const skill = createMediaDiscoveryPlanSkill();
  const context = skill.createContext({
    inputs: { package: 'ru.yandex.mobile.afisha', steps: [] },
  });
  const directive = await skill.next({
    state: skill.recognize(snap('com.android.settings'), context),
    snapshot: snap('com.android.settings'),
    context,
  });
  assert.deepEqual(directive, { type: 'LAUNCH', package: 'ru.yandex.mobile.afisha' });
});

test('media discovery allows search text but blocks persistent favorite action', async () => {
  const skill = createMediaDiscoveryPlanSkill();
  const context = skill.createContext({
    inputs: {
      package: 'ru.kinopoisk',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'search' },
        value: 'Dune',
        sensitive: false,
      }],
    },
  });
  const searchSnapshot = snap('ru.kinopoisk', [node({ handle: 'search-h', editable: true, resource_id: 'search' })]);
  const setText = await skill.next({ state: 'TARGET_APP', snapshot: searchSnapshot, context });
  assert.equal(setText.type, 'SET_TEXT_HANDLE');
  assert.equal((await skill.validateDirective({ snapshot: searchSnapshot, directive: setText, context })).ok, true);

  const favoriteContext = skill.createContext({
    inputs: { package: 'ru.kinopoisk', steps: [{ type: 'CLICK_EXACT_TEXT', text: 'В избранное' }] },
  });
  const favoriteSnapshot = snap('ru.kinopoisk', [node({ handle: 'fav', clickable: true, text: 'В избранное' })]);
  const blocked = await skill.next({ state: 'TARGET_APP', snapshot: favoriteSnapshot, context: favoriteContext });
  assert.equal(blocked.type, 'STOP');
  assert.equal(blocked.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});

test('delivery cart skill permits add-to-cart but blocks checkout and payment', async () => {
  const skill = createDeliveryCartPlanSkill();
  const addContext = skill.createContext({
    inputs: { package: 'ru.sbcs.store', steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Добавить' }] },
  });
  const addSnapshot = snap('ru.sbcs.store', [node({ handle: 'add', clickable: true, text: 'Добавить' })]);
  const add = await skill.next({ state: 'TARGET_APP', snapshot: addSnapshot, context: addContext });
  assert.equal(add.type, 'CLICK_HANDLE');
  assert.equal((await skill.validateDirective({ snapshot: addSnapshot, directive: add, context: addContext })).ok, true);

  for (const text of ['Оформить заказ', 'Оплатить', 'Place order']) {
    const context = skill.createContext({
      inputs: { package: 'ru.sbcs.store', steps: [{ type: 'CLICK_EXACT_TEXT', text }] },
    });
    const snapshot = snap('ru.sbcs.store', [node({ handle: 'blocked', clickable: true, text })]);
    const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
    assert.equal(directive.type, 'STOP', text);
    assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED', text);
  }
});

test('delivery cart blocks checkout text nested under generic clickable container', async () => {
  const skill = createDeliveryCartPlanSkill();
  const context = skill.createContext({
    inputs: {
      package: 'ru.sbcs.store',
      steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'primary-action' } }],
    },
  });
  const snapshot = snap('ru.sbcs.store', [
    node({
      depth: 1,
      handle: 'container',
      clickable: true,
      resource_id: 'primary-action',
      bounds: { left: 0, top: 0, right: 500, bottom: 120 },
    }),
    node({
      depth: 2,
      handle: 'label',
      text: 'Оформить заказ',
      bounds: { left: 20, top: 20, right: 300, bottom: 80 },
    }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});

test('delivery cart skill rejects package outside consumer delivery allowlist', async () => {
  const skill = createDeliveryCartPlanSkill();
  const context = skill.createContext({
    inputs: { package: 'ru.yandex.taximeter', steps: [] },
  });
  const directive = await skill.next({
    state: 'OTHER_APP',
    snapshot: snap('com.android.settings'),
    context,
  });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'SKILL_PACKAGE_NOT_ALLOWED');
});


test('media discovery opens a card with read-only collection metadata but blocks collection controls', async () => {
  const skill = createMediaDiscoveryPlanSkill();
  const cardContext = skill.createContext({
    inputs: {
      provider: 'yandex_music',
      steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'HANDLE', value: 'artist-card' } }],
    },
  });
  const cardSnapshot = snap('ru.yandex.music', [
    node({
      handle: 'artist-card',
      clickable: true,
      resource_id: 'artist_card',
      bounds: { left: 0, top: 0, right: 1000, bottom: 280 },
    }),
    node({
      handle: 'artist-kind',
      depth: 2,
      text: 'Исполнитель',
      bounds: { left: 24, top: 24, right: 500, bottom: 72 },
    }),
    node({
      handle: 'artist-title',
      depth: 2,
      text: 'Example Artist',
      bounds: { left: 24, top: 80, right: 700, bottom: 132 },
    }),
    node({
      handle: 'artist-metadata',
      depth: 2,
      text: '675608 лайков Добавлено в Коллекцию',
      bounds: { left: 24, top: 144, right: 900, bottom: 212 },
    }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot: cardSnapshot, context: cardContext });
  assert.deepEqual(directive, { type: 'CLICK_HANDLE', handle: 'artist-card', step_index: 0 });
  assert.deepEqual(
    await skill.validateDirective({ snapshot: cardSnapshot, directive, context: cardContext }),
    { ok: true },
  );

  const collectionContext = skill.createContext({
    inputs: {
      provider: 'yandex_music',
      steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Добавить в Коллекцию' }],
    },
  });
  const collectionSnapshot = snap('ru.yandex.music', [
    node({ handle: 'collection', clickable: true, text: 'Добавить в Коллекцию' }),
  ]);
  const blocked = await skill.next({
    state: 'TARGET_APP',
    snapshot: collectionSnapshot,
    context: collectionContext,
  });
  assert.equal(blocked.type, 'STOP');
  assert.equal(blocked.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});

test('pinned cart navigation with read-only auth-like metadata is not treated as a credential control', async () => {
  const skill = createDeliveryCartPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'pyaterochka',
      steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'XCart_pinned_cart_button' } }],
    },
  });
  const snapshot = snap('ru.pyaterochka.app.browser', [
    node({
      handle: 'pinned-cart',
      clickable: true,
      resource_id: 'XCart_pinned_cart_button',
      bounds: { left: 700, top: 1700, right: 1060, bottom: 1880 },
    }),
    node({
      handle: 'cart-title',
      depth: 2,
      text: 'Корзина',
      bounds: { left: 720, top: 1720, right: 1000, bottom: 1770 },
    }),
    node({
      handle: 'cart-metadata',
      depth: 2,
      text: 'access token metadata',
      bounds: { left: 720, top: 1780, right: 1000, bottom: 1830 },
    }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.deepEqual(directive, { type: 'CLICK_HANDLE', handle: 'pinned-cart', step_index: 0 });
  assert.deepEqual(await skill.validateDirective({ snapshot, directive, context }), { ok: true });
});

test('credential form descendant remains user-only even under a generic clickable container', async () => {
  const skill = createDeliveryCartPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'pyaterochka',
      steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'HANDLE', value: 'login-container' } }],
    },
  });
  const snapshot = snap('ru.pyaterochka.app.browser', [
    node({
      handle: 'login-container',
      clickable: true,
      resource_id: 'login_container',
      bounds: { left: 0, top: 0, right: 1000, bottom: 360 },
    }),
    node({
      handle: 'password-field',
      depth: 2,
      editable: true,
      resource_id: 'password',
      bounds: { left: 24, top: 160, right: 976, bottom: 260 },
    }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});


test('token-boundary cart regression retains real protected credential ceremonies', async () => {
  const skill = createDeliveryCartPlanSkill();
  for (const resourceId of [
    'password',
    'pin_code',
    'otp_input',
    'mfa_challenge',
    'passkey_prompt',
    'oauth_consent',
    'permission_allow_button',
    'biometric_prompt',
    'captcha_widget',
    'api_secret',
  ]) {
    const context = skill.createContext({
      inputs: {
        provider: 'pyaterochka',
        steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: resourceId } }],
      },
    });
    const snapshot = snap('ru.pyaterochka.app.browser', [
      node({ handle: resourceId, clickable: true, resource_id: resourceId }),
    ]);
    const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
    assert.equal(directive.type, 'STOP', resourceId);
    assert.equal(directive.error_code, 'USER_AUTH_REQUIRED', resourceId);
  }
});
