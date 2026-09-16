import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSkillRegistry } from '../src/skills/index.js';
import { normalizeBrowserAdminPolicyInputs } from '../src/skills/browser/policy-inputs.js';

function browserSnapshot() {
  return {
    package: 'com.opera.browser',
    revision: 7,
    nodes: [
      {
        handle: 'address-handle',
        resource_id: 'com.opera.browser:id/url_field',
        content_description: 'Address',
        editable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 600, bottom: 100 },
        depth: 1,
      },
    ],
  };
}

test('browser admin site-home step is normalized before policy and execution', async () => {
  const normalized = normalizeBrowserAdminPolicyInputs({
    site: 'render',
    domain: 'render.com',
    steps: [{ type: 'NAVIGATE_SITE_HOME' }],
  });
  assert.deepEqual(normalized.steps, [
    { type: 'NAVIGATE_URL', url: 'https://dashboard.render.com/' },
  ]);

  const skill = createDefaultSkillRegistry().get('browser.admin.run_plan');
  const context = skill.createContext({
    inputs: {
      site: 'render',
      domain: 'render.com',
      steps: [{ type: 'NAVIGATE_SITE_HOME' }],
    },
  });
  const directive = await skill.next({
    state: 'BROWSER',
    snapshot: browserSnapshot(),
    context,
  });
  assert.equal(directive.type, 'SET_TEXT_HANDLE');
  assert.equal(directive.handle, 'address-handle');
  assert.equal(directive.value, 'https://dashboard.render.com/');
  assert.equal(directive.navigation_enter, true);
});
