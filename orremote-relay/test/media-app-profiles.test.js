import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaDiscoveryPlanSkill } from '../src/skills/media/discovery-plan.js';
import { mediaProfileById, mediaProfileForPackage } from '../src/skills/media/app-profiles.js';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';

const skill = createMediaDiscoveryPlanSkill();
const policy = createDefaultSkillSafetyPolicy({ panicSwitch: () => false });

function authorize(inputs) {
  return policy.authorizeSkill(skill, { inputs });
}

test('media provider profiles map stable ids to installed Android packages', () => {
  assert.deepEqual(mediaProfileById('yandex_afisha'), {
    id: 'yandex_afisha',
    package: 'ru.yandex.mobile.afisha',
  });
  assert.deepEqual(mediaProfileById('yandex_music'), {
    id: 'yandex_music',
    package: 'ru.yandex.music',
  });
  assert.deepEqual(mediaProfileForPackage('ru.kinopoisk'), {
    id: 'kinopoisk',
    package: 'ru.kinopoisk',
  });
});

test('media provider can be used without raw package input', () => {
  assert.deepEqual(authorize({ provider: 'yandex_music', steps: [] }), { ok: true });
  const context = skill.createContext({ inputs: { provider: 'yandex_music', steps: [] } });
  assert.equal(context.target_package, 'ru.yandex.music');
});

test('media provider rejects conflicting package and unknown provider', () => {
  const conflict = authorize({ provider: 'kinopoisk', package: 'ru.yandex.music', steps: [] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'SKILL_PACKAGE_NOT_ALLOWED');

  const unknown = authorize({ provider: 'unknown', steps: [] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'SKILL_PROVIDER_NOT_ALLOWED');
});


test('media discovery policy does not enter auth or persistent controls', () => {
  for (const text of ['Войти', 'Sign in', 'Account', 'Купить билет']) {
    const result = authorize({
      provider: 'yandex_afisha',
      steps: [{ type: 'CLICK_EXACT_TEXT', text }],
    });
    assert.equal(result.ok, false, text);
    assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
  }
});
