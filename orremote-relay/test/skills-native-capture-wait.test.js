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

test('native exact plan waits for an exact selector with bounded polling', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'chatgpt',
      steps: [{
        type: 'WAIT_FOR_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'assistant-answer' },
        max_attempts: 3,
        poll_ms: 250,
      }],
    },
  });

  const first = await skill.next({
    state: 'TARGET_APP',
    snapshot: snap('com.openai.chatgpt'),
    context,
  });
  assert.deepEqual(first, { type: 'WAIT', duration_ms: 250, step_index: 0 });
  assert.equal(context.index, 0);

  const second = await skill.next({
    state: 'TARGET_APP',
    snapshot: snap('com.openai.chatgpt', [node({ resource_id: 'assistant-answer', text: 'Ready' })]),
    context,
  });
  assert.deepEqual(second, { type: 'OBSERVE' });
  assert.equal(context.index, 1);
});

test('native exact plan captures exact non-sensitive selector text into structured output', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'claude',
      steps: [{
        type: 'CAPTURE_EXACT_SELECTOR_TEXT',
        selector: { kind: 'RESOURCE_ID', value: 'assistant-answer' },
        key: 'answer',
      }],
    },
  });
  const snapshot = snap('com.anthropic.claude', [
    node({ resource_id: 'assistant-answer', text: 'Three concise bullet points.' }),
  ]);

  const capture = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.deepEqual(capture, { type: 'OBSERVE' });
  assert.deepEqual(context.captures, { answer: 'Three concise bullet points.' });

  const complete = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(complete.type, 'COMPLETE');
  assert.deepEqual(complete.output.captures, { answer: 'Three concise bullet points.' });
});

test('native exact plan never captures a sensitive node', async () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'gemini',
      steps: [{
        type: 'CAPTURE_EXACT_SELECTOR_TEXT',
        selector: { kind: 'RESOURCE_ID', value: 'secret' },
        key: 'answer',
      }],
    },
  });
  const snapshot = snap('com.google.android.apps.bard', [
    node({ resource_id: 'secret', text: 'hidden', sensitive: true }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});

test('native exact plan never captures a container with sensitive descendants', async () => {
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
  const snapshot = snap('com.tongyi.intl', [
    node({
      depth: 1,
      handle: 'container',
      resource_id: 'answer-container',
      bounds: { left: 0, top: 0, right: 500, bottom: 200 },
    }),
    node({
      depth: 2,
      handle: 'child',
      text: 'protected child value',
      sensitive: true,
      bounds: { left: 20, top: 20, right: 480, bottom: 100 },
    }),
  ]);
  const directive = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});
