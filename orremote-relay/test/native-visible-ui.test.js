import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeDiscoverablePlanSkill } from '../src/skills/native/augmented-exact-plan.js';

function snapshot(nodes = []) {
  return {
    package: 'example.app',
    revision: 10,
    nodes,
  };
}

test('native discoverable plan captures safe UI without editable values or secrets', async () => {
  const skill = createNativeDiscoverablePlanSkill({
    id: 'example.discovery',
    packages: ['example.app'],
    effect: 'read_only',
    risk: 'R1',
  });
  const context = skill.createContext({
    inputs: {
      package: 'example.app',
      steps: [{ type: 'CAPTURE_VISIBLE_UI', key: 'page' }],
    },
  });

  const result = await skill.next({
    state: 'TARGET_APP',
    snapshot: snapshot([
      {
        handle: 'h-result',
        text: 'Dune: Part Two',
        resource_id: 'result-title',
        class_name: 'android.widget.TextView',
        clickable: true,
        editable: false,
      },
      {
        handle: 'h-search',
        text: 'private search text',
        content_description: 'Search',
        resource_id: 'search',
        class_name: 'android.widget.EditText',
        clickable: true,
        editable: true,
      },
      {
        handle: 'h-secret',
        text: 'sk-proj-not-for-agent',
        resource_id: 'secret-value',
        class_name: 'android.widget.TextView',
        clickable: false,
        editable: false,
      },
    ]),
    context,
  });

  assert.deepEqual(result, { type: 'OBSERVE' });
  assert.equal(context.index, 1);
  assert.equal(context.captures.page.length, 2);
  assert.equal(context.captures.page[0].text, 'Dune: Part Two');
  assert.equal(context.captures.page[1].text, '');
  assert.equal('handle' in context.captures.page[0], false);
});
