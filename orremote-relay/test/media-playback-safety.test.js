import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaPlaybackPlanSkill } from '../src/skills/media/playback-plan.js';
import { authorizeMediaPlaybackSkill } from '../src/skills/media/playback-safety.js';

test('media playback policy allows bounded playback controls only', () => {
  const skill = createMediaPlaybackPlanSkill();
  assert.deepEqual(
    authorizeMediaPlaybackSkill(skill, {
      inputs: {
        provider: 'yandex_music',
        steps: [
          { type: 'CLICK_EXACT_TEXT', text: 'Play' },
          { type: 'CAPTURE_VISIBLE_UI', key: 'player' },
        ],
      },
    }),
    { ok: true },
  );

  assert.equal(
    authorizeMediaPlaybackSkill(skill, {
      inputs: {
        provider: 'yandex_music',
        steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Like' }],
      },
    }).ok,
    false,
  );
  assert.equal(
    authorizeMediaPlaybackSkill(skill, {
      inputs: {
        provider: 'yandex_afisha',
        steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Play' }],
      },
    }).ok,
    false,
  );
  assert.equal(
    authorizeMediaPlaybackSkill(skill, {
      inputs: {
        provider: 'yandex_music',
        steps: [{ type: 'SET_TEXT_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'search' }, value: 'x' }],
      },
    }).ok,
    false,
  );
});

test('media playback authorizer ignores unrelated skills', () => {
  assert.equal(authorizeMediaPlaybackSkill({ id: 'settings.device_info.read' }, { inputs: {} }), null);
});
