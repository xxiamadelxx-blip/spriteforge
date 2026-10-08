import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRI_STATE,
  evaluatePostcondition,
  evaluatePostconditionTransition,
  validatePostcondition,
} from '../src/skills/postconditions.js';

const SCOPE = { window_type: 'APPLICATION', package: 'com.example.shop' };

function node(overrides = {}) {
  return {
    resource_id: 'com.example.shop:id/quantity',
    text: '0',
    content_description: '',
    class_name: 'android.widget.TextView',
    enabled: true,
    editable: false,
    clickable: false,
    visible_to_user: true,
    sensitive: false,
    window_type: 'APPLICATION',
    window_package: 'com.example.shop',
    ...overrides,
  };
}

function snapshot(nodes, overrides = {}) {
  return {
    package: 'com.example.shop',
    activity: 'com.example.shop.CartActivity',
    authorization_required: false,
    privacy_mode: 'NORMAL',
    semantic_tree_complete: true,
    truncated: false,
    window_provenance_complete: true,
    nodes,
    ...overrides,
  };
}

function fieldPostcondition(value = '1') {
  return {
    mode: 'transition',
    expr: {
      kind: 'node_field',
      selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' },
      scope: structuredClone(SCOPE),
      field: 'text',
      op: 'eq',
      value,
    },
    verify: { timeout_ms: 3000, poll_ms: 250 },
  };
}

test('validator accepts the bounded v1 grammar and rejects unscoped or executable predicates', () => {
  assert.equal(validatePostcondition(fieldPostcondition()).ok, true);

  const missingScope = fieldPostcondition();
  delete missingScope.expr.scope;
  assert.equal(validatePostcondition(missingScope).ok, false);

  const coordinate = fieldPostcondition();
  coordinate.expr.coordinate = { x: 100, y: 200 };
  assert.equal(validatePostcondition(coordinate).ok, false);

  const unsupportedField = fieldPostcondition();
  unsupportedField.expr.field = 'checked';
  unsupportedField.expr.value = true;
  assert.equal(validatePostcondition(unsupportedField).ok, false);

  const invalidWindow = fieldPostcondition();
  invalidWindow.expr.scope.window_type = 'IME';
  assert.equal(validatePostcondition(invalidWindow).ok, false);

  const inheritedSelector = fieldPostcondition();
  inheritedSelector.expr.selector.kind = 'toString';
  assert.equal(validatePostcondition(inheritedSelector).ok, false);

  const protoSelector = fieldPostcondition();
  protoSelector.expr.selector.kind = '__proto__';
  assert.equal(validatePostcondition(protoSelector).ok, false);

  const noOpFieldTransition = {
    mode: 'transition',
    expr: {
      kind: 'node_field_transition',
      selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' },
      scope: SCOPE,
      field: 'text',
      from: '1',
      to: '1',
    },
  };
  assert.equal(validatePostcondition(noOpFieldTransition).ok, false);
});

test('transition evaluator requires a decisive FALSE baseline and TRUE current state', () => {
  const declaration = fieldPostcondition('1');
  const result = evaluatePostconditionTransition(declaration, {
    baseline: snapshot([node({ text: '0' })]),
    current: snapshot([node({ text: '1' })]),
  });
  assert.equal(result.state, TRI_STATE.TRUE);
  assert.equal(result.baseline.state, TRI_STATE.FALSE);
  assert.equal(result.current.state, TRI_STATE.TRUE);
});

test('unrelated package, activity, fingerprint, or revision changes cannot produce semantic success', () => {
  const declaration = fieldPostcondition('1');
  const result = evaluatePostconditionTransition(declaration, {
    baseline: snapshot([node({ text: '0' })], { revision: 4, fingerprint: 'before' }),
    current: snapshot([node({ text: '0' })], {
      revision: 5,
      fingerprint: 'after',
      package: 'com.example.shop',
      activity: 'com.example.shop.LoadingActivity',
    }),
  });
  assert.equal(result.state, TRI_STATE.FALSE);
  assert.equal(result.current.state, TRI_STATE.FALSE);
});

