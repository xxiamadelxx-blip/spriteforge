import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

const QWEN = 'ai.qwenlm.chat.android';
const OPERA = 'com.opera.browser';
const PROMPT = 'CIR-B-B5-PROMPT';

function appNode(pkg, overrides = {}) {
  return {
    depth: 1,
    handle: 'node',
    enabled: true,
    clickable: false,
    editable: false,
    sensitive: false,
    redacted: false,
    visible_to_user: true,
    window_id: 7,
    window_type: 'APPLICATION',
    window_package: pkg,
    bounds: { left: 0, top: 0, right: 500, bottom: 100 },
    ...overrides,
  };
}

function observed(pkg, revision, nodes) {
  return {
    isError: false,
    structuredContent: {
      status: 'OK',
      package: pkg,
      revision,
      display_id: 0,
      authorization_required: false,
      privacy_mode: 'NORMAL',
      redacted: false,
      semantic_tree_complete: true,
      truncated: false,
      nodes,
    },
  };
}

function aiObservation(revision, { composer = '', sent = false } = {}) {
  const nodes = [
    appNode(QWEN, {
      handle: 'composer',
      class_name: 'android.widget.EditText',
      text: composer,
      editable: true,
      clickable: true,
      bounds: { left: 20, top: 1500, right: 820, bottom: 1650 },
    }),
    appNode(QWEN, {
      handle: 'send',
      content_description: 'Send',
      class_name: 'android.view.View',
      clickable: true,
      bounds: { left: 850, top: 1500, right: 1000, bottom: 1650 },
    }),
  ];
  if (sent) {
    nodes.push(appNode(QWEN, {
      handle: 'sent-prompt',
      text: PROMPT,
      class_name: 'android.widget.TextView',
      bounds: { left: 200, top: 900, right: 900, bottom: 1050 },
    }));
  }
  return observed(QWEN, revision, nodes);
}

test('B5 AI set-text and Send are owned by the generic semantic verifier with one dispatch each', async () => {
  const observations = [
    aiObservation(1, { composer: '' }),
    aiObservation(2, { composer: PROMPT }),
    aiObservation(3, { composer: PROMPT }),
    aiObservation(4, { composer: PROMPT }),
    aiObservation(5, { composer: '', sent: true }),
    aiObservation(6, { composer: '', sent: true }),
    aiObservation(7, { composer: '', sent: true }),
  ];
  let observeIndex = 0;
  let setTextCount = 0;
  let clickCount = 0;

  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createAiAssistantPlanSkill()]),
    sleep: async () => {},
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        const value = observations[Math.min(observeIndex, observations.length - 1)];
        observeIndex += 1;
        return value;
      }
      if (name === 'ui.set_text') {
        setTextCount += 1;
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      if (name === 'ui.click') {
        clickCount += 1;
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: 'ai.assistant.run_plan',
    inputs: {
      provider: 'qwen',
      steps: [
        {
          type: 'SET_TEXT_EXACT_SELECTOR',
          selector: { kind: 'CLASS_NAME', value: 'android.widget.EditText' },
          value: PROMPT,
          sensitive: false,
        },
        { type: 'CLICK_EXACT_TEXT', text: 'Send' },
      ],
    },
    limits: { maxTransitions: 20, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(setTextCount, 1);
  assert.equal(clickCount, 1);
  assert.equal(output.trace.filter((entry) => entry.type === 'ATTEMPT').length, 2);
  assert.equal(
    output.trace.filter((entry) => entry.type === 'SEMANTIC_RESULT' && entry.result === 'VERIFIED').length,
    2,
  );
  assert.equal(output.trace.some((entry) => entry.result === 'AI_TEXT_NOT_VERIFIED'), false);
  assert.equal(output.trace.some((entry) => entry.result === 'AI_SEND_NOT_VERIFIED'), false);
});

test('B5 AI Send refuses a baseline where the exact prompt is already present and never dispatches Send', async () => {
  const observations = [
    aiObservation(1, { composer: '' }),
    aiObservation(2, { composer: PROMPT }),
    aiObservation(3, { composer: PROMPT }),
    aiObservation(4, { composer: PROMPT, sent: true }),
  ];
  let observeIndex = 0;
  let setTextCount = 0;
  let clickCount = 0;

  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createAiAssistantPlanSkill()]),
    sleep: async () => {},
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        const value = observations[Math.min(observeIndex, observations.length - 1)];
        observeIndex += 1;
        return value;
      }
      if (name === 'ui.set_text') {
        setTextCount += 1;
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      if (name === 'ui.click') {
        clickCount += 1;
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: 'ai.assistant.run_plan',
    inputs: {
      provider: 'qwen',
      steps: [
        {
          type: 'SET_TEXT_EXACT_SELECTOR',
          selector: { kind: 'CLASS_NAME', value: 'android.widget.EditText' },
          value: PROMPT,
          sensitive: false,
        },
        { type: 'CLICK_EXACT_TEXT', text: 'Send' },
      ],
    },
    limits: { maxTransitions: 20, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'POSTCONDITION_ALREADY_SATISFIED');
  assert.equal(setTextCount, 1);
  assert.equal(clickCount, 0);
});

