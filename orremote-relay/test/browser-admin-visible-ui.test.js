import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAdminSkill } from '../src/skills/browser/augmented-skill.js';

function snapshot(nodes = []) {
  return {
    package: 'com.opera.browser',
    revision: 51,
    nodes,
  };
}

test('browser discovery captures visible controls without handles or editable values', async () => {
  const skill = createBrowserAdminSkill();
  const context = skill.createContext({
    inputs: {
      site: 'codemagic',
      domain: 'codemagic.io',
      steps: [{ type: 'CAPTURE_VISIBLE_UI', key: 'page' }],
    },
  });

  const result = await skill.next({
    state: 'BROWSER',
    snapshot: snapshot([
      {
        handle: 'h-build',
        text: 'Start new build',
        resource_id: 'start-build',
        class_name: 'android.widget.Button',
        clickable: true,
        editable: false,
        enabled: true,
      },
      {
        handle: 'h-search',
        text: 'private typed query',
        content_description: 'Search apps',
        resource_id: 'search-input',
        class_name: 'android.widget.EditText',
        clickable: true,
        editable: true,
        enabled: true,
      },
      {
        handle: 'h-token',
        text: 'glpat-super-secret-value',
        resource_id: 'api-token',
        class_name: 'android.widget.TextView',
        clickable: false,
        editable: false,
        enabled: true,
      },
    ]),
    context,
  });

  assert.deepEqual(result, { type: 'OBSERVE' });
  assert.equal(context.index, 1);
  assert.equal(context.captures.page.length, 2);
  assert.deepEqual(context.captures.page[0], {
    text: 'Start new build',
    content_description: '',
    resource_id: 'start-build',
    class_name: 'android.widget.Button',
    clickable: true,
    editable: false,
  });
  assert.equal(context.captures.page[1].text, '');
  assert.equal(context.captures.page[1].content_description, 'Search apps');
  assert.equal('handle' in context.captures.page[0], false);
});

test('browser discovery rejects invalid capture keys without touching UI', async () => {
  const skill = createBrowserAdminSkill();
  const context = skill.createContext({
    inputs: {
      site: 'render',
      domain: 'render.com',
      steps: [{ type: 'CAPTURE_VISIBLE_UI', key: '' }],
    },
  });
  const result = await skill.next({
    state: 'BROWSER',
    snapshot: snapshot([]),
    context,
  });
  assert.equal(result.type, 'STOP');
  assert.equal(result.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});
