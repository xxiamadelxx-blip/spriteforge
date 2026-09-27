import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';

const AI_PACKAGE = 'ai.qwenlm.chat.android';
const OPERA = 'com.opera.browser';
const PROMPT = 'Ответь ровно: M5_OK';
const COMPOSER = { kind: 'CLASS_NAME', value: 'android.widget.EditText' };

function aiSnapshot({ composer = '', sent = false } = {}) {
  const nodes = [{
    handle: 'composer',
    class_name: 'android.widget.EditText',
    text: composer,
    editable: true,
    clickable: true,
    enabled: true,
    sensitive: false,
    visible_to_user: true,
    window_type: 'APPLICATION',
    window_package: AI_PACKAGE,
    bounds: { left: 100, top: 1800, right: 800, bottom: 1950 },
    depth: 4,
  }];
  if (composer) {
    nodes.push({
      handle: 'send',
      content_description: 'Send',
      class_name: 'android.view.View',
      editable: false,
      clickable: true,
      enabled: true,
      sensitive: false,
      visible_to_user: true,
      window_type: 'APPLICATION',
      window_package: AI_PACKAGE,
      bounds: { left: 850, top: 1800, right: 1000, bottom: 1950 },
      depth: 4,
    });
  }
  if (sent) {
    nodes.push({
      handle: 'sent-prompt',
      text: PROMPT,
      class_name: 'android.widget.TextView',
      editable: false,
      clickable: false,
      enabled: true,
      sensitive: false,
      visible_to_user: true,
      window_type: 'APPLICATION',
      window_package: AI_PACKAGE,
      bounds: { left: 300, top: 500, right: 950, bottom: 620 },
      depth: 4,
    });
  }
  return {
    package: AI_PACKAGE,
    revision: 10,
    display_id: 0,
    authorization_required: false,
    privacy_mode: 'NORMAL',
    redacted: false,
    semantic_tree_complete: true,
    truncated: false,
    nodes,
  };
}

test('B5 AI set-text emits a generic CIR-B postcondition scoped to the provider package', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'qwen',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: COMPOSER,
        value: PROMPT,
        sensitive: false,
      }],
    },
  });
  const snapshot = aiSnapshot({ composer: '' });
  const directive = await skill.next({
    state: skill.recognize(snapshot, context),
    snapshot,
    context,
  });

  assert.equal(directive.type, 'SET_TEXT_HANDLE');
  assert.deepEqual(directive.postcondition, {
    mode: 'transition',
    expr: {
      kind: 'node_field',
      selector: COMPOSER,
      scope: { window_type: 'APPLICATION', package: AI_PACKAGE },
      field: 'text',
      op: 'eq',
      value: PROMPT,
    },
  });
});

test('B5 AI Send emits one generic postcondition for sent prompt plus cleared composer', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'qwen',
      steps: [
        {
          type: 'SET_TEXT_EXACT_SELECTOR',
          selector: COMPOSER,
          value: PROMPT,
          sensitive: false,
        },
        { type: 'CLICK_EXACT_TEXT', text: 'Send' },
      ],
    },
  });

  const before = aiSnapshot({ composer: '' });
  const setText = await skill.next({
    state: skill.recognize(before, context),
    snapshot: before,
    context,
  });
  await skill.acceptResult({
    directive: setText,
    primitiveResult: { structuredContent: { status: 'ERROR', error_code: 'ACTION_NOT_VERIFIED', action_dispatched: true } },
    semanticResult: { result: 'VERIFIED' },
    context,
  });

  const ready = aiSnapshot({ composer: PROMPT });
  const send = await skill.next({
    state: skill.recognize(ready, context),
    snapshot: ready,
    context,
  });

  assert.equal(send.type, 'CLICK_HANDLE');
  assert.equal(send.handle, 'send');
  assert.deepEqual(send.postcondition, {
    mode: 'transition',
    expr: {
      kind: 'all',
      children: [
        {
          kind: 'node_field_transition',
          selector: COMPOSER,
          scope: { window_type: 'APPLICATION', package: AI_PACKAGE },
          field: 'text',
          from: PROMPT,
          to: '',
        },
        {
          kind: 'node_field',
          selector: { kind: 'TEXT', value: PROMPT },
          scope: { window_type: 'APPLICATION', package: AI_PACKAGE },
          field: 'editable',
          op: 'eq',
          value: false,
        },
      ],
    },
  });
});

function browserSnapshot(nodes) {
  return {
    package: OPERA,
    revision: 20,
    display_id: 0,
    authorization_required: false,
    privacy_mode: 'NORMAL',
    redacted: false,
    semantic_tree_complete: true,
    truncated: false,
    nodes,
  };
}

const destinationMarker = { kind: 'TEXT', value: 'Target dashboard' };

