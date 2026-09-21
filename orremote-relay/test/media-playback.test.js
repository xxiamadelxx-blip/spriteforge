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


test('media playback seek uses a fresh semantic seek target and bounded fraction', async () => {
  const skill = createMediaPlaybackPlanSkill();
  const seekSnapshot = {
    package: 'ru.yandex.music',
    revision: 9,
    nodes: [{
      handle: 'seek',
      text: null,
      content_description: 'Playback progress',
      resource_id: 'player_progress',
      class_name: 'android.widget.SeekBar',
      clickable: true,
      editable: false,
      enabled: true,
      sensitive: false,
      bounds: { left: 100, top: 400, right: 900, bottom: 500 },
      depth: 1,
    }],
  };
  const context = skill.createContext({
    inputs: {
      provider: 'yandex_music',
      steps: [{
        type: 'SEEK_EXACT_SELECTOR_FRACTION',
        selector: { kind: 'RESOURCE_ID', value: 'player_progress' },
        fraction: 0.5,
      }],
    },
  });

  const directive = await skill.next({ state: 'TARGET_APP', snapshot: seekSnapshot, context });
  assert.deepEqual(directive, {
    type: 'TAP_POINT',
    x: 500,
    y: 450,
    selector: { kind: 'RESOURCE_ID', value: 'player_progress' },
    fraction: 0.5,
    playback_seek: true,
    step_index: 0,
  });
  assert.deepEqual(
    await skill.validateDirective({ state: 'TARGET_APP', snapshot: seekSnapshot, directive, context }),
    { ok: true },
  );
});

test('media playback seek fails closed on non-seek semantic targets', async () => {
  const skill = createMediaPlaybackPlanSkill();
  const badSnapshot = snapshot('Play');
  const context = skill.createContext({
    inputs: {
      provider: 'yandex_music',
      steps: [{
        type: 'SEEK_EXACT_SELECTOR_FRACTION',
        selector: { kind: 'RESOURCE_ID', value: 'player-control' },
        fraction: 0.5,
      }],
    },
  });
  const directive = await skill.next({ state: 'TARGET_APP', snapshot: badSnapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'MEDIA_SEEK_TARGET_NOT_ALLOWED');
});


test('media playback accepts a pause child owned by a clickable playback ancestor', async () => {
  const skill = createMediaPlaybackPlanSkill();
  const playerSnapshot = {
    package: 'ru.kinopoisk',
    revision: 12,
    nodes: [
      {
        handle: 'play-pause',
        resource_id: 'play_pause',
        class_name: 'PlayerControlsView',
        clickable: true,
        editable: false,
        enabled: true,
        sensitive: false,
        depth: 1,
        bounds: { left: 400, top: 900, right: 680, bottom: 1120 },
      },
      {
        handle: 'pause-label',
        content_description: 'Поставить на паузу',
        class_name: 'PlayerPauseImage',
        clickable: false,
        editable: false,
        enabled: true,
        sensitive: false,
        depth: 2,
        bounds: { left: 440, top: 940, right: 640, bottom: 1080 },
      },
    ],
  };
  const context = skill.createContext({
    inputs: {
      provider: 'kinopoisk',
      steps: [{
        type: 'CLICK_EXACT_SELECTOR',
        selector: { kind: 'CONTENT_DESCRIPTION', value: 'Поставить на паузу' },
      }],
    },
  });
  const directive = await skill.next({ state: 'TARGET_APP', snapshot: playerSnapshot, context });
  assert.deepEqual(directive, { type: 'CLICK_HANDLE', handle: 'play-pause', step_index: 0 });
  assert.deepEqual(
    await skill.validateDirective({ snapshot: playerSnapshot, directive, context }),
    { ok: true },
  );
});

test('media playback accepts bounded rewind, forward, and timeline seek controls', async () => {
  const skill = createMediaPlaybackPlanSkill();
  for (const [handle, resourceId, label] of [
    ['rewind-back', 'PlayerRewindBackwardButton', 'Перемотать на 10 секунд назад'],
    ['rewind-forward', 'PlayerRewindForwardButton', 'Перемотать на 10 секунд вперед'],
  ]) {
    const snapshot = {
      package: 'ru.kinopoisk',
      revision: 13,
      nodes: [{
        handle,
        resource_id: resourceId,
        content_description: label,
        clickable: true,
        editable: false,
        enabled: true,
        sensitive: false,
        depth: 1,
        bounds: { left: 0, top: 0, right: 120, bottom: 120 },
      }],
    };
    const context = skill.createContext({
      inputs: {
        provider: 'kinopoisk',
        steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'HANDLE', value: handle } }],
      },
    });
    const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
    assert.equal(directive.type, 'CLICK_HANDLE', label);
    assert.deepEqual(await skill.validateDirective({ snapshot, directive, context }), { ok: true }, label);
  }

  const timelineSnapshot = {
    package: 'ru.kinopoisk',
    revision: 14,
    nodes: [{
      handle: 'timeline',
      resource_id: 'ProgressbarTimeline',
      class_name: 'android.widget.SeekBar',
      clickable: true,
      editable: false,
      enabled: true,
      sensitive: false,
      depth: 1,
      bounds: { left: 100, top: 400, right: 900, bottom: 500 },
    }],
  };
  const context = skill.createContext({
    inputs: {
      provider: 'kinopoisk',
      steps: [{
        type: 'SEEK_EXACT_SELECTOR_FRACTION',
        selector: { kind: 'RESOURCE_ID', value: 'ProgressbarTimeline' },
        fraction: 0.5,
      }],
    },
  });
  const directive = await skill.next({ state: 'TARGET_APP', snapshot: timelineSnapshot, context });
  assert.equal(directive.type, 'TAP_POINT');
  assert.equal(directive.playback_seek, true);
  assert.deepEqual(await skill.validateDirective({ snapshot: timelineSnapshot, directive, context }), { ok: true });
});

test('media playback blocks persistent or commercial controls adjacent to player controls', async () => {
  const skill = createMediaPlaybackPlanSkill();
  for (const label of ['Like', 'Favorite', 'Добавить в Коллекцию', 'Download', 'Buy', 'Rent', 'Account']) {
    const snapshot = {
      package: 'ru.kinopoisk',
      revision: 15,
      nodes: [{
        handle: 'blocked-' + label,
        text: label,
        clickable: true,
        editable: false,
        enabled: true,
        sensitive: false,
        depth: 1,
        bounds: { left: 0, top: 0, right: 160, bottom: 80 },
      }],
    };
    const context = skill.createContext({
      inputs: {
        provider: 'kinopoisk',
        steps: [{ type: 'CLICK_EXACT_TEXT', text: label }],
      },
    });
    const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
    assert.equal(directive.type, 'STOP', label);
    assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED', label);
  }
});
