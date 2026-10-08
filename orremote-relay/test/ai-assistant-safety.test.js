import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';
import { authorizeAiAssistantSkill } from '../src/skills/ai/safety.js';

test('AI assistant safety allows bounded non-sensitive prompt workflows', () => {
  const skill = createAiAssistantPlanSkill();
  const result = authorizeAiAssistantSkill(skill, {
    inputs: {
      provider: 'chatgpt',
      delegation_depth: 1,
      steps: [
        {
          type: 'SET_TEXT_EXACT_SELECTOR',
          selector: { kind: 'RESOURCE_ID', value: 'composer' },
          value: 'Summarize this document in three bullets.',
        },
        { type: 'CLICK_EXACT_TEXT', text: 'Send' },
        {
          type: 'WAIT_FOR_EXACT_SELECTOR',
          selector: { kind: 'RESOURCE_ID', value: 'assistant-answer' },
          max_attempts: 20,
          poll_ms: 500,
        },
        {
          type: 'CAPTURE_EXACT_SELECTOR_TEXT',
          selector: { kind: 'RESOURCE_ID', value: 'assistant-answer' },
          key: 'answer',
        },
      ],
    },
  });
  assert.deepEqual(result, { ok: true });
});

test('AI assistant safety blocks secrets and account or payment actions', () => {
  const skill = createAiAssistantPlanSkill();
  const secret = authorizeAiAssistantSkill(skill, {
    inputs: {
      provider: 'claude',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'api_token' },
        value: 'never-allowed',
      }],
    },
  });
  assert.equal(secret.ok, false);
  assert.equal(secret.code, 'USER_AUTH_REQUIRED');

  const secretCapture = authorizeAiAssistantSkill(skill, {
    inputs: {
      provider: 'qwen',
      steps: [{
        type: 'CAPTURE_EXACT_SELECTOR_TEXT',
        selector: { kind: 'RESOURCE_ID', value: 'otp_code' },
        key: 'answer',
      }],
    },
  });
  assert.equal(secretCapture.ok, false);
  assert.equal(secretCapture.code, 'USER_AUTH_REQUIRED');

  const billing = authorizeAiAssistantSkill(skill, {
    inputs: {
      provider: 'gemini',
      steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Upgrade subscription' }],
    },
  });
  assert.equal(billing.ok, false);
  assert.equal(billing.code, 'SKILL_ACTION_NOT_ALLOWED');
});

test('AI assistant safety limits recursive delegation and package spoofing', () => {
  const skill = createAiAssistantPlanSkill();
  const depth = authorizeAiAssistantSkill(skill, {
    inputs: { provider: 'chatgpt', delegation_depth: 2, steps: [] },
  });
  assert.equal(depth.ok, false);
  assert.equal(depth.code, 'AI_DELEGATION_DEPTH_EXCEEDED');

  const spoof = authorizeAiAssistantSkill(skill, {
    inputs: {
      provider: 'deepseek',
      package: 'com.openai.chatgpt',
      steps: [],
    },
  });
  assert.equal(spoof.ok, false);
  assert.equal(spoof.code, 'SKILL_PACKAGE_NOT_ALLOWED');
});
