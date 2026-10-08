import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

function snapshot(revision = 7) {
  return {
    status: 'OK',
    revision,
    package: 'com.opera.browser',
    authorization_required: false,
    nodes: [],
  };
}

test('SET_TEXT_HANDLE maps to revision-bound ui.set_text without leaking value into trace', async () => {
  const calls = [];
  let observeCount = 0;
  const skill = {
    id: 'browser.test.configure',
    packages: ['com.opera.browser'],
    safety: { effect: 'configuration', risk: 'R2' },
    createContext() { return { done: false }; },
    recognize() { return 'FORM'; },
    next({ context }) {
      if (context.done) return { type: 'COMPLETE', output: { ok: true } };
      return {
        type: 'SET_TEXT_HANDLE',
        handle: 'node-123',
        value: 'main',
        sensitive: false,
      };
    },
    validateDirective({ directive }) {
      return directive.type === 'SET_TEXT_HANDLE' && directive.sensitive === false;
    },
    acceptResult({ context }) { context.done = true; return true; },
  };
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        observeCount += 1;
        return snapshot(observeCount === 1 ? 7 : 8);
      }
      return { status: 'VERIFIED' };
    },
  });

  const result = await runtime.run({ skillId: skill.id });
  assert.equal(result.status, 'COMPLETED');
  const action = calls.find((entry) => entry.name === 'ui.set_text');
  assert.deepEqual(action, {
    name: 'ui.set_text',
    args: {
      expected_revision: 7,
      selector_kind: 'HANDLE',
      selector_value: 'node-123',
      exact: true,
      value: 'main',
    },
  });
  assert.equal(JSON.stringify(result.trace).includes('main'), false);
});

test('SET_TEXT_HANDLE marked sensitive is rejected before primitive dispatch', async () => {
  let textCalls = 0;
  const skill = {
    id: 'browser.test.secret',
    packages: ['com.opera.browser'],
    safety: { effect: 'configuration', risk: 'R2' },
    createContext() { return {}; },
    recognize() { return 'FORM'; },
    next() {
      return {
        type: 'SET_TEXT_HANDLE',
        handle: 'password-node',
        value: 'do-not-send',
        sensitive: true,
      };
    },
    validateDirective({ directive }) {
      if (directive.sensitive === true) {
        return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive text is user-only.' };
      }
      return true;
    },
  };
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async (name) => {
      if (name === 'ui.set_text') textCalls += 1;
      return name === 'screen.observe' ? snapshot() : { status: 'VERIFIED' };
    },
  });
  const result = await runtime.run({ skillId: skill.id });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'USER_AUTH_REQUIRED');
  assert.equal(textCalls, 0);
});
