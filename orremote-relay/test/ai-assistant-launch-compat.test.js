import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRuntime } from '../src/skills/runtime.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';

function observed(pkg, revision) {
  return { isError: false, structuredContent: { status: 'OK', package: pkg, revision, display_id: 0, authorization_required: false, nodes: [] } };
}

test('AI launch ACTION_NOT_VERIFIED is recovered only by a fresh observe, without replaying launch', async () => {
  const calls = [];
  let observes = 0;
  let launches = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createAiAssistantPlanSkill()]),
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') { observes += 1; return observes === 1 ? observed('com.openai.chatgpt', 10) : observed('ai.qwenlm.chat.android', 11); }
      if (name === 'app.launch') { launches += 1; return { isError: true, structuredContent: { status: 'DISPATCHED_NOT_VERIFIED', error_code: 'APP_LAUNCH_NOT_VERIFIED' } }; }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });
  const output = await runtime.run({ skillId: 'ai.assistant.run_plan', inputs: { provider: 'qwen', steps: [] }, limits: { maxTransitions: 8, deadlineMs: 10_000 } });
  assert.equal(output.status, 'COMPLETED');
  assert.equal(launches, 1);
  assert.equal(calls.filter((entry) => entry.name === 'screen.observe').length >= 2, true);
});

test('Gemini recognizes its physically observed Google runtime package after Bard launch alias', async () => {
  let launches = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createAiAssistantPlanSkill()]),
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') return observed('com.google.android.googlequicksearchbox', 224);
      if (name === 'app.launch') { launches += 1; throw new Error('Gemini should not relaunch when its known runtime package is already foreground'); }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });
  const output = await runtime.run({ skillId: 'ai.assistant.run_plan', inputs: { provider: 'gemini', steps: [] }, limits: { maxTransitions: 4, deadlineMs: 10_000 } });
  assert.equal(output.status, 'COMPLETED');
  assert.equal(launches, 0);
});
