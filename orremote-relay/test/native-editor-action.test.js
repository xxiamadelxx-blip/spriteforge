import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeExactPlanSkill } from '../src/skills/native/exact-plan.js';
import { createDeliveryCartPlanSkill } from '../src/skills/delivery/cart-plan.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

const SEARCH_SELECTOR = { kind: 'RESOURCE_ID', value: 'ru.vkusvill:id/et_search' };
const SEARCH_RESULTS_POSTCONDITION = {
  mode: 'transition',
  expr: {
    kind: 'node_present',
    selector: { kind: 'TEXT', value: 'Зелёный чай' },
    scope: { window_type: 'APPLICATION', package: 'ru.vkusvill' },
  },
};

function node(overrides = {}) {
  return {
    handle: 'search-field',
    window_id: 14,
    window_type: 'APPLICATION',
    window_package: 'ru.vkusvill',
    text: null,
    content_description: null,
    resource_id: 'ru.vkusvill:id/et_search',
    class_name: 'android.widget.EditText',
    enabled: true,
    editable: true,
    clickable: false,
    visible_to_user: true,
    sensitive: false,
    depth: 3,
    ...overrides,
  };
}

function observed(revision, nodes, authorizationRequired = false) {
  return {
    status: 'OK',
    package: 'ru.vkusvill',
    revision,
    display_id: 0,
    authorization_required: authorizationRequired,
    privacy_mode: authorizationRequired ? 'USER_AUTH_REDACTED' : 'NORMAL',
    semantic_tree_complete: true,
    truncated: false,
    nodes,
  };
}

function skill(id = 'delivery.test.editor-submit') {
  return createNativeExactPlanSkill({
    id,
    packages: ['ru.vkusvill'],
    effect: 'cart_write',
    risk: 'R2',
  });
}

test('VkusVill delivery plan emits one revision-bound semantic IME action and waits for a business postcondition', async () => {
  const calls = [];
  let observations = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([createDeliveryCartPlanSkill()]),
    createAttemptId: () => 'editor-attempt-1',
    sleep: async () => {},
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        observations += 1;
        return observed(
          observations,
          observations >= 2
            ? [node(), node({ handle: 'result', resource_id: 'product_title', text: 'Зелёный чай', editable: false })]
            : [node()],
        );
      }
      if (name === 'ui.editor_action') {
        return {
          isError: true,
          structuredContent: {
            status: 'ACTION_DISPATCHED_NOT_VERIFIED',
            error_code: 'ACTION_NOT_VERIFIED',
            action_dispatched: true,
          },
        };
      }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({
    skillId: 'delivery.consumer.build_cart',
    inputs: {
      provider: 'vkusvill',
      steps: [{
        type: 'SUBMIT_EDITOR_EXACT_SELECTOR',
        selector: SEARCH_SELECTOR,
        postcondition: SEARCH_RESULTS_POSTCONDITION,
      }],
    },
    limits: { maxTransitions: 12, deadlineMs: 5_000 },
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  const actions = calls.filter((entry) => entry.name === 'ui.editor_action');
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].args, {
    expected_revision: 1,
    selector_kind: 'HANDLE',
    selector_value: 'search-field',
    exact: true,
  });
  const semantic = result.trace.find((entry) => entry.type === 'SEMANTIC_RESULT' && entry.result === 'VERIFIED');
  assert.deepEqual(semantic.proof_revisions, [2, 3]);
  assert.equal(JSON.stringify(result.trace).includes('search-field'), false);
});

test('native editor submit refuses duplicate editable matches before dispatch', async () => {
  const calls = [];
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill('delivery.test.editor-ambiguous')]),
    invokePrimitive: async (name) => {
      calls.push(name);
      if (name === 'screen.observe') return observed(4, [node(), node({ handle: 'search-field-2' })]);
      throw new Error(`Unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({
    skillId: 'delivery.test.editor-ambiguous',
    inputs: {
      package: 'ru.vkusvill',
      steps: [{
        type: 'SUBMIT_EDITOR_EXACT_SELECTOR',
        selector: SEARCH_SELECTOR,
        postcondition: SEARCH_RESULTS_POSTCONDITION,
      }],
    },
  });

  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'NATIVE_TARGET_AMBIGUOUS');
  assert.deepEqual(calls, ['screen.observe']);
});

test('native editor submit requires an explicit semantic postcondition', async () => {
  const calls = [];
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill('delivery.test.editor-uncontracted')]),
    invokePrimitive: async (name) => {
      calls.push(name);
      if (name === 'screen.observe') return observed(7, [node()]);
      throw new Error(`Unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({
    skillId: 'delivery.test.editor-uncontracted',
    inputs: {
      package: 'ru.vkusvill',
      steps: [{ type: 'SUBMIT_EDITOR_EXACT_SELECTOR', selector: SEARCH_SELECTOR }],
    },
  });

  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'NATIVE_POSTCONDITION_REQUIRED');
  assert.deepEqual(calls, ['screen.observe']);
});

