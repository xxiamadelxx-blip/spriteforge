import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';

const OPERA = 'com.opera.browser';

function snap(nodes = [], pkg = OPERA, revision = 10) {
  return { package: pkg, revision, authorization_required: false, nodes };
}

function node(overrides = {}) {
  return {
    depth: 1,
    handle: 'h',
    enabled: true,
    clickable: false,
    editable: false,
    sensitive: false,
    bounds: { left: 0, top: 0, right: 500, bottom: 100 },
    ...overrides,
  };
}

test('launches Opera when browser is not foreground', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({ inputs: { domain: 'codemagic.io', steps: [] } });
  const state = skill.recognize(snap([], 'com.android.settings'), context);
  const directive = await skill.next({ state, snapshot: snap([], 'com.android.settings'), context });
  assert.deepEqual(directive, { type: 'LAUNCH', package: OPERA });
});

test('exact text click resolves to current semantic handle', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: { domain: 'codemagic.io', steps: [{ type: 'CLICK_EXACT_TEXT', text: 'Builds' }] },
  });
  const snapshot = snap([
    node({ depth: 1, handle: 'parent', clickable: true, bounds: { left: 0, top: 0, right: 500, bottom: 120 } }),
    node({ depth: 2, handle: 'label', text: 'Builds', bounds: { left: 30, top: 20, right: 200, bottom: 80 } }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'CLICK_HANDLE');
  assert.equal(directive.handle, 'parent');
  assert.equal((await skill.validateDirective({ state, snapshot, directive, context })).ok, true);
});

test('non-secret exact selector text entry resolves only editable safe node', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'gitlab.com',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'branch-field' },
        value: 'main',
        sensitive: false,
      }],
    },
  });
  const snapshot = snap([
    node({ handle: 'branch', editable: true, resource_id: 'branch-field' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.deepEqual(directive, {
    type: 'SET_TEXT_HANDLE',
    handle: 'branch',
    value: 'main',
    sensitive: false,
    step_index: 0,
  });
  assert.equal((await skill.validateDirective({ state, snapshot, directive, context })).ok, true);
});

test('sensitive editable target fails closed even if plan marked it non-secret', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'codemagic.io',
      steps: [{
        type: 'SET_TEXT_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'password' },
        value: 'x',
        sensitive: false,
      }],
    },
  });
  const snapshot = snap([
    node({ handle: 'secret', editable: true, sensitive: true, resource_id: 'password' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'USER_AUTH_REQUIRED');
});

test('actual destructive target is rejected even if selected by resource id', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'gitlab.com',
      steps: [{
        type: 'CLICK_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'action-button' },
      }],
    },
  });
  const snapshot = snap([
    node({ handle: 'danger', clickable: true, resource_id: 'action-button', text: 'Delete project' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});

test('destructive descendant blocks a generic browser action container', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'gitlab.com',
      steps: [{
        type: 'CLICK_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'primary-action' },
      }],
    },
  });
  const snapshot = snap([
    node({
      depth: 1,
      handle: 'container',
      clickable: true,
      resource_id: 'primary-action',
      bounds: { left: 0, top: 0, right: 500, bottom: 120 },
    }),
    node({
      depth: 2,
      handle: 'child',
      text: 'Delete project',
      bounds: { left: 20, top: 20, right: 300, bottom: 80 },
    }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'SKILL_ACTION_NOT_ALLOWED');
});


test('browser back step uses bounded system back directive', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: { domain: 'github.com', steps: [{ type: 'BROWSER_BACK' }] },
  });
  const snapshot = snap([
    node({ handle: 'page-root', text: 'GitHub' }),
  ]);
  const state = skill.recognize(snapshot, context);
  const directive = await skill.next({ state, snapshot, context });
  assert.deepEqual(directive, {
    type: 'BACK',
    step_index: 0,
    browser_back: true,
  });
  assert.equal((await skill.validateDirective({ state, snapshot, directive, context })).ok, true);
  await skill.acceptResult({ state, snapshot, directive, primitiveResult: { structuredContent: { status: 'OK' } }, context });
  assert.equal(context.index, 1);
});
