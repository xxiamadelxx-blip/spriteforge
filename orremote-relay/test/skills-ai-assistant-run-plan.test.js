import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistantPlanSkill } from '../src/skills/ai/assistant-plan.js';

const skill = createAiAssistantPlanSkill();

function promptSnapshot() {
  return {
    revision: 7,
    package: 'com.openai.chatgpt',
    nodes: [
      {
        handle: 'prompt-handle',
        resource_id: 'prompt',
        class_name: 'android.widget.EditText',
        editable: true,
        enabled: true,
        clickable: true,
        sensitive: false,
        depth: 1,
        bounds: { left: 10, top: 100, right: 700, bottom: 200 },
      },
      {
        handle: 'send-handle',
        text: 'Send',
        class_name: 'android.widget.Button',
        clickable: true,
        enabled: true,
        depth: 1,
        bounds: { left: 600, top: 210, right: 710, bottom: 300 },
      },
    ],
  };
}

test('AI assistant provider resolves to package and executes exact prompt plan', async () => {
  const context = skill.createContext({
    inputs: {
      provider: 'chatgpt',
      steps: [
        { type: 'SET_TEXT_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'prompt' }, value: 'Hello from Ø Remote' },
        { type: 'CLICK_EXACT_TEXT', text: 'Send' },
      ],
    },
  });

  const launch = await skill.next({ state: 'OTHER_APP', snapshot: { package: 'com.android.launcher' }, context });
  assert.deepEqual(launch, { type: 'LAUNCH', package: 'com.openai.chatgpt' });

  const snapshot = promptSnapshot();
  const enter = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(enter.type, 'SET_TEXT_HANDLE');
  assert.equal(enter.handle, 'prompt-handle');
  assert.equal(enter.value, 'Hello from Ø Remote');
  await skill.acceptResult({ directive: enter, context });

  const send = await skill.next({ state: 'TARGET_APP', snapshot, context });
  assert.equal(send.type, 'CLICK_HANDLE');
  assert.equal(send.handle, 'send-handle');
});
