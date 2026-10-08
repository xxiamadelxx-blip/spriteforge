import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';

test('AI assistant plan resolves provider to the locked package', () => {
  const skill = createAiAssistantPlanSkill();
  const context = skill.createContext({
    inputs: {
      provider: 'qwen',
      steps: [],
    },
  });
  assert.equal(context.target_package, 'ai.qwenlm.chat.android');
});

test('AI assistant plan declares the bounded conversation-write contract', () => {
  const skill = createAiAssistantPlanSkill();
  assert.equal(skill.id, 'ai.assistant.run_plan');
  assert.equal(skill.safety.effect, 'conversation_write');
  assert.equal(skill.safety.risk, 'R2');
  assert.equal(skill.packages.includes('com.openai.chatgpt'), true);
  assert.equal(skill.packages.includes('ai.qwenlm.chat.android'), true);
  assert.equal(skill.packages.includes('com.google.android.apps.bard'), true);
  assert.equal(skill.packages.includes('com.suno.android'), true);
});
