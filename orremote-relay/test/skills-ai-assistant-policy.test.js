import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';
import { authorizeAiAssistantSkill } from '../src/skills/ai/safety.js';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';

const basePolicy = createDefaultSkillSafetyPolicy({ panicSwitch: () => false });
const skill = createAiAssistantPlanSkill();

function authorize(inputs) {
  const ai = authorizeAiAssistantSkill(skill, { inputs });
  return ai ?? basePolicy.authorizeSkill(skill, { inputs });
}

test('AI assistant policy allows bounded normal prompt plans', () => {
  const result = authorize({
    provider: 'claude',
    delegation_depth: 0,
    steps: [
      { type: 'SET_TEXT_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'prompt' }, value: 'Summarize this idea.' },
      { type: 'CLICK_EXACT_TEXT', text: 'Send' },
    ],
  });
  assert.deepEqual(result, { ok: true });
});

test('AI assistant policy blocks secrets, account changes and recursive delegation', () => {
  const secret = authorize({
    provider: 'chatgpt',
    steps: [{ type: 'SET_TEXT_EXACT_SELECTOR', selector: { kind: 'TEXT', value: 'API token' }, value: 'secret' }],
  });
  assert.equal(secret.ok, false);
  assert.equal(secret.code, 'USER_AUTH_REQUIRED');

  const account = authorize({
    provider: 'gemini',
    steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Manage subscription' }],
  });
  assert.equal(account.ok, false);
  assert.equal(account.code, 'SKILL_ACTION_NOT_ALLOWED');

  const recursive = authorize({
    provider: 'chatgpt',
    delegation_depth: 2,
    steps: [],
  });
  assert.equal(recursive.ok, false);
  assert.equal(recursive.code, 'AI_DELEGATION_DEPTH_EXCEEDED');
});
