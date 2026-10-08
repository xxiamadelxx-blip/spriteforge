import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

const SCOPE = { window_type: 'APPLICATION', package: 'com.example.shop' };

function node(text) {
  return {
    resource_id: 'com.example.shop:id/quantity',
    text,
    content_description: '',
    class_name: 'android.widget.TextView',
    enabled: true,
    editable: false,
    clickable: true,
    visible_to_user: true,
    sensitive: false,
    window_type: 'APPLICATION',
    window_package: 'com.example.shop',
  };
}

function snapshot(revision, text, extra = {}) {
  return {
    status: 'OK',
    revision,
    package: 'com.example.shop',
    activity: 'com.example.shop.CartActivity',
    display_id: 0,
    authorization_required: false,
    privacy_mode: 'NORMAL',
    semantic_tree_complete: true,
    truncated: false,
    nodes: [node(text)],
    ...extra,
  };
}

function postcondition(verify = { timeout_ms: 2, poll_ms: 1 }) {
  return {
    mode: 'transition',
    expr: {
      kind: 'node_field',
      selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' },
      scope: structuredClone(SCOPE),
      field: 'text',
      op: 'eq',
      value: '1',
    },
    verify,
  };
}

function contractedSkill({ directive = null, onAccept = null } = {}) {
  return {
    id: 'attempt.gate',
    packages: ['com.example.shop'],
    safety: { effect: 'configuration', risk: 'R1' },
    createContext() { return { done: false }; },
    recognize() { return 'READY'; },
    next({ context }) {
      if (context.done) return { type: 'COMPLETE', output: { done: true } };
      return directive || {
        type: 'CLICK_HANDLE',
        handle: 'quantity-button',
        postcondition: postcondition(),
      };
    },
    validateDirective() { return { ok: true }; },
    acceptResult({ context, semanticResult }) {
      onAccept?.(semanticResult);
      if (semanticResult?.result === 'VERIFIED' || semanticResult?.result === 'POSTCONDITION_ALREADY_SATISFIED') {
        context.done = true;
      }
    },
  };
}

function runtimeWith(skill, invokePrimitive, options = {}) {
  return createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive,
    now: () => 0,
    sleep: async () => {},
    createAttemptId: (() => {
      let number = 0;
      return () => `opaque-attempt-${++number}`;
    })(),
    ...options,
  });
}

