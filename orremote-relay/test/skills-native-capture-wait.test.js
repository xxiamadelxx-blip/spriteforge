import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';

function node(overrides = {}) {
  return {
    depth: 1,
    handle: 'h',
    enabled: true,
    clickable: false,
    editable: false,
    sensitive: false,
    bounds: { left: 0, top: 0, right: 500, bottom: 100 },
    ...overrides,
  };
}

function snap(pkg, nodes = [], revision = 7) {
  return { package: pkg, revision, authorization_required: false, nodes };
}

test('AI plan waits for exact answer selector and captures non-sensitive text', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'claude',
      steps: [
        {
          type: 'WAIT_FOR_EXACT_SELECTOR',
          selector: { kind: 'RESOURCE_ID', value: 'assistant-answer' },
          max_attempts: 3,
          poll_ms: 250,
        },
        {
          type: 'CAPTURE_EXACT_SELECTOR_TEXT',
          selector: { kind: 'RESOURCE_ID', value: 'assistant-answer' },
          key: 'answer',
        },
      ],
    },
  });

  const first = await skill.next({ state: 'TARGET_APP', snapshot: snap('com.anthropic.claude'), context });
  assert.deepEqual(first, { type: 'WAIT', duration_ms: 250, step_index: 0 });

  const answerSnapshot = snap('com.anthropic.claude', [
    node({ resource_id: 'assistant-answer', text: 'Three concise bullet points.' }),
  ]);
  const found = await skill.next({ state: 'TARGET_APP', snapshot: answerSnapshot, context });
  assert.deepEqual(found, { type: 'OBSERVE' });
  assert.equal(context.index, 1);

  const captured = await skill.next({ state: 'TARGET_APP', snapshot: answerSnapshot, context });
  assert.deepEqual(captured, { type: 'OBSERVE' });
  assert.deepEqual(context.captures, { answer: 'Three concise bullet points.' });

  const complete = await skill.next({ state: 'TARGET_APP', snapshot: answerSnapshot, context });
  assert.equal(complete.type, 'COMPLETE');
  assert.deepEqual(complete.output.captures, { answer: 'Three concise bullet points.' });
});

test('AI plan blocks exact capture when target contains sensitive descendants', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'qwen',
      steps: [{
        type: 'CAPTURE_EXACT_SELECTOR_TEXT',
        selector: { kind: 'RESOURCE_ID', value: 'answer-container' },
        key: 'answer',
      }],
    },
  });
  const snapshot = snap('ai.qwenlm.chat.android', [
    node({
      depth: 1,
      handle: 'container',
      resource_id: 'answer-container',
      bounds: { left: 0, top: 0, right: 500, bottom: 200 },
    }),
    node({
      depth: 2,
      handle: 'secret-child',
      text: 'protected child value',
      sensitive: true,
      bounds: { left: 20, top: 20, right: 480, bottom: 100 },
    }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});