function browserObservation(revision, { focused = false, url = '', destination = false } = {}) {
  const nodes = [];
  if (!focused) {
    nodes.push(appNode(OPERA, {
      handle: 'omnibar',
      resource_id: 'com.opera.browser:id/top_omnibar_placeholder',
      content_description: 'Search or enter address',
      clickable: true,
    }));
  } else {
    nodes.push(appNode(OPERA, {
      handle: 'address',
      resource_id: 'com.opera.browser:id/editable_url_field',
      text: url,
      editable: true,
      clickable: true,
    }));
    nodes.push(appNode(OPERA, {
      handle: 'go',
      resource_id: 'com.opera.browser:id/action_go',
      content_description: 'Go',
      clickable: true,
    }));
  }
  if (destination) {
    nodes.push(appNode(OPERA, {
      handle: 'destination',
      text: 'GitHub destination marker',
      class_name: 'android.view.View',
    }));
  }
  return observed(OPERA, revision, nodes);
}

test('B5 browser navigation advances only after the exact destination marker is semantically verified', async () => {
  const target = 'https://github.com/';
  const observations = [
    browserObservation(1),
    browserObservation(2, { focused: true, url: '' }),
    browserObservation(3, { focused: true, url: target }),
    browserObservation(4, { focused: true, url: target, destination: true }),
    browserObservation(5, { focused: true, url: target, destination: true }),
    browserObservation(6, { focused: true, url: target, destination: true }),
  ];
  let observeIndex = 0;
  let clickCount = 0;
  let setTextCount = 0;

  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createBrowserAdminRunPlanSkill()]),
    sleep: async () => {},
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        const value = observations[Math.min(observeIndex, observations.length - 1)];
        observeIndex += 1;
        return value;
      }
      if (name === 'ui.set_text') {
        setTextCount += 1;
        return { isError: false, structuredContent: { status: 'VERIFIED' } };
      }
      if (name === 'ui.click') {
        clickCount += 1;
        if (clickCount === 1) {
          return { isError: false, structuredContent: { status: 'VERIFIED' } };
        }
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: 'browser.admin.run_plan',
    inputs: {
      domain: 'github.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: target,
        destination_marker: { kind: 'TEXT', value: 'GitHub destination marker' },
      }],
    },
    limits: { maxTransitions: 20, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(setTextCount, 1);
  assert.equal(clickCount, 2);
  assert.equal(output.trace.filter((entry) => entry.type === 'ATTEMPT').length, 1);
  assert.equal(
    output.trace.filter((entry) => entry.type === 'SEMANTIC_RESULT' && entry.result === 'VERIFIED').length,
    1,
  );
});


test('B5 browser destination marker failure never replays submit or advances the step', async () => {
  const target = 'https://github.com/';
  const observations = [
    browserObservation(1),
    browserObservation(2, { focused: true, url: '' }),
    browserObservation(3, { focused: true, url: target }),
    browserObservation(4, { focused: true, url: target }),
    browserObservation(5, { focused: true, url: target }),
  ];
  let observeIndex = 0;
  let clickCount = 0;
  let setTextCount = 0;

  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createBrowserAdminRunPlanSkill()]),
    sleep: async () => {},
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        const value = observations[Math.min(observeIndex, observations.length - 1)];
        observeIndex += 1;
        return value;
      }
      if (name === 'ui.set_text') {
        setTextCount += 1;
        return { isError: false, structuredContent: { status: 'VERIFIED' } };
      }
      if (name === 'ui.click') {
        clickCount += 1;
        if (clickCount === 1) {
          return { isError: false, structuredContent: { status: 'VERIFIED' } };
        }
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: 'browser.admin.run_plan',
    inputs: {
      domain: 'github.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: target,
        destination_marker: { kind: 'TEXT', value: 'GitHub destination marker' },
      }],
    },
    limits: { maxTransitions: 20, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'POSTCONDITION_NOT_MET');
  assert.equal(setTextCount, 1);
  assert.equal(clickCount, 2);
  assert.equal(
    output.trace.filter((entry) => entry.type === 'SEMANTIC_RESULT' && entry.result === 'POSTCONDITION_NOT_MET').length,
    1,
  );
});


test('B5 browser navigation on a secondary display fails closed before the first action', async () => {
  const target = 'https://github.com/';
  const observation = browserObservation(1);
  observation.structuredContent.display_id = 1;
  let clickCount = 0;
  let setTextCount = 0;

  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createBrowserAdminRunPlanSkill()]),
    sleep: async () => {},
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') return observation;
      if (name === 'ui.click') {
        clickCount += 1;
        return { isError: false, structuredContent: { status: 'VERIFIED' } };
      }
      if (name === 'ui.set_text') {
        setTextCount += 1;
        return { isError: false, structuredContent: { status: 'VERIFIED' } };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: 'browser.admin.run_plan',
    inputs: {
      domain: 'github.com',
      steps: [{
        type: 'NAVIGATE_URL',
        url: target,
        destination_marker: { kind: 'TEXT', value: 'GitHub destination marker' },
      }],
    },
    limits: { maxTransitions: 10, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(clickCount, 0);
  assert.equal(setTextCount, 0);
});
