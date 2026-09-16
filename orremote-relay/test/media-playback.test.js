import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaPlaybackPlanSkill } from '../src/skills/media/playback-plan.js';

function snapshot(text) {
  return {
    package: 'ru.yandex.music',
    revision: 4,
    nodes: [
      {
        handle: 'h-control',
        text,
        content_description: text,
        resource_id: 'player-control',
        class_name: 'android.widget.Button',
        clickable: true,
        editable: false,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        depth: 1,
      },
    ],
  };
}

test('media playback accepts actual playback controls', async () => {
  const skill = createMediaPlaybackPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'yandex_music',
      steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Play' }],
    },
  });
  assert.equal(context.target_package, 'ru.yandex.music');

  const directive = await skill.next({ state: 'TARGET_APP', snapshot: snapshot('Play'), context });
  assert.equal(directive.type, 'CLICK_HANDLE');
  const validation = await skill.validateDirective({
    state: 'TARGET_APP',
    snapshot: snapshot('Play'),
    directive,
    context,
  });
  assert.equal(validation.ok, true);
});

test('media playback refuses non-playback or persistent controls', async () => {
  const skill = createMediaPlaybackPlanSkill();
  for (const text of ['Like', 'Subscribe', 'Settings']) {
    const context = skill.createContext({
      inputs: {
        provider: 'yandex_music',
        steps: [{ type: 'CLICK_EXACT_TEXT', text }],
      },
    });
    const directive = await skill.next({ state: 'TARGET_APP', snapshot: snapshot(text), context });
    if (directive.type === 'STOP') {
      assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED');
      continue;
    }
    const validation = await skill.validateDirective({
      state: 'TARGET_APP',
      snapshot: snapshot(text),
      directive,
      context,
    });
    assert.equal(validation.ok, false);
  }
});
