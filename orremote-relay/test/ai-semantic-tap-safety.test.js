import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';
import { authorizeAiAssistantSkill } from '../src/skills/ai/safety.js';

test('AI safety allows a semantic center tap for a non-sensitive composer placeholder', () => {
  const result = authorizeAiAssistantSkill(createAiAssistantPlanSkill(), {
    inputs: {
      provider: 'deepseek',
      steps: [{
        type: 'TAP_EXACT_SELECTOR_CENTER',
        selector: { kind: 'TEXT', value: 'Напишите или удерживайте, чтобы говорить' },
      }],
    },
  });
  assert.deepEqual(result, { ok: true });
});

test('AI safety rejects semantic taps targeting blocked account or payment controls', () => {
  const result = authorizeAiAssistantSkill(createAiAssistantPlanSkill(), {
    inputs: {
      provider: 'deepseek',
      steps: [{
        type: 'TAP_EXACT_SELECTOR_CENTER',
        selector: { kind: 'TEXT', value: 'Upgrade subscription' },
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
});
