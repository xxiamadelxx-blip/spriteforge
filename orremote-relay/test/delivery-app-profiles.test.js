import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryProfileById,
  deliveryProfileForPackage,
} from '../src/skills/delivery/app-profiles.js';

test('consumer delivery profiles resolve installed shopping apps', () => {
  assert.deepEqual(deliveryProfileById('yandex_food'), {
    id: 'yandex_food',
    package: 'ru.foodfox.client',
  });
  assert.deepEqual(deliveryProfileById('samokat'), {
    id: 'samokat',
    package: 'ru.sbcs.store',
  });
  assert.deepEqual(deliveryProfileById('vkusvill'), {
    id: 'vkusvill',
    package: 'ru.vkusvill',
  });
  assert.equal(deliveryProfileById('unknown'), null);
});

test('consumer delivery profile can be inferred from package exactly', () => {
  assert.equal(deliveryProfileForPackage('com.yandex.lavka')?.id, 'yandex_lavka');
  assert.equal(deliveryProfileForPackage('ru.tander.magnit')?.id, 'magnit');
  assert.equal(deliveryProfileForPackage('com.example.other'), null);
});