test('native editor submit refuses sensitive fields before dispatch', async () => {
  const calls = [];
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill('delivery.test.editor-auth')]),
    invokePrimitive: async (name) => {
      calls.push(name);
      if (name === 'screen.observe') return observed(9, [node({ sensitive: true })]);
      throw new Error(`Unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({
    skillId: 'delivery.test.editor-auth',
    inputs: {
      package: 'ru.vkusvill',
      steps: [{
        type: 'SUBMIT_EDITOR_EXACT_SELECTOR',
        selector: SEARCH_SELECTOR,
        postcondition: SEARCH_RESULTS_POSTCONDITION,
      }],
    },
  });

  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'USER_AUTH_REQUIRED');
  assert.deepEqual(calls, ['screen.observe']);
});

test('native editor submit is dispatched once and never replayed when its business postcondition remains false', async () => {
  let observations = 0;
  let editorActions = 0;
  let clock = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill('delivery.test.editor-no-replay')]),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        observations += 1;
        return observed(observations, [node()]);
      }
      if (name === 'ui.editor_action') {
        editorActions += 1;
        return { status: 'ACTION_DISPATCHED_NOT_VERIFIED', action_dispatched: true, error_code: 'ACTION_NOT_VERIFIED' };
      }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({
    skillId: 'delivery.test.editor-no-replay',
    inputs: {
      package: 'ru.vkusvill',
      steps: [{
        type: 'SUBMIT_EDITOR_EXACT_SELECTOR',
        selector: SEARCH_SELECTOR,
        postcondition: SEARCH_RESULTS_POSTCONDITION,
      }],
    },
    limits: { maxTransitions: 12, deadlineMs: 1_000 },
  });

  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'POSTCONDITION_NOT_MET');
  assert.equal(editorActions, 1);
});

test('a proven stale rejection reobserves and binds editor submit to the new revision and handle', async () => {
  const calls = [];
  let observations = 0;
  let editorActions = 0;
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill('delivery.test.editor-stale')]),
    createAttemptId: () => `editor-stale-${editorActions}`,
    sleep: async () => {},
    invokePrimitive: async (name, args) => {
      calls.push({ name, args });
      if (name === 'screen.observe') {
        observations += 1;
        return observed(
          observations,
          observations >= 3
            ? [node({ handle: 'search-field-v2' }), node({ handle: 'result', resource_id: 'product_title', text: 'Зелёный чай', editable: false })]
            : [node({ handle: observations === 1 ? 'search-field-v1' : 'search-field-v2' })],
        );
      }
      if (name === 'ui.editor_action') {
        editorActions += 1;
        if (editorActions === 1) {
          return { isError: true, structuredContent: { status: 'ERROR', error_code: 'STALE_STATE', action_dispatched: false } };
        }
        return { isError: true, structuredContent: { status: 'ACTION_DISPATCHED_NOT_VERIFIED', error_code: 'ACTION_NOT_VERIFIED', action_dispatched: true } };
      }
      throw new Error(`Unexpected primitive ${name}`);
    },
  });

  const result = await runtime.run({
    skillId: 'delivery.test.editor-stale',
    inputs: {
      package: 'ru.vkusvill',
      steps: [{
        type: 'SUBMIT_EDITOR_EXACT_SELECTOR',
        selector: SEARCH_SELECTOR,
        postcondition: SEARCH_RESULTS_POSTCONDITION,
      }],
    },
    limits: { maxTransitions: 12, deadlineMs: 5_000 },
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  const actions = calls.filter((entry) => entry.name === 'ui.editor_action');
  assert.deepEqual(actions.map((entry) => entry.args), [
    { expected_revision: 1, selector_kind: 'HANDLE', selector_value: 'search-field-v1', exact: true },
    { expected_revision: 2, selector_kind: 'HANDLE', selector_value: 'search-field-v2', exact: true },
  ]);
  assert.equal(editorActions, 2);
});