test('contracted action dispatches once and requires two fresh scoped proofs before acceptance', async () => {
  const calls = [];
  let accepted = null;
  const skill = contractedSkill({ onAccept: (result) => { accepted = result; } });
  const observations = [
    snapshot(10, '0'),
    snapshot(11, '1'),
    snapshot(12, '1'),
    snapshot(13, '1'),
  ];
  const runtime = runtimeWith(skill, async (name, args) => {
    calls.push({ name, args });
    if (name === 'screen.observe') return observations.shift();
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(calls.filter((call) => call.name === 'ui.click').length, 1);
  assert.equal(accepted?.result, 'VERIFIED');
  assert.equal(output.trace[0].phase, 'BASELINE');
  assert.deepEqual(
    output.trace.map((entry) => entry.type),
    ['OBSERVE', 'ATTEMPT', 'ACTION', 'VERIFY', 'VERIFY', 'SEMANTIC_RESULT', 'OBSERVE'],
  );
  assert.equal(output.trace.find((entry) => entry.type === 'ACTION')?.dispatch_state, 'DISPATCHED');
  assert.deepEqual(
    output.trace.filter((entry) => entry.type === 'VERIFY').map((entry) => entry.predicate_state),
    ['TRUE', 'TRUE'],
  );
  assert.deepEqual(
    output.trace.filter((entry) => entry.type === 'VERIFY').map((entry) => entry.completeness),
    [
      { semantic_tree_complete: true, truncated: false },
      { semantic_tree_complete: true, truncated: false },
    ],
  );
});

test('a transient TRUE is insufficient until two later successive fresh proofs exist', async () => {
  let actionCalls = 0;
  const skill = contractedSkill({
    directive: {
      type: 'CLICK_HANDLE',
      handle: 'quantity-button',
      postcondition: postcondition({ timeout_ms: 4, poll_ms: 1 }),
    },
  });
  const observations = [
    snapshot(20, '0'),
    snapshot(21, '1'),
    snapshot(22, '0'),
    snapshot(23, '1'),
    snapshot(24, '1'),
    snapshot(25, '1'),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(actionCalls, 1);
  assert.deepEqual(
    output.trace.filter((entry) => entry.type === 'VERIFY').map((entry) => entry.predicate_state),
    ['TRUE', 'FALSE', 'TRUE', 'TRUE'],
  );
});

test('lost primitive response is UNKNOWN dispatch but read-only proof can verify without replay', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const observations = [
    snapshot(30, '0'),
    snapshot(31, '1'),
    snapshot(32, '1'),
    snapshot(33, '1'),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    throw new Error('transport lost after request');
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(actionCalls, 1);
  const action = output.trace.find((entry) => entry.type === 'ACTION');
  assert.equal(action.dispatch_state, 'UNKNOWN');
  assert.equal(action.result, 'TRANSPORT_UNKNOWN');
  assert.equal(JSON.stringify(output.trace).includes('transport lost'), false);
});

test('deadline with decisive FALSE ends POSTCONDITION_NOT_MET without a second write', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const observations = [
    snapshot(40, '0'),
    snapshot(41, '0'),
    snapshot(42, '0'),
    snapshot(43, '0'),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'POSTCONDITION_NOT_MET');
  assert.equal(output.dispatch_state, 'DISPATCHED');
  assert.equal(actionCalls, 1);
});

test('STALE_STATE without explicit dispatch evidence is treated as UNKNOWN and never replayed', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const observations = [
    snapshot(50, '0'),
    snapshot(51, '0'),
    snapshot(52, '0'),
    snapshot(53, '0'),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    return { isError: true, structuredContent: { status: 'ERROR', error_code: 'STALE_STATE' } };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'POSTCONDITION_NOT_MET');
  assert.equal(output.dispatch_state, 'UNKNOWN');
  assert.equal(actionCalls, 1);
});

test('only an explicitly NOT_DISPATCHED stale rejection may reobserve and replan', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const observations = [
    snapshot(60, '0'),
    snapshot(61, '0'),
    snapshot(62, '1'),
    snapshot(63, '1'),
    snapshot(64, '1'),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    if (actionCalls === 1) {
      return {
        isError: true,
        structuredContent: {
          status: 'ERROR',
          error_code: 'STALE_STATE',
          action_dispatched: false,
        },
      };
    }
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(actionCalls, 2);
  const actions = output.trace.filter((entry) => entry.type === 'ACTION');
  assert.equal(actions[0].dispatch_state, 'NOT_DISPATCHED');
  assert.equal(actions[1].dispatch_state, 'DISPATCHED');
  assert.equal(output.trace.findIndex((entry) => entry.type === 'OBSERVE' && entry.revision === 61)
    > output.trace.findIndex((entry) => entry.type === 'ACTION' && entry.dispatch_state === 'NOT_DISPATCHED'), true);
});

test('authorization during verification dominates and stops after the one possible dispatch', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const observations = [
    snapshot(70, '0'),
    snapshot(71, '1', {
      authorization_required: true,
      privacy_mode: 'USER_AUTH_REDACTED',
    }),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'USER_AUTH_REQUIRED');
  assert.equal(actionCalls, 1);
  assert.equal(output.trace.filter((entry) => entry.type === 'VERIFY').length, 1);
});

test('redacted baseline stops before provider hooks even when its prospective postcondition is invalid', async (t) => {
  for (const [label, protection] of [
    ['privacy mode only', { privacy_mode: 'USER_AUTH_REDACTED' }],
    ['redacted flag only', { redacted: true }],
  ]) {
    await t.test(label, async () => {
      const providerCalls = { recognize: 0, next: 0, validateDirective: 0 };
      let actionCalls = 0;
      const skill = {
        id: `redacted-baseline-${label}`,
        packages: ['com.example.shop'],
        safety: { effect: 'configuration', risk: 'R1' },
        createContext() { return {}; },
        recognize() {
          providerCalls.recognize += 1;
          return 'READY';
        },
        next() {
          providerCalls.next += 1;
          return {
            type: 'CLICK_HANDLE',
            handle: 'quantity-button',
            postcondition: { mode: 'not-a-valid-postcondition' },
          };
        },
        validateDirective() {
          providerCalls.validateDirective += 1;
          return { ok: true };
        },
      };
      const runtime = runtimeWith(skill, async (name) => {
        if (name === 'screen.observe') return snapshot(73, '0', protection);
        actionCalls += 1;
        return { status: 'VERIFIED', action_dispatched: true };
      });

      const output = await runtime.run({ skillId: skill.id });

      assert.equal(output.status, 'STOPPED');
      assert.equal(output.error_code, 'USER_AUTH_REQUIRED');
      assert.deepEqual(providerCalls, { recognize: 0, next: 0, validateDirective: 0 });
      assert.equal(actionCalls, 0);
    });
  }
});

