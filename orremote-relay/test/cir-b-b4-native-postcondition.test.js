import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryCartPlanSkill } from '../src/skills/delivery/cart-plan.js';
import { createNativeExactPlanSkill } from '../src/skills/native/exact-plan.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

const PKG = 'ru.sbcs.store';

function postcondition({ mode = 'transition', preexistingOk } = {}) {
  const value = {
    mode,
    expr: {
      kind: 'node_field',
      selector: { kind: 'RESOURCE_ID', value: 'cart_qty' },
      scope: { window_type: 'APPLICATION', package: PKG },
      field: 'text',
      op: 'eq',
      value: '1',
    },
    verify: { timeout_ms: 3, poll_ms: 1 },
  };
  if (preexistingOk !== undefined) value.preexisting_ok = preexistingOk;
  return value;
}

function snap(revision, quantity, { unrelated = 'stable' } = {}) {
  return {
    package: PKG,
    revision,
    display_id: 0,
    authorization_required: false,
    privacy_mode: 'NORMAL',
    redacted: false,
    semantic_tree_complete: true,
    truncated: false,
    hit_topology_signature: 'topology-cart',
    nodes: [
      {
        depth: 1,
        handle: 'add',
        window_id: 41,
        window_type: 'APPLICATION',
        window_package: PKG,
        visible_to_user: true,
        center_hit: 'OWNED',
        resource_id: 'add_product',
        enabled: true,
        clickable: true,
        editable: false,
        sensitive: false,
        bounds: { left: 100, top: 400, right: 500, bottom: 520 },
      },
      {
        depth: 1,
        handle: 'qty',
        window_id: 41,
        window_type: 'APPLICATION',
        window_package: PKG,
        visible_to_user: true,
        resource_id: 'cart_qty',
        text: quantity,
        enabled: true,
        clickable: false,
        editable: false,
        sensitive: false,
        bounds: { left: 600, top: 400, right: 760, bottom: 520 },
      },
      {
        depth: 1,
        handle: 'unrelated',
        window_id: 41,
        window_type: 'APPLICATION',
        window_package: PKG,
        visible_to_user: true,
        resource_id: 'unrelated',
        text: unrelated,
        enabled: true,
        clickable: false,
        editable: false,
        sensitive: false,
        bounds: { left: 20, top: 40, right: 300, bottom: 100 },
      },
    ],
  };
}

function registry(skill) {
  return { get: (id) => id === skill.id ? skill : null };
}

test('B4 opt-in carries postcondition only for explicitly contracted revision-bound native actions and gates advancement', async () => {
  const skill = createNativeExactPlanSkill({
    id: 'test.b4.native',
    packages: [PKG],
    effect: 'cart_write',
    risk: 'R2',
  });

  const legacy = skill.createContext({
    inputs: { package: PKG, steps: [{ type: 'CLICK_EXACT_SELECTOR', selector: { kind: 'RESOURCE_ID', value: 'add_product' } }] },
  });
  const legacyDirective = await skill.next({ state: 'TARGET_APP', snapshot: snap(1, '0'), context: legacy });
  assert.equal(Object.hasOwn(legacyDirective, 'postcondition'), false);
  await skill.acceptResult({ directive: legacyDirective, context: legacy });
  assert.equal(legacy.index, 1);

  const contracted = skill.createContext({
    inputs: {
      package: PKG,
      steps: [{
        type: 'TAP_EXACT_SELECTOR_CENTER',
        selector: { kind: 'RESOURCE_ID', value: 'add_product' },
        postcondition: postcondition(),
      }],
    },
  });
  const directive = await skill.next({ state: 'TARGET_APP', snapshot: snap(1, '0'), context: contracted });
  assert.deepEqual(directive.postcondition, postcondition());
  assert.equal(directive.target_handle, 'add');
  assert.equal(directive.target_window_id, 41);
  assert.equal(directive.expected_hit_topology_signature, 'topology-cart');

  await skill.acceptResult({ directive, semanticResult: null, context: contracted });
  assert.equal(contracted.index, 0);
  await skill.acceptResult({ directive, semanticResult: { result: 'ACTION_NOT_VERIFIED' }, context: contracted });
  assert.equal(contracted.index, 0);
  await skill.acceptResult({ directive, semanticResult: { result: 'VERIFIED' }, context: contracted });
  assert.equal(contracted.index, 1);
  await skill.acceptResult({ directive, semanticResult: { result: 'VERIFIED' }, context: contracted });
  assert.equal(contracted.index, 1);
});

