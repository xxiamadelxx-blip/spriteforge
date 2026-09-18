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


test('media playback policy allows bounded semantic seek fractions only', () => {
  const skill = createMediaPlaybackPlanSkill();
  const ok = authorizeMediaPlaybackSkill(skill, {
    inputs: {
      provider: 'yandex_music',
      steps: [{
        type: 'SEEK_EXACT_SELECTOR_FRACTION',
        selector: { kind: 'RESOURCE_ID', value: 'player_progress' },
        fraction: 0.5,
      }],
    },
  });
  assert.deepEqual(ok, { ok: true });

  for (const fraction of [-0.1, 1.1, 'half']) {
    const denied = authorizeMediaPlaybackSkill(skill, {
      inputs: {
        provider: 'yandex_music',
        steps: [{
          type: 'SEEK_EXACT_SELECTOR_FRACTION',
          selector: { kind: 'RESOURCE_ID', value: 'player_progress' },
          fraction,
        }],
      },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'SKILL_ACTION_NOT_ALLOWED');
  }
});