test('B5 browser submit binds exact destination marker to the generic CIR-B verifier', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'example.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: 'https://example.com/target',
        destination_marker: destinationMarker,
      }],
    },
  });
  context.navigation_phase = 'submit';

  const snapshot = browserSnapshot([{
    handle: 'go',
    text: 'Go',
    editable: false,
    clickable: true,
    enabled: true,
    sensitive: false,
    visible_to_user: true,
    window_type: 'APPLICATION',
    window_package: OPERA,
    bounds: { left: 900, top: 0, right: 1000, bottom: 100 },
    depth: 1,
  }]);
  const directive = await skill.next({ state: 'BROWSER', snapshot, context });

  assert.equal(directive.type, 'CLICK_HANDLE');
  assert.equal(directive.navigation_submit, true);
  assert.deepEqual(directive.postcondition, {
    mode: 'transition',
    expr: {
      kind: 'node_present',
      selector: destinationMarker,
      scope: { window_type: 'APPLICATION', package: OPERA },
    },
  });
});

test('B5 browser contracted submit advances only after semantic VERIFIED', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'example.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: 'https://example.com/target',
        destination_marker: destinationMarker,
      }],
    },
  });
  context.navigation_phase = 'submit';
  const directive = {
    type: 'CLICK_HANDLE',
    handle: 'go',
    step_index: 0,
    navigation_submit: true,
    postcondition: {
      mode: 'transition',
      expr: {
        kind: 'node_present',
        selector: destinationMarker,
        scope: { window_type: 'APPLICATION', package: OPERA },
      },
    },
  };

  await skill.acceptResult({
    directive,
    primitiveResult: { structuredContent: { status: 'ERROR', error_code: 'ACTION_NOT_VERIFIED', action_dispatched: true } },
    semanticResult: { result: 'POSTCONDITION_NOT_MET' },
    context,
  });
  assert.equal(context.index, 0);
  assert.equal(context.navigation_phase, 'submit');

  await skill.acceptResult({
    directive,
    primitiveResult: { structuredContent: { status: 'ERROR', error_code: 'ACTION_NOT_VERIFIED', action_dispatched: true } },
    semanticResult: { result: 'VERIFIED' },
    context,
  });
  assert.equal(context.index, 1);
  assert.equal(context.navigation_phase, null);
});


test('B5 browser malformed destination marker fails closed instead of downgrading to legacy navigation', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'example.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: 'https://example.com/target',
        destination_marker: { kind: 'HANDLE', value: 'snapshot-bound-handle' },
      }],
    },
  });
  context.navigation_phase = 'submit';

  const snapshot = browserSnapshot([{
    handle: 'go',
    text: 'Go',
    editable: false,
    clickable: true,
    enabled: true,
    sensitive: false,
    visible_to_user: true,
    window_type: 'APPLICATION',
    window_package: OPERA,
    bounds: { left: 900, top: 0, right: 1000, bottom: 100 },
    depth: 1,
  }]);

  const directive = await skill.next({ state: 'BROWSER', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(context.index, 0);
  assert.equal(context.navigation_phase, 'submit');
});


test('B5 AI contracted set-text rejects a non-application composer target before dispatch', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'qwen',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: COMPOSER,
        value: PROMPT,
        sensitive: false,
      }],
    },
  });
  const snapshot = aiSnapshot({ composer: '' });
  snapshot.nodes[0] = {
    ...snapshot.nodes[0],
    window_type: 'INPUT_METHOD',
    window_package: 'com.example.keyboard',
  };
  snapshot.nodes.push({
    handle: 'app-root',
    text: 'Qwen',
    editable: false,
    clickable: false,
    enabled: true,
    sensitive: false,
    visible_to_user: true,
    window_type: 'APPLICATION',
    window_package: AI_PACKAGE,
    bounds: { left: 0, top: 0, right: 1080, bottom: 1700 },
    depth: 1,
  });

  const directive = await skill.next({
    state: skill.recognize(snapshot, context),
    snapshot,
    context,
  });

  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(context.index, 0);
});

test('B5 browser contracted submit rejects a non-Opera application control before dispatch', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'example.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: 'https://example.com/target',
        destination_marker: destinationMarker,
      }],
    },
  });
  context.navigation_phase = 'submit';

  const snapshot = browserSnapshot([{
    handle: 'go',
    text: 'Go',
    editable: false,
    clickable: true,
    enabled: true,
    sensitive: false,
    visible_to_user: true,
    window_type: 'INPUT_METHOD',
    window_package: 'com.example.keyboard',
    bounds: { left: 900, top: 0, right: 1000, bottom: 100 },
    depth: 1,
  }, {
    handle: 'opera-root',
    text: 'Opera',
    editable: false,
    clickable: false,
    enabled: true,
    sensitive: false,
    visible_to_user: true,
    window_type: 'APPLICATION',
    window_package: OPERA,
    bounds: { left: 0, top: 100, right: 1080, bottom: 1800 },
    depth: 1,
  }]);

  const directive = await skill.next({ state: 'BROWSER', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(context.index, 0);
});
