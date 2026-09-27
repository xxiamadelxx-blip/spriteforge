import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRuntime } from '../src/skills/runtime.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';

const PROMPT = 'Ответь ровно: M5_OK';

function snapshot(revision, { composer = '', sent = false, response = false } = {}) {
  const nodes = [
    {
      handle: 'composer',
      class_name: 'android.widget.EditText',
      text: composer,
      editable: true,
      clickable: true,
      enabled: true,
      sensitive: false,
      visible_to_user: true,
      window_type: 'APPLICATION',
      window_package: 'ai.qwenlm.chat.android',
      bounds: { left: 100, top: 1800, right: 800, bottom: 1950 },
      depth: 4,
    },
  ];
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
      window_package: 'ai.qwenlm.chat.android',
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
      window_package: 'ai.qwenlm.chat.android',
      bounds: { left: 300, top: 500, right: 950, bottom: 620 },
      depth: 4,
    });
  }
  if (response) {
    nodes.push({
      handle: 'response',
      text: 'M5_OK',
      class_name: 'android.widget.TextView',
      editable: false,
      clickable: false,
      enabled: true,
      sensitive: false,
      visible_to_user: true,
      window_type: 'APPLICATION',
      window_package: 'ai.qwenlm.chat.android',
      bounds: { left: 50, top: 700, right: 400, bottom: 820 },
      depth: 4,
    });
  }
  return {
    isError: false,
    structuredContent: {
      status: 'OK',
      package: 'ai.qwenlm.chat.android',
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

function buildRuntime(observations) {
  const calls = [];
  let observeIndex = 0;
  let clickCount = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createAiAssistantPlanSkill()]),
    sleep: async () => {},
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        const value = observations[Math.min(observeIndex, observations.length - 1)];
        observeIndex += 1;
        return value;
      }
      if (name === 'ui.set_text') {
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
            message: 'Set text completed but verification was early.',
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
            message: 'Click completed but verification was early.',
          },
        };
      }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });
  return { runtime, calls, getClickCount: () => clickCount };
}

const steps = [
  {
    type: 'SET_TEXT_EXACT_SELECTOR',
    selector: { kind: 'CLASS_NAME', value: 'android.widget.EditText' },
    value: PROMPT,
    sensitive: false,
  },
  { type: 'CLICK_EXACT_TEXT', text: 'Send' },
  { type: 'ASSERT_EXACT_TEXT', text: 'M5_OK' },
];

test('AI assistant proves delayed composer and send actions without replay', async () => {
  const { runtime, calls, getClickCount } = buildRuntime([
    snapshot(1, { composer: '' }),
    snapshot(2, { composer: PROMPT }),
    snapshot(3, { composer: PROMPT }),
    snapshot(4, { composer: PROMPT }),
    snapshot(5, { composer: '', sent: true, response: true }),
    snapshot(6, { composer: '', sent: true, response: true }),
    snapshot(7, { composer: '', sent: true, response: true }),
  ]);

  const output = await runtime.run({
    skillId: 'ai.assistant.run_plan',
    inputs: { provider: 'qwen', steps },
    limits: { maxTransitions: 20, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(calls.filter((entry) => entry.name === 'ui.set_text').length, 1);
  assert.equal(getClickCount(), 1);
  assert.equal(output.trace.filter((entry) => entry.type === 'ATTEMPT').length, 2);
  assert.equal(
    output.trace.filter((entry) => entry.type === 'SEMANTIC_RESULT' && entry.result === 'VERIFIED').length,
    2,
  );
});

test('AI assistant stops when delayed Send cannot be proven and never replays Send', async () => {
  const { runtime, getClickCount } = buildRuntime([
    snapshot(1, { composer: '' }),
    snapshot(2, { composer: PROMPT }),
    snapshot(3, { composer: PROMPT }),
    snapshot(4, { composer: PROMPT, sent: false, response: false }),
    snapshot(5, { composer: PROMPT, sent: false, response: false }),
  ]);

  const output = await runtime.run({
    skillId: 'ai.assistant.run_plan',
    inputs: { provider: 'qwen', steps },
    limits: { maxTransitions: 20, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'POSTCONDITION_NOT_MET');
  assert.equal(getClickCount(), 1);
});
