const MAX_EXPRESSION_DEPTH = 5;
const MAX_BRANCHES = 8;
const MAX_SELECTOR_VALUE_LENGTH = 512;
const MAX_PACKAGE_LENGTH = 256;
const MAX_VERIFY_TIMEOUT_MS = 30_000;
const MAX_VERIFY_POLL_MS = 10_000;

const SELECTOR_FIELDS = Object.freeze({
  TEXT: 'text',
  CONTENT_DESCRIPTION: 'content_description',
  RESOURCE_ID: 'resource_id',
  CLASS_NAME: 'class_name',
});

const NODE_FIELDS = new Set([
  'text',
  'content_description',
  'enabled',
  'editable',
  'clickable',
  'visible_to_user',
]);

const NODE_TEXT_FIELDS = new Set(['text', 'content_description']);
const CARDINALITY_OPS = new Set(['eq', 'gte', 'lte']);
const EXPRESSION_KINDS = new Set([
  'node_present',
  'node_absent',
  'node_field',
  'node_count',
  'node_field_transition',
  'package_is',
  'activity_is',
  'all',
  'any',
]);

export const TRI_STATE = Object.freeze({
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  UNKNOWN: 'UNKNOWN',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys, path, errors) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) errors.push(`${path}.${key} is not supported`);
  }
}

function validateString(value, path, errors, { allowEmpty = false, max = MAX_SELECTOR_VALUE_LENGTH } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    errors.push(`${path} must be a ${allowEmpty ? 'string' : 'non-empty string'} no longer than ${max} characters`);
  }
}

function validateInteger(value, path, errors, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
}

function validateSelector(selector, path, errors) {
  if (!isPlainObject(selector)) {
    errors.push(`${path} must be an object`);
    return;
  }
  hasOnlyKeys(selector, new Set(['kind', 'value']), path, errors);
  if (!Object.hasOwn(SELECTOR_FIELDS, selector.kind)) errors.push(`${path}.kind must be an exact v1 selector kind`);
  validateString(selector.value, `${path}.value`, errors);
}

function validateScope(scope, path, errors) {
  if (!isPlainObject(scope)) {
    errors.push(`${path} must be an object`);
    return;
  }
  hasOnlyKeys(scope, new Set(['window_type', 'package']), path, errors);
  if (scope.window_type !== 'APPLICATION') errors.push(`${path}.window_type must be APPLICATION`);
  validateString(scope.package, `${path}.package`, errors, { max: MAX_PACKAGE_LENGTH });
}

