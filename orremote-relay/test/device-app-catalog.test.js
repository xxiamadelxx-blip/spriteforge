import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_BROWSER,
  AI_ASSISTANT_APPS,
  AI_ASSISTANT_PACKAGES,
  CONSUMER_DELIVERY_APPS,
  CONSUMER_DELIVERY_PACKAGES,
  MEDIA_DISCOVERY_APPS,
  MEDIA_DISCOVERY_PACKAGES,
} from '../src/skills/catalogs/device-apps.js';

test('catalog locks observed Opera and media package ids', () => {
  assert.equal(ADMIN_BROWSER.opera, 'com.opera.browser');
  assert.deepEqual(MEDIA_DISCOVERY_APPS, {
    yandexAfisha: 'ru.yandex.mobile.afisha',
    yandexMusic: 'ru.yandex.music',
    kinopoisk: 'ru.kinopoisk',
  });
  assert.equal(new Set(MEDIA_DISCOVERY_PACKAGES).size, 3);
});

test('AI assistant catalog contains the six approved provider apps', () => {
  assert.deepEqual(AI_ASSISTANT_APPS, {
    chatgpt: 'com.openai.chatgpt',
    qwen: 'ai.qwenlm.chat.android',
    deepseek: 'com.deepseek.chat',
    claude: 'com.anthropic.claude',
    gemini: 'com.google.android.apps.bard',
    suno: 'com.suno.android',
  });
  assert.equal(new Set(AI_ASSISTANT_PACKAGES).size, 6);
});

test('consumer delivery catalog contains observed shopping apps but never Yandex Pro', () => {
  assert.equal(CONSUMER_DELIVERY_APPS.yandexFood, 'ru.foodfox.client');
  assert.equal(CONSUMER_DELIVERY_APPS.yandexLavka, 'com.yandex.lavka');
  assert.equal(CONSUMER_DELIVERY_APPS.samokat, 'ru.sbcs.store');
  assert.equal(CONSUMER_DELIVERY_APPS.vkusvill, 'ru.vkusvill');
  assert.equal(CONSUMER_DELIVERY_PACKAGES.includes('ru.yandex.taximeter'), false);
  assert.equal(new Set(CONSUMER_DELIVERY_PACKAGES).size, 12);
});