test('all and any retain conservative tri-state composition', () => {
  const declaration = {
    mode: 'state',
    preexisting_ok: true,
    expr: {
      kind: 'all',
      children: [
        {
          kind: 'node_present',
          selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' },
          scope: SCOPE,
          cardinality: { op: 'gte', value: 1 },
        },
        { kind: 'package_is', value: 'com.example.shop' },
      ],
    },
  };
  assert.equal(evaluatePostcondition(declaration, snapshot([node()])).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(declaration, snapshot([], { truncated: true })).state, TRI_STATE.UNKNOWN);

  const any = structuredClone(declaration);
  any.expr.kind = 'any';
  any.expr.children[1].value = 'com.example.other';
  assert.equal(evaluatePostcondition(any, snapshot([node()])).state, TRI_STATE.TRUE);
});

test('exact presence, absence, and count respect 0/1/multiple matches and cardinality direction', () => {
  const absent = {
    mode: 'state',
    preexisting_ok: true,
    expr: { kind: 'node_absent', selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' }, scope: SCOPE },
  };
  assert.equal(evaluatePostcondition(absent, snapshot([
    node({ resource_id: 'com.example.shop:id/root', text: 'catalog' }),
  ])).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(absent, snapshot([node()])).state, TRI_STATE.FALSE);

  const exactOne = {
    mode: 'state',
    preexisting_ok: true,
    expr: {
      kind: 'node_present', selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' }, scope: SCOPE,
      cardinality: { op: 'eq', value: 1 },
    },
  };
  assert.equal(evaluatePostcondition(exactOne, snapshot([node()])).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(exactOne, snapshot([node(), node({ text: '1' })])).state, TRI_STATE.FALSE);

  const implicitOne = structuredClone(exactOne);
  delete implicitOne.expr.cardinality;
  assert.equal(evaluatePostcondition(implicitOne, snapshot([node(), node({ text: '1' })])).state, TRI_STATE.UNKNOWN);

  const gteTwo = structuredClone(exactOne);
  gteTwo.expr.cardinality = { op: 'gte', value: 2 };
  assert.equal(evaluatePostcondition(gteTwo, snapshot([node(), node({ text: '1' })], { semantic_tree_complete: false })).state, TRI_STATE.TRUE);

  const lteOne = structuredClone(exactOne);
  lteOne.expr.cardinality = { op: 'lte', value: 1 };
  assert.equal(evaluatePostcondition(lteOne, snapshot([node(), node({ text: '1' })], { semantic_tree_complete: false })).state, TRI_STATE.FALSE);

  const exactCount = {
    mode: 'state',
    preexisting_ok: true,
    expr: {
      kind: 'node_count', selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' }, scope: SCOPE,
      op: 'eq', value: 2,
    },
  };
  assert.equal(evaluatePostcondition(exactCount, snapshot([node(), node({ text: '1' })])).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(exactCount, snapshot([node()], { truncated: true })).state, TRI_STATE.UNKNOWN);
});

test('scoped negative and singular proofs require a represented target application window', () => {
  const itemSelector = { kind: 'RESOURCE_ID', value: 'com.example.shop:id/item' };
  const targetRoot = node({ resource_id: 'com.example.shop:id/root', text: 'catalog' });
  const item = node({ resource_id: 'com.example.shop:id/item', text: '1' });
  const otherRoot = node({
    resource_id: 'com.example.other:id/root',
    text: 'other catalog',
    window_package: 'com.example.other',
  });
  const baseline = snapshot([targetRoot, item]);
  const otherApp = snapshot([otherRoot], {
    package: 'com.example.other',
    activity: 'com.example.other.HomeActivity',
  });
  const targetItemRemoved = snapshot([targetRoot]);

  const absent = {
    mode: 'state', preexisting_ok: true,
    expr: { kind: 'node_absent', selector: itemSelector, scope: SCOPE },
  };
  const countZero = {
    mode: 'state', preexisting_ok: true,
    expr: { kind: 'node_count', selector: itemSelector, scope: SCOPE, op: 'eq', value: 0 },
  };
  const singularPresent = {
    mode: 'state', preexisting_ok: true,
    expr: { kind: 'node_present', selector: itemSelector, scope: SCOPE },
  };
  const singularField = {
    mode: 'state', preexisting_ok: true,
    expr: {
      kind: 'node_field', selector: itemSelector, scope: SCOPE,
      field: 'text', op: 'eq', value: '1',
    },
  };
  const absentTransition = { mode: 'transition', expr: absent.expr };
  const countZeroTransition = { mode: 'transition', expr: countZero.expr };

  assert.equal(evaluatePostcondition(absent, otherApp).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(countZero, otherApp).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(singularPresent, otherApp).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(singularField, otherApp).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostconditionTransition(absentTransition, { baseline, current: otherApp }).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostconditionTransition(countZeroTransition, { baseline, current: otherApp }).state, TRI_STATE.UNKNOWN);

  assert.equal(evaluatePostcondition(absent, targetItemRemoved).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(countZero, targetItemRemoved).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(singularPresent, targetItemRemoved).state, TRI_STATE.FALSE);
  assert.equal(evaluatePostcondition(singularField, targetItemRemoved).state, TRI_STATE.FALSE);
  assert.equal(evaluatePostconditionTransition(absentTransition, { baseline, current: targetItemRemoved }).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostconditionTransition(countZeroTransition, { baseline, current: targetItemRemoved }).state, TRI_STATE.TRUE);
});

test('uniqueness, absence, exact count, and field attribution use only the fixed v1 completeness metadata', () => {
  const field = fieldPostcondition('1');
  assert.equal(evaluatePostcondition(field, snapshot([node({ text: '1' })], { truncated: true })).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(field, snapshot([node({ text: '1' })], { semantic_tree_complete: false })).state, TRI_STATE.UNKNOWN);
  const fixedV1Observation = snapshot([node({ text: '1' })]);
  delete fixedV1Observation.window_provenance_complete;
  assert.equal(evaluatePostcondition(field, fixedV1Observation).state, TRI_STATE.TRUE);
  assert.equal(evaluatePostcondition(field, snapshot([node({ text: '1', window_type: undefined })])).state, TRI_STATE.UNKNOWN);

  const absent = {
    mode: 'state', preexisting_ok: true,
    expr: { kind: 'node_absent', selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' }, scope: SCOPE },
  };
  assert.equal(evaluatePostcondition(absent, snapshot([], { truncated: true })).state, TRI_STATE.UNKNOWN);
});

test('system and IME lookalikes never satisfy an application-scoped business predicate', () => {
  const declaration = fieldPostcondition('1');
  const ime = node({ text: '1', window_type: 'INPUT_METHOD', window_package: 'com.android.inputmethod.latin' });
  const targetRoot = node({ resource_id: 'com.example.shop:id/root', text: 'catalog' });
  const result = evaluatePostcondition(declaration, snapshot([targetRoot, ime]));
  assert.equal(result.state, TRI_STATE.FALSE);
  assert.equal(result.reason, 'COMPLETE_NODE_FIELD_MISSING');
});

test('sensitive, redacted, and authorization surfaces stay UNKNOWN rather than becoming business evidence', () => {
  const declaration = fieldPostcondition('1');
  assert.equal(evaluatePostcondition(declaration, snapshot([node({ text: '1', sensitive: true })])).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(declaration, snapshot([node({ text: '1' })], { authorization_required: true })).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(declaration, snapshot([node({ text: '1' })], { privacy_mode: 'USER_AUTH_REDACTED' })).state, TRI_STATE.UNKNOWN);

  const textSelector = {
    mode: 'state',
    preexisting_ok: true,
    expr: { kind: 'node_absent', selector: { kind: 'TEXT', value: '1' }, scope: SCOPE },
  };
  assert.equal(evaluatePostcondition(textSelector, snapshot([node({ text: 'redacted', sensitive: true })])).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(textSelector, snapshot([
    node({ text: 'redacted', sensitive: true, window_type: undefined, window_package: undefined }),
  ])).state, TRI_STATE.UNKNOWN);

  const missingAuthorization = snapshot([node({ text: '1' })]);
  delete missingAuthorization.authorization_required;
  assert.equal(evaluatePostcondition(declaration, missingAuthorization).state, TRI_STATE.UNKNOWN);

  const missingPrivacyMode = snapshot([node({ text: '1' })]);
  delete missingPrivacyMode.privacy_mode;
  assert.equal(evaluatePostcondition(declaration, missingPrivacyMode).state, TRI_STATE.UNKNOWN);

  const packageAndActivity = {
    mode: 'state',
    preexisting_ok: true,
    expr: {
      kind: 'all',
      children: [
        { kind: 'package_is', value: 'com.example.shop' },
        { kind: 'activity_is', value: 'com.example.shop.CartActivity' },
      ],
    },
  };
  assert.equal(evaluatePostcondition(packageAndActivity, missingAuthorization).state, TRI_STATE.UNKNOWN);
});

test('singular field predicates reject multiple candidates and unavailable field values', () => {
  const declaration = fieldPostcondition('1');
  assert.equal(evaluatePostcondition(declaration, snapshot([node({ text: '1' }), node({ text: '1' })])).state, TRI_STATE.UNKNOWN);
  assert.equal(evaluatePostcondition(declaration, snapshot([node({ text: true })])).state, TRI_STATE.UNKNOWN);
});

test('field transition accepts a declared exact from/to pair without treating it as a generic fingerprint transition', () => {
  const declaration = {
    mode: 'transition',
    expr: {
      kind: 'node_field_transition',
      selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity' },
      scope: SCOPE,
      field: 'text',
      from: '0',
      to: '1',
    },
  };
  const success = evaluatePostconditionTransition(declaration, {
    baseline: snapshot([node({ text: '0' })]),
    current: snapshot([node({ text: '1' })]),
  });
  assert.equal(success.state, TRI_STATE.TRUE);

  const wrongFrom = evaluatePostconditionTransition(declaration, {
    baseline: snapshot([node({ text: '2' })]),
    current: snapshot([node({ text: '1' })]),
  });
  assert.equal(wrongFrom.state, TRI_STATE.FALSE);
});

test('any keeps independently declared field-transition alternatives independent', () => {
  const declaration = {
    mode: 'transition',
    expr: {
      kind: 'any',
      children: [
        {
          kind: 'node_field_transition',
          selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity-a' },
          scope: SCOPE,
          field: 'text', from: '0', to: '1',
        },
        {
          kind: 'node_field_transition',
          selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/quantity-b' },
          scope: SCOPE,
          field: 'text', from: '0', to: '1',
        },
      ],
    },
  };
  const baseline = snapshot([
    node({ resource_id: 'com.example.shop:id/quantity-a', text: '0' }),
    node({ resource_id: 'com.example.shop:id/quantity-b', text: '9' }),
  ]);
  const current = snapshot([
    node({ resource_id: 'com.example.shop:id/quantity-a', text: '1' }),
    node({ resource_id: 'com.example.shop:id/quantity-b', text: '9' }),
  ]);
  assert.equal(evaluatePostconditionTransition(declaration, { baseline, current }).state, TRI_STATE.TRUE);
});

test('transition mode rejects a post-state already true through another any branch', () => {
  const declaration = {
    mode: 'transition',
    expr: {
      kind: 'any',
      children: [
        {
          kind: 'node_field',
          selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/item' },
          scope: SCOPE,
          field: 'text', op: 'eq', value: '1',
        },
        {
          kind: 'node_field',
          selector: { kind: 'RESOURCE_ID', value: 'com.example.shop:id/already' },
          scope: SCOPE,
          field: 'text', op: 'eq', value: 'yes',
        },
      ],
    },
  };
  const baseline = snapshot([
    node({ resource_id: 'com.example.shop:id/item', text: '0' }),
    node({ resource_id: 'com.example.shop:id/already', text: 'yes' }),
  ]);
  const current = snapshot([
    node({ resource_id: 'com.example.shop:id/item', text: '1' }),
    node({ resource_id: 'com.example.shop:id/already', text: 'yes' }),
  ]);
  const result = evaluatePostconditionTransition(declaration, { baseline, current });
  assert.equal(result.baseline.state, TRI_STATE.TRUE);
  assert.equal(result.current.state, TRI_STATE.TRUE);
  assert.equal(result.state, TRI_STATE.FALSE);
});

test('an UNKNOWN baseline remains UNKNOWN even when the current state is decisively FALSE', () => {
  const result = evaluatePostconditionTransition(fieldPostcondition('1'), {
    baseline: snapshot([node({ text: '0' })], { semantic_tree_complete: false }),
    current: snapshot([node({ text: '0' })]),
  });
  assert.equal(result.baseline.state, TRI_STATE.UNKNOWN);
  assert.equal(result.current.state, TRI_STATE.FALSE);
  assert.equal(result.state, TRI_STATE.UNKNOWN);
});

test('state mode may accept an idempotent already-satisfied state but transition mode may not', () => {
  const stateDeclaration = { ...fieldPostcondition('1'), mode: 'state', preexisting_ok: true };
  assert.equal(evaluatePostconditionTransition(stateDeclaration, {
    baseline: snapshot([node({ text: '1' })]),
    current: snapshot([node({ text: '1' })]),
  }).state, TRI_STATE.TRUE);

  assert.equal(evaluatePostconditionTransition(fieldPostcondition('1'), {
    baseline: snapshot([node({ text: '1' })]),
    current: snapshot([node({ text: '1' })]),
  }).state, TRI_STATE.FALSE);
});
