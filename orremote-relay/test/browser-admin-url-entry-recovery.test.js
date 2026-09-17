import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRuntime } from '../src/skills/runtime.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createBrowserAdminSkill } from '../src/skills/browser/augmented-skill.js';

function observed(revision, url) {
  return {
    isError: false,
    structuredContent: {
      status: 'OK',
      package: 'com.opera.browser',
      revision,
      display_id: 0,
      authorization_required: false,
      nodes: [
        {
          handle: 'editable-address',
          resource_id: 'com.opera.browser:id/editable_url_field',
          text: url,
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
      ],
    },
  };
}

function runtimeWithObservedUrls(urls) {
  const calls = [];
  let observeIndex = 0;
  let clickCount = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createBrowserAdminSkill()]),
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        const url = urls[Math.min(observeIndex, urls.length - 1)];
        observeIndex += 1;
        return observed(observeIndex, url);
      }
      if (name === 'ui.click') {
        clickCount += 1;
        return { isError: false, structuredContent: { status: 'VERIFIED', clickCount } };
      }
      if (name === 'ui.set_text') {
        return {
          isError: true,
          structuredContent: {
            status: 'ERROR',
            error_code: 'ACTION_NOT_VERIFIED',
            message: 'Text was applied but verification was early.',
          },
        };
      }
      throw new Error(`Unexpected primitive: ${name}`);
    },
  });
  return { runtime, calls };
}

test('browser navigation fresh-observes and proves exact URL after delayed set-text verification', async () => {
  const target = 'https://github.com/';
  const { runtime, calls } = runtimeWithObservedUrls([
    'https://old.example/',
    'https://old.example/',
    target,
    target,
    target,
  ]);

  const output = await runtime.run({
    skillId: 'browser.admin.run_plan',
    inputs: {
      site: 'github',
      domain: 'github.com',
      steps: [{ type: 'NAVIGATE_URL', url: target }],
    },
    limits: { maxTransitions: 12, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(calls.filter((entry) => entry.name === 'ui.set_text').length, 1);
  assert.equal(calls.filter((entry) => entry.name === 'ui.click').length, 2);
  assert.equal(calls.some((entry) => entry.name === 'ui.set_text' && entry.args.value === target), true);
  assert.equal(output.trace.some((entry) => entry.result === 'ACTION_NOT_VERIFIED'), true);
});

test('browser navigation stops when delayed set-text cannot be proven exactly', async () => {
  const target = 'https://github.com/';
  const { runtime, calls } = runtimeWithObservedUrls([
    'https://old.example/',
    'https://old.example/',
    'https://github.co/',
  ]);

  const output = await runtime.run({
    skillId: 'browser.admin.run_plan',
    inputs: {
      site: 'github',
      domain: 'github.com',
      steps: [{ type: 'NAVIGATE_URL', url: target }],
    },
    limits: { maxTransitions: 12, deadlineMs: 10_000 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'BROWSER_NAVIGATION_TEXT_NOT_VERIFIED');
  assert.equal(calls.filter((entry) => entry.name === 'ui.set_text').length, 1);
  assert.equal(calls.filter((entry) => entry.name === 'ui.click').length, 1);
});