function validateCardinality(cardinality, path, errors, { defaultValue = 1 } = {}) {
  if (cardinality === undefined) return { op: 'eq', value: defaultValue };
  if (!isPlainObject(cardinality)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  hasOnlyKeys(cardinality, new Set(['op', 'value']), path, errors);
  if (!CARDINALITY_OPS.has(cardinality.op)) errors.push(`${path}.op must be eq, gte, or lte`);
  validateInteger(cardinality.value, `${path}.value`, errors);
  return cardinality;
}

function validateFieldValue(field, value, path, errors) {
  if (NODE_TEXT_FIELDS.has(field)) {
    validateString(value, path, errors, { allowEmpty: true });
    return;
  }
  if (typeof value !== 'boolean') errors.push(`${path} must be boolean for ${field}`);
}

function validateExpression(expression, path, depth, errors) {
  if (!isPlainObject(expression)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (depth > MAX_EXPRESSION_DEPTH) {
    errors.push(`${path} exceeds maximum expression depth ${MAX_EXPRESSION_DEPTH}`);
    return;
  }
  if (!EXPRESSION_KINDS.has(expression.kind)) {
    errors.push(`${path}.kind is not a supported postcondition predicate`);
    return;
  }

  switch (expression.kind) {
    case 'node_present':
      hasOnlyKeys(expression, new Set(['kind', 'selector', 'scope', 'cardinality']), path, errors);
      validateSelector(expression.selector, `${path}.selector`, errors);
      validateScope(expression.scope, `${path}.scope`, errors);
      validateCardinality(expression.cardinality, `${path}.cardinality`, errors);
      return;
    case 'node_absent':
      hasOnlyKeys(expression, new Set(['kind', 'selector', 'scope', 'include_invisible']), path, errors);
      validateSelector(expression.selector, `${path}.selector`, errors);
      validateScope(expression.scope, `${path}.scope`, errors);
      if (expression.include_invisible !== undefined && typeof expression.include_invisible !== 'boolean') {
        errors.push(`${path}.include_invisible must be boolean`);
      }
      return;
    case 'node_field':
      hasOnlyKeys(expression, new Set(['kind', 'selector', 'scope', 'field', 'op', 'value']), path, errors);
      validateSelector(expression.selector, `${path}.selector`, errors);
      validateScope(expression.scope, `${path}.scope`, errors);
      if (!NODE_FIELDS.has(expression.field)) errors.push(`${path}.field is not allowlisted in v1`);
      if (expression.op !== 'eq') errors.push(`${path}.op must be eq`);
      if (NODE_FIELDS.has(expression.field)) validateFieldValue(expression.field, expression.value, `${path}.value`, errors);
      return;
    case 'node_count':
      hasOnlyKeys(expression, new Set(['kind', 'selector', 'scope', 'op', 'value']), path, errors);
      validateSelector(expression.selector, `${path}.selector`, errors);
      validateScope(expression.scope, `${path}.scope`, errors);
      if (!CARDINALITY_OPS.has(expression.op)) errors.push(`${path}.op must be eq, gte, or lte`);
      validateInteger(expression.value, `${path}.value`, errors);
      return;
    case 'node_field_transition':
      hasOnlyKeys(expression, new Set(['kind', 'selector', 'scope', 'field', 'from', 'to']), path, errors);
      validateSelector(expression.selector, `${path}.selector`, errors);
      validateScope(expression.scope, `${path}.scope`, errors);
      if (!NODE_FIELDS.has(expression.field)) errors.push(`${path}.field is not allowlisted in v1`);
      if (NODE_FIELDS.has(expression.field)) {
        validateFieldValue(expression.field, expression.from, `${path}.from`, errors);
        validateFieldValue(expression.field, expression.to, `${path}.to`, errors);
        if (expression.from === expression.to) {
          errors.push(`${path}.from and ${path}.to must describe a real transition`);
        }
      }
      return;
    case 'package_is':
    case 'activity_is':
      hasOnlyKeys(expression, new Set(['kind', 'value']), path, errors);
      validateString(expression.value, `${path}.value`, errors, { max: MAX_PACKAGE_LENGTH });
      return;
    case 'all':
    case 'any': {
      hasOnlyKeys(expression, new Set(['kind', 'children']), path, errors);
      if (!Array.isArray(expression.children) || expression.children.length === 0 || expression.children.length > MAX_BRANCHES) {
        errors.push(`${path}.children must contain 1 to ${MAX_BRANCHES} predicates`);
        return;
      }
      expression.children.forEach((child, index) => validateExpression(child, `${path}.children[${index}]`, depth + 1, errors));
    }
  }
}

export function validatePostcondition(postcondition) {
  const errors = [];
  if (!isPlainObject(postcondition)) return { ok: false, errors: ['postcondition must be an object'] };

  hasOnlyKeys(postcondition, new Set(['mode', 'expr', 'verify', 'preexisting_ok']), 'postcondition', errors);
  if (postcondition.mode !== 'transition' && postcondition.mode !== 'state') {
    errors.push('postcondition.mode must be transition or state');
  }
  validateExpression(postcondition.expr, 'postcondition.expr', 1, errors);
  if (postcondition.preexisting_ok !== undefined && typeof postcondition.preexisting_ok !== 'boolean') {
    errors.push('postcondition.preexisting_ok must be boolean');
  }
  if (postcondition.mode === 'transition' && postcondition.preexisting_ok !== undefined) {
    errors.push('postcondition.preexisting_ok is allowed only for state mode');
  }
  if (postcondition.verify !== undefined) {
    if (!isPlainObject(postcondition.verify)) {
      errors.push('postcondition.verify must be an object');
    } else {
      hasOnlyKeys(postcondition.verify, new Set(['timeout_ms', 'poll_ms']), 'postcondition.verify', errors);
      validateInteger(postcondition.verify.timeout_ms, 'postcondition.verify.timeout_ms', errors, { minimum: 1, maximum: MAX_VERIFY_TIMEOUT_MS });
      validateInteger(postcondition.verify.poll_ms, 'postcondition.verify.poll_ms', errors, { minimum: 1, maximum: MAX_VERIFY_POLL_MS });
      if (Number.isInteger(postcondition.verify.timeout_ms) && Number.isInteger(postcondition.verify.poll_ms)
        && postcondition.verify.poll_ms > postcondition.verify.timeout_ms) {
        errors.push('postcondition.verify.poll_ms must not exceed timeout_ms');
      }
    }
  }
  if (postcondition.mode === 'state' && containsFieldTransition(postcondition.expr)) {
    errors.push('node_field_transition is only valid in transition mode');
  }
  return errors.length === 0 ? { ok: true, value: postcondition } : { ok: false, errors };
}

function state(state, reason, extra = {}) {
  return { state, reason, ...extra };
}

function combineAll(results) {
  if (results.some((result) => result.state === TRI_STATE.FALSE)) return state(TRI_STATE.FALSE, 'ALL_FALSE');
  if (results.some((result) => result.state === TRI_STATE.UNKNOWN)) return state(TRI_STATE.UNKNOWN, 'ALL_UNKNOWN');
  return state(TRI_STATE.TRUE, 'ALL_TRUE');
}

function combineAny(results) {
  if (results.some((result) => result.state === TRI_STATE.TRUE)) return state(TRI_STATE.TRUE, 'ANY_TRUE');
  if (results.some((result) => result.state === TRI_STATE.UNKNOWN)) return state(TRI_STATE.UNKNOWN, 'ANY_UNKNOWN');
  return state(TRI_STATE.FALSE, 'ANY_FALSE');
}

function isProtectedObservation(observation) {
  return observation?.authorization_required !== false
    || observation?.privacy_mode !== 'NORMAL'
    || observation?.redacted === true;
}

function isSensitiveNode(node) {
  return node?.sensitive === true || node?.redacted === true;
}

function selectorMatches(node, selector) {
  const field = SELECTOR_FIELDS[selector.kind];
  return field !== undefined && node?.[field] === selector.value;
}

function selectNodes(observation, selector, scope, { includeInvisible = false } = {}) {
  if (!Array.isArray(observation?.nodes)) {
    return { nodes: [], scopeComplete: false, provenanceGap: true, sensitiveMatch: false };
  }

  const nodes = [];
  let provenanceGap = false;
  let sensitiveMatch = false;
  let targetWindowPresent = false;
  for (const node of observation.nodes) {
    if (!isPlainObject(node)) {
      provenanceGap = true;
      continue;
    }
    if (isSensitiveNode(node)) {
      if (typeof node.window_type !== 'string' || typeof node.window_package !== 'string') {
        provenanceGap = true;
        continue;
      }
      if (node.window_type === 'APPLICATION' && node.window_package === scope.package) {
        if (selector.kind === 'TEXT' || selector.kind === 'CONTENT_DESCRIPTION'
          || ((selector.kind === 'RESOURCE_ID' || selector.kind === 'CLASS_NAME') && selectorMatches(node, selector))) {
          sensitiveMatch = true;
        }
      }
      continue;
    }
    if (node.window_type === 'APPLICATION'
      && node.window_package === scope.package
      && node.visible_to_user === true) {
      targetWindowPresent = true;
    }
    if (!selectorMatches(node, selector)) continue;
    if (typeof node.window_type !== 'string' || typeof node.window_package !== 'string') {
      provenanceGap = true;
      continue;
    }
    if (node.window_type !== 'APPLICATION' || node.window_package !== scope.package) continue;
    if (!includeInvisible && node.visible_to_user !== true) continue;
    nodes.push(node);
  }

  const scopeComplete = observation?.semantic_tree_complete === true
    && observation?.truncated === false
    && targetWindowPresent
    && !provenanceGap
    && !sensitiveMatch;
  return { nodes, scopeComplete, provenanceGap, sensitiveMatch, targetWindowPresent };
}

function evaluateCardinality(count, cardinality, scopeComplete) {
  const { op, value } = cardinality;
  if (op === 'gte') {
    if (count >= value) return state(TRI_STATE.TRUE, 'OBSERVED_GTE', { matched_count: count });
    return scopeComplete
      ? state(TRI_STATE.FALSE, 'COMPLETE_GTE_SHORTAGE', { matched_count: count })
      : state(TRI_STATE.UNKNOWN, 'INCOMPLETE_GTE_SHORTAGE', { matched_count: count });
  }
  if (op === 'lte') {
    if (count > value) return state(TRI_STATE.FALSE, 'OBSERVED_LTE_EXCEEDED', { matched_count: count });
    return scopeComplete
      ? state(TRI_STATE.TRUE, 'COMPLETE_LTE', { matched_count: count })
      : state(TRI_STATE.UNKNOWN, 'INCOMPLETE_LTE', { matched_count: count });
  }
  if (count > value) return state(TRI_STATE.FALSE, 'OBSERVED_EQ_EXCEEDED', { matched_count: count });
  if (!scopeComplete) return state(TRI_STATE.UNKNOWN, 'INCOMPLETE_EQ', { matched_count: count });
  return count === value
    ? state(TRI_STATE.TRUE, 'COMPLETE_EQ', { matched_count: count })
    : state(TRI_STATE.FALSE, 'COMPLETE_EQ_MISMATCH', { matched_count: count });
}

function evaluateNodePresent(expression, observation) {
  const selection = selectNodes(observation, expression.selector, expression.scope);
  if (expression.cardinality === undefined && selection.nodes.length > 1) {
    return state(TRI_STATE.UNKNOWN, 'AMBIGUOUS_NODE_PRESENT', { matched_count: selection.nodes.length });
  }
  return evaluateCardinality(selection.nodes.length, expression.cardinality ?? { op: 'eq', value: 1 }, selection.scopeComplete);
}

function evaluateNodeAbsent(expression, observation) {
  const selection = selectNodes(observation, expression.selector, expression.scope, {
    includeInvisible: expression.include_invisible === true,
  });
  if (selection.nodes.length > 0) return state(TRI_STATE.FALSE, 'OBSERVED_NODE_PRESENT', { matched_count: selection.nodes.length });
  return selection.scopeComplete
    ? state(TRI_STATE.TRUE, 'COMPLETE_NODE_ABSENT', { matched_count: 0 })
    : state(TRI_STATE.UNKNOWN, 'INCOMPLETE_NODE_ABSENCE', { matched_count: 0 });
}

function evaluateNodeField(expression, observation) {
  const selection = selectNodes(observation, expression.selector, expression.scope);
  if (selection.nodes.length > 1) return state(TRI_STATE.UNKNOWN, 'AMBIGUOUS_NODE_FIELD', { matched_count: selection.nodes.length });
  if (selection.nodes.length === 0) {
    return selection.scopeComplete
      ? state(TRI_STATE.FALSE, 'COMPLETE_NODE_FIELD_MISSING', { matched_count: 0 })
      : state(TRI_STATE.UNKNOWN, 'INCOMPLETE_NODE_FIELD_MISSING', { matched_count: 0 });
  }
  const actual = selection.nodes[0][expression.field];
  const expectedType = NODE_TEXT_FIELDS.has(expression.field) ? 'string' : 'boolean';
  if (actual === null || actual === undefined || typeof actual !== expectedType) {
    return state(TRI_STATE.UNKNOWN, 'NODE_FIELD_UNAVAILABLE', { matched_count: 1 });
  }
  if (!selection.scopeComplete) return state(TRI_STATE.UNKNOWN, 'INCOMPLETE_NODE_FIELD_ATTRIBUTION', { matched_count: 1 });
  return actual === expression.value
    ? state(TRI_STATE.TRUE, 'COMPLETE_NODE_FIELD_EQUAL', { matched_count: 1 })
    : state(TRI_STATE.FALSE, 'COMPLETE_NODE_FIELD_MISMATCH', { matched_count: 1 });
}

function evaluateNodeCount(expression, observation) {
  const selection = selectNodes(observation, expression.selector, expression.scope);
  return evaluateCardinality(selection.nodes.length, { op: expression.op, value: expression.value }, selection.scopeComplete);
}

function evaluateExpression(expression, observation, { phase } = {}) {
  if (isProtectedObservation(observation)) return state(TRI_STATE.UNKNOWN, 'AUTH_OR_REDACTION_REQUIRED');
  switch (expression.kind) {
    case 'node_present': return evaluateNodePresent(expression, observation);
    case 'node_absent': return evaluateNodeAbsent(expression, observation);
    case 'node_field': return evaluateNodeField(expression, observation);
    case 'node_count': return evaluateNodeCount(expression, observation);
    case 'package_is': {
      if (typeof observation?.package !== 'string') return state(TRI_STATE.UNKNOWN, 'PACKAGE_UNAVAILABLE');
      return observation.package === expression.value
        ? state(TRI_STATE.TRUE, 'PACKAGE_MATCH')
        : state(TRI_STATE.FALSE, 'PACKAGE_MISMATCH');
    }
    case 'activity_is': {
      if (typeof observation?.activity !== 'string') return state(TRI_STATE.UNKNOWN, 'ACTIVITY_UNAVAILABLE');
      return observation.activity === expression.value
        ? state(TRI_STATE.TRUE, 'ACTIVITY_MATCH')
        : state(TRI_STATE.FALSE, 'ACTIVITY_MISMATCH');
    }
    case 'all': return combineAll(expression.children.map((child) => evaluateExpression(child, observation, { phase })));
    case 'any': return combineAny(expression.children.map((child) => evaluateExpression(child, observation, { phase })));
    case 'node_field_transition': {
      if (phase !== 'baseline' && phase !== 'current') return state(TRI_STATE.UNKNOWN, 'BASELINE_REQUIRED');
      return evaluateNodeField({
        kind: 'node_field',
        selector: expression.selector,
        scope: expression.scope,
        field: expression.field,
        op: 'eq',
        value: phase === 'baseline' ? expression.from : expression.to,
      }, observation);
    }
    default: return state(TRI_STATE.UNKNOWN, 'UNSUPPORTED_PREDICATE');
  }
}

function containsFieldTransition(expression) {
  if (!isPlainObject(expression)) return false;
  if (expression.kind === 'node_field_transition') return true;
  return (expression.kind === 'all' || expression.kind === 'any')
    && Array.isArray(expression.children)
    && expression.children.some(containsFieldTransition);
}

function evaluateTransitionRequirements(expression, baseline, current) {
  if (expression.kind === 'node_field_transition') {
    return combineAll([
      evaluateExpression(expression, baseline, { phase: 'baseline' }),
      evaluateExpression(expression, current, { phase: 'current' }),
    ]);
  }
  if (expression.kind === 'all') {
    return combineAll(expression.children.map((child) => evaluateTransitionRequirements(child, baseline, current)));
  }
  if (expression.kind === 'any') {
    return combineAny(expression.children.map((child) => evaluateTransitionRequirements(child, baseline, current)));
  }
  return evaluateExpression(expression, current, { phase: 'current' });
}

function evaluateTransitionExpression(expression, baseline, current) {
  const desiredBaseline = evaluateExpression(expression, baseline, { phase: 'current' });
  if (desiredBaseline.state === TRI_STATE.UNKNOWN) {
    return state(TRI_STATE.UNKNOWN, 'TRANSITION_UNVERIFIABLE');
  }
  if (desiredBaseline.state === TRI_STATE.TRUE) {
    return state(TRI_STATE.FALSE, 'TRANSITION_ALREADY_SATISFIED');
  }
  return evaluateTransitionRequirements(expression, baseline, current);
}

function evaluateTransitionBaselineRequirements(expression, baseline) {
  if (expression.kind === 'node_field_transition') {
    return evaluateExpression(expression, baseline, { phase: 'baseline' });
  }
  if (expression.kind === 'all') {
    return combineAll(expression.children.map((child) => evaluateTransitionBaselineRequirements(child, baseline)));
  }
  if (expression.kind === 'any') {
    return combineAny(expression.children.map((child) => evaluateTransitionBaselineRequirements(child, baseline)));
  }
  return state(TRI_STATE.TRUE, 'NO_BASELINE_TRANSITION_REQUIREMENT');
}

export function evaluatePostconditionBaseline(postcondition, baseline) {
  const validation = validatePostcondition(postcondition);
  if (!validation.ok) {
    return {
      ...state(TRI_STATE.UNKNOWN, 'INVALID_POSTCONDITION', { errors: validation.errors }),
      can_dispatch: false,
    };
  }

  const desired = evaluateExpression(postcondition.expr, baseline, { phase: 'current' });
  if (postcondition.mode === 'state') {
    return { ...desired, can_dispatch: desired.state === TRI_STATE.FALSE };
  }
  if (desired.state === TRI_STATE.TRUE) {
    return {
      ...state(TRI_STATE.TRUE, 'TRANSITION_ALREADY_SATISFIED'),
      can_dispatch: false,
    };
  }
  if (desired.state !== TRI_STATE.FALSE) {
    return {
      ...state(TRI_STATE.UNKNOWN, 'TRANSITION_BASELINE_UNVERIFIABLE'),
      can_dispatch: false,
    };
  }

  const requirements = evaluateTransitionBaselineRequirements(postcondition.expr, baseline);
  if (requirements.state === TRI_STATE.TRUE) {
    return {
      ...state(TRI_STATE.FALSE, 'TRANSITION_BASELINE_READY'),
      can_dispatch: true,
      baseline_requirements: requirements,
    };
  }
  if (requirements.state === TRI_STATE.FALSE) {
    return {
      ...state(TRI_STATE.FALSE, 'TRANSITION_BASELINE_FROM_MISMATCH'),
      can_dispatch: false,
      baseline_requirements: requirements,
    };
  }
  return {
    ...state(TRI_STATE.UNKNOWN, 'TRANSITION_BASELINE_UNVERIFIABLE'),
    can_dispatch: false,
    baseline_requirements: requirements,
  };
}

export function evaluatePostcondition(postcondition, observation) {
  const validation = validatePostcondition(postcondition);
  if (!validation.ok) return state(TRI_STATE.UNKNOWN, 'INVALID_POSTCONDITION', { errors: validation.errors });
  return evaluateExpression(postcondition.expr, observation);
}

export function evaluatePostconditionTransition(postcondition, { baseline, current } = {}) {
  const validation = validatePostcondition(postcondition);
  if (!validation.ok) return { ...state(TRI_STATE.UNKNOWN, 'INVALID_POSTCONDITION', { errors: validation.errors }), baseline: null, current: null };

  const baselineResult = evaluateExpression(postcondition.expr, baseline, { phase: 'current' });
  const currentResult = evaluateExpression(postcondition.expr, current, { phase: 'current' });
  if (postcondition.mode === 'state') {
    return { ...currentResult, baseline: baselineResult, current: currentResult };
  }

  const result = evaluateTransitionExpression(postcondition.expr, baseline, current);
  return { ...result, baseline: baselineResult, current: currentResult };
}
