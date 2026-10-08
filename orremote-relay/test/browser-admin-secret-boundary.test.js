import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';

const OPERA = 'com.opera.browser';

function node(overrides = {}) {
  return {
    depth: 1,
    handle: 'h',
    enabled: true,
    clickable: false,
    editable: false,
    sensitive: false,
    bounds: { left: 0, top: 0, right: 600, bottom: 100 },
    ...overrides,
  };
}

function snap(nodes, revision = 1) {
  return { package: OPERA, revision, authorization_required: false, nodes };
}

test('navigation link to API tokens section is allowed without exposing a secret', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({ inputs: {
    site: 'codemagic',
    domain: 'codemagic.io',
    steps: [{ type: 'CLICK_EXACT_TEXT', text: 'API tokens' }],
  } });
  const snapshot = snap([
    node({ handle: 'row', clickable: true, text: 'API tokens' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'CLICK_HANDLE');
  assert.equal(directive.handle, 'row');
  assert.equal((await skill.validateDirective({ state, snapshot, directive, context })).ok, true);
});

test('reveal or create-token action remains blocked', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({ inputs: {
    site: 'codemagic',
    domain: 'codemagic.io',
    steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Reveal API token' }],
  } });
  const snapshot = snap([
    node({ handle: 'reveal', clickable: true, text: 'Reveal API token' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});

test('API token editable field remains user-only', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({ inputs: {
    site: 'render',
    domain: 'dashboard.render.com',
    steps: [{
      type: 'SET_TEXT_EXACT_SELECTOR',
      selector: { kind: 'RESOURCE_ID', value: 'api-token' },
      value: 'dummy',
      sensitive: false,
    }],
  } });
  const snapshot = snap([
    node({ handle: 'token-field', editable: true, resource_id: 'api-token' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});