test('B4 state preexisting_ok advances without dispatch only for the explicit allowed semantic result', async () => {
  const skill = createNativeExactPlanSkill({
    id: 'test.b4.preexisting',
    packages: [PKG],
    effect: 'cart_write',
    risk: 'R2',
  });
  const context = skill.createContext({
    inputs: {
      package: PKG,
      steps: [{
        type: 'CLICK_EXACT_SELECTOR',
        selector: { kind: 'RESOURCE_ID', value: 'add_product' },
        postcondition: postcondition({ mode: 'state', preexistingOk: true }),
      }],
    },
  });
  const directive = await skill.next({ state: 'TARGET_APP', snapshot: snap(1, '1'), context });
  await skill.acceptResult({
    directive,
    primitiveResult: null,
    semanticResult: { result: 'POSTCONDITION_ALREADY_SATISFIED', dispatch_state: 'NOT_DISPATCHED' },
    context,
  });
  assert.equal(context.index, 1);
});

test('B4 representative delivery business target requires two fresh scoped semantic proofs', async () => {
  const skill = createDeliveryCartPlanSkill();
  let observes = 0;
  let taps = 0;
  const runtime = createSkillRuntime({
    registry: registry(skill),
    createAttemptId: () => 'attempt-b4-success',
    sleep: async () => {},
    invokePrimitive: async (name, args) => {
      if (name === 'screen.observe') {
        observes += 1;
        if (observes === 1) return snap(10, '0');
        return snap(10 + observes - 1, '1');
      }
      if (name === 'touch.tap') {
        taps += 1;
        assert.equal(args.target_handle, 'add');
        assert.equal(args.target_window_id, 41);
        assert.equal(args.expected_hit_topology_signature, 'topology-cart');
        return { status: 'VERIFIED', action_dispatched: true, after_revision: 11 };
      }
      throw new Error(`unexpected primitive ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: skill.id,
    inputs: {
      provider: 'samokat',
      steps: [{
        type: 'TAP_EXACT_SELECTOR_CENTER',
        selector: { kind: 'RESOURCE_ID', value: 'add_product' },
        postcondition: postcondition(),
      }],
    },
    limits: { maxTransitions: 8, deadlineMs: 1000 },
  });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(taps, 1);
  const semantic = output.trace.find((entry) => entry.type === 'SEMANTIC_RESULT' && entry.result === 'VERIFIED');
  assert.ok(semantic);
  assert.deepEqual(semantic.proof_revisions, [11, 12]);
});

test('B4 unrelated UI change is not semantic success and state-changing action is never replayed', async () => {
  const skill = createDeliveryCartPlanSkill();
  let observes = 0;
  let taps = 0;
  let clock = 0;
  const runtime = createSkillRuntime({
    registry: registry(skill),
    createAttemptId: () => 'attempt-b4-fail',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    invokePrimitive: async (name) => {
      if (name === 'screen.observe') {
        observes += 1;
        return snap(20 + observes - 1, '0', { unrelated: observes > 1 ? 'changed' : 'stable' });
      }
      if (name === 'touch.tap') {
        taps += 1;
        return { status: 'VERIFIED', action_dispatched: true, after_revision: 21 };
      }
      throw new Error(`unexpected primitive ${name}`);
    },
  });

  const output = await runtime.run({
    skillId: skill.id,
    inputs: {
      provider: 'samokat',
      steps: [{
        type: 'TAP_EXACT_SELECTOR_CENTER',
        selector: { kind: 'RESOURCE_ID', value: 'add_product' },
        postcondition: postcondition(),
      }],
    },
    limits: { maxTransitions: 8, deadlineMs: 1000 },
  });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'POSTCONDITION_NOT_MET');
  assert.equal(taps, 1);
  assert.equal(output.trace.filter((entry) => entry.type === 'ACTION').length, 1);
});