test('contracted secondary-display action and proof observations bind the declared display', async () => {
  const calls = [];
  const skill = contractedSkill({
    directive: {
      type: 'CLICK_HANDLE',
      handle: 'quantity-button',
      display_id: 1,
      postcondition: postcondition(),
    },
  });
  const observations = [
    snapshot(74, '0', { display_id: 1 }),
    snapshot(75, '1', { display_id: 1 }),
    snapshot(76, '1', { display_id: 1 }),
    snapshot(77, '1', { display_id: 1 }),
  ];
  const runtime = runtimeWith(skill, async (name, args) => {
    calls.push({ name, args });
    if (name === 'screen.observe') return observations.shift();
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(calls.find((call) => call.name === 'ui.click')?.args.display_id, 1);
  assert.deepEqual(
    calls.filter((call) => call.name === 'screen.observe').slice(0, 3).map((call) => call.args),
    [{}, { display_id: 1 }, { display_id: 1 }],
  );
});

test('contracted directive rejects a mismatched declared baseline display before dispatch', async () => {
  let actionCalls = 0;
  const skill = contractedSkill({
    directive: {
      type: 'CLICK_HANDLE',
      handle: 'quantity-button',
      display_id: 1,
      postcondition: postcondition(),
    },
  });
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return snapshot(78, '0', { display_id: 0 });
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(actionCalls, 0);
  assert.equal(output.trace.at(-1)?.predicate_reason, 'BASELINE_DISPLAY_MISMATCH');
});

test('contracted primary-default directive rejects a secondary baseline before dispatch', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return snapshot(79, '0', { display_id: 1 });
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(actionCalls, 0);
  assert.equal(output.trace.at(-1)?.predicate_reason, 'BASELINE_DISPLAY_MISMATCH');
});

test('a verification observation from another display is UNKNOWN and cannot prove success', async () => {
  let actionCalls = 0;
  const skill = contractedSkill();
  const observations = [
    snapshot(75, '0'),
    snapshot(76, '1', { display_id: 1 }),
    snapshot(77, '1', { display_id: 1 }),
    snapshot(78, '1', { display_id: 1 }),
  ];
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return observations.shift();
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'STOPPED');
  assert.equal(output.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(actionCalls, 1);
  assert.equal(
    output.trace.filter((entry) => entry.type === 'VERIFY').at(-1)?.predicate_reason,
    'VERIFY_DISPLAY_MISMATCH',
  );
});

test('already-satisfied transition and unguarded contracted primitives both stop before dispatch', async () => {
  let transitionActions = 0;
  const transitionRuntime = runtimeWith(contractedSkill(), async (name) => {
    if (name === 'screen.observe') return snapshot(80, '1');
    transitionActions += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });
  const transition = await transitionRuntime.run({ skillId: 'attempt.gate' });
  assert.equal(transition.error_code, 'POSTCONDITION_ALREADY_SATISFIED');
  assert.equal(transitionActions, 0);

  let tapActions = 0;
  const tapSkill = contractedSkill({
    directive: {
      type: 'TAP_POINT',
      x: 10,
      y: 10,
      postcondition: postcondition(),
    },
  });
  const tapRuntime = runtimeWith(tapSkill, async (name) => {
    if (name === 'screen.observe') return snapshot(81, '0');
    tapActions += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });
  const tap = await tapRuntime.run({ skillId: tapSkill.id });
  assert.equal(tap.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(tapActions, 0);
});

test('an explicit idempotent state postcondition may accept a preexisting state without dispatch', async () => {
  let actionCalls = 0;
  let accepted = null;
  const declaration = postcondition();
  declaration.mode = 'state';
  declaration.preexisting_ok = true;
  const skill = contractedSkill({
    directive: {
      type: 'CLICK_HANDLE',
      handle: 'quantity-button',
      postcondition: declaration,
    },
    onAccept: (result) => { accepted = result; },
  });
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return snapshot(85, '1');
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.status, 'COMPLETED');
  assert.equal(actionCalls, 0);
  assert.equal(accepted?.result, 'POSTCONDITION_ALREADY_SATISFIED');
  assert.equal(output.trace.find((entry) => entry.type === 'SEMANTIC_RESULT')?.dispatch_state, 'NOT_DISPATCHED');
});

test('a declared field-transition rejects a wrong baseline from-value before dispatch', async () => {
  let actionCalls = 0;
  const skill = contractedSkill({
    directive: {
      type: 'CLICK_HANDLE',
      handle: 'quantity-button',
      postcondition: {
        mode: 'transition',
        expr: {
          kind: 'node_field_transition',
          selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' },
          scope: structuredClone(SCOPE),
          field: 'text',
          from: '0',
          to: '1',
        },
        verify: { timeout_ms: 2, poll_ms: 1 },
      },
    },
  });
  const runtime = runtimeWith(skill, async (name) => {
    if (name === 'screen.observe') return snapshot(90, '2');
    actionCalls += 1;
    return { status: 'VERIFIED', action_dispatched: true };
  });

  const output = await runtime.run({ skillId: skill.id });

  assert.equal(output.error_code, 'ACTION_NOT_VERIFIED');
  assert.equal(actionCalls, 0);
  assert.equal(output.trace.at(-1)?.predicate_reason, 'TRANSITION_BASELINE_FROM_MISMATCH');
});
