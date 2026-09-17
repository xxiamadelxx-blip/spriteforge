import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSkillRegistry } from '../src/skills/index.js';
import { normalizeBrowserAdminPolicyInputs } from '../src/skills/browser/policy-inputs.js';

function browserSnapshot({ focused = false, startPagePlaceholder = false } = {}) {
  const nodes = [];
  if (startPagePlaceholder && !focused) {
    nodes.push({
      handle: 'start-page-omnibar',
      resource_id: 'com.opera.browser:id/top_omnibar_placeholder',
      content_description: 'Искать или задать вопрос',
      editable: false,
      clickable: true,
      enabled: true,
      sensitive: false,
      bounds: { left: 0, top: 275, right: 1080, bottom: 491 },
      depth: 5,
    });
  } else {
    nodes.push({
      handle: 'address-handle',
      resource_id: 'com.opera.browser:id/url_field',
      content_description: 'Address',
      editable: true,
      clickable: true,
      enabled: true,
      bounds: { left: 0, top: 0, right: 600, bottom: 100 },
      depth: 1,
    });
  }
  if (focused) {
    nodes.push({
      handle: 'editable-address-handle',
      resource_id: 'com.opera.browser:id/editable_url_field',
      content_description: 'Search or enter address',
      editable: true,
      clickable: true,
      enabled: true,
      bounds: { left: 0, top: 0, right: 600, bottom: 100 },
      depth: 2,
    });
  }
  return {
    package: 'com.opera.browser',
    revision: focused ? 8 : 7,
    nodes,
  };
}

async function assertNavigationFocusAndEntry(initial) {
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

  const focusDirective = await skill.next({
    state: 'BROWSER',
    snapshot: initial,
    context,
  });
  assert.equal(focusDirective.type, 'CLICK_HANDLE');
  assert.equal(focusDirective.navigation_focus, true);
  assert.equal((await skill.validateDirective({ snapshot: initial, directive: focusDirective, context })).ok, true);
  await skill.acceptResult({ directive: focusDirective, context });

  const focused = browserSnapshot({ focused: true });
  const enterDirective = await skill.next({
    state: 'BROWSER',
    snapshot: focused,
    context,
  });
  assert.equal(enterDirective.type, 'SET_TEXT_HANDLE');
  assert.equal(enterDirective.handle, 'editable-address-handle');
  assert.equal(enterDirective.value, 'https://dashboard.render.com/');
  assert.equal(enterDirective.navigation_enter, true);
  return focusDirective;
}

test('browser admin site-home focuses Opera omnibox before URL entry', async () => {
  const focusDirective = await assertNavigationFocusAndEntry(browserSnapshot());
  assert.equal(focusDirective.handle, 'address-handle');
});

test('browser admin site-home accepts Opera start-page top omnibar placeholder', async () => {
  const focusDirective = await assertNavigationFocusAndEntry(browserSnapshot({ startPagePlaceholder: true }));
  assert.equal(focusDirective.handle, 'start-page-omnibar');
});
