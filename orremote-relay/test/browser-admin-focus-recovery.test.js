import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRuntime } from '../src/skills/runtime.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';

function observed(revision, nodes) {
  return {
    structuredContent: {
      status: 'OK',
      package: 'com.opera.browser',
      revision,
      display_id: 0,
      authorization_required: false,
      nodes,
    },
    isError: false,
  };
}

const placeholder = {
  handle: 'start-page-omnibar',
  resource_id: 'com.opera.browser:id/top_omnibar_placeholder',
  content_description: 'Искать или задать вопрос',
  editable: false,
  clickable: true,
  enabled: true,
  sensitive: false,
  bounds: { left: 0, top: 275, right: 1080, bottom: 491 },
  depth: 5,
};

function focusedNodes() {
  return [
    {
      handle: 'editable-address',
      resource_id: 'com.opera.browser:id/editable_url_field',
      text: 'https://codemagic.io/apps',
      editable: true,
      clickable: true,
      enabled: true,
      sensitive: false,
      bounds: { left: 204, top: 143, right: 888, bottom: 311 },
      depth: 4,
    },
    {
      handle: 'go',
      resource_id: 'com.opera.browser:id/action_go',
      content_description: 'Перейти',
      editable: false,
      clickable: true,
      enabled: true,
      sensitive: false,
      bounds: { left: 888, top: 155, right: 1008, bottom: 299 },
      depth: 4,
    },
  ];
}

test('browser navigation re-observes after delayed Opera focus verification', async () => {
  const calls = [];
  let observeCount = 0;
  let clickCount = 0;
  const registry = createSkillRegistry([createBrowserAdminRunPlanSkill()]);
  const runtime = createSkillRuntime({
    registry,
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        observeCount += 1;
        if (observeCount === 1) return observed(1, [placeholder]);
        if (observeCount === 2 || observeCount === 3) return observed(observeCount, focusedNodes());
        return observed(4, []);
      }
      if (name === 'ui.click') {
        clickCount += 1;
        if (clickCount === 1) {
          return {
            isError: true,
            structuredContent: {
              status: 'ERROR',
              error_code: 'ACTION_NOT_VERIFIED',
              message: 'Click succeeded, but accessibility verification was early.',
            },
          };
        }
        return { isError: false, structuredContent: { status: 'VERIFIED' } };
      }
      if (name === 'ui.set_text') {
        return { isError: false, structuredContent: { status: 'VERIFIED' } };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: 'browser.admin.run_plan',
    inputs: {
      domain: 'codemagic.io',
      steps: [{ type: 'NAVIGATE_URL', url: 'https://codemagic.io/apps' }],
    },
    limits: { maxTransitions: 10, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(calls.map((entry) => entry.name), [
    'screen.observe',
    'ui.click',
    'screen.observe',
    'ui.set_text',
    'screen.observe',
    'ui.click',
    'screen.observe',
  ]);
  assert.equal(calls[1].args.selector_value, 'start-page-omnibar');
  assert.equal(calls[3].args.selector_value, 'editable-address');
  assert.equal(calls[3].args.value, 'https://codemagic.io/apps');
  assert.equal(calls[5].args.selector_value, 'go');
  assert.equal(output.trace.some((entry) => entry.result === 'ACTION_NOT_VERIFIED'), true);
});
