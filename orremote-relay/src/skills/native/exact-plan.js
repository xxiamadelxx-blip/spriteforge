const AUTH_PATTERN = /(?:password|passcode|pin|otp|2fa|verification code|security code|api[ _-]?token|access[ _-]?token|secret|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|токен|секрет)/iu;
const MAX_CAPTURE_CHARS = 20_000;

function allNodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function descriptor(node) {
  return [node?.text, node?.content_description, node?.resource_id, node?.class_name]
    .filter(Boolean)
    .join(' ');
}

function enabled(node) {
  return node?.enabled !== false && typeof node?.handle === 'string' && node.handle.length > 0;
}

function containsBounds(parent, child) {
  const p = parent?.bounds;
  const c = child?.bounds;
  return Boolean(
    p && c
    && p.left <= c.left
    && p.top <= c.top
    && p.right >= c.right
    && p.bottom >= c.bottom,
  );
}

function descendants(snapshot, root) {
  const rootDepth = Number(root?.depth ?? 0);
  return allNodes(snapshot).filter((candidate) => (
    candidate !== root
    && Number(candidate?.depth ?? 0) > rootDepth
    && containsBounds(root, candidate)
  ));
}

function semanticDescriptor(snapshot, root) {
  const parts = [descriptor(root)];
  for (const candidate of descendants(snapshot, root)) {
    parts.push(descriptor(candidate));
  }
  return parts.filter(Boolean).join(' ');
}

function clickableAncestor(nodes, index) {
  const target = nodes[index];
  if (!target) return null;
  if (target.clickable === true && enabled(target)) return target;
  const targetDepth = Number(target.depth ?? 0);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = nodes[i];
    if (Number(candidate?.depth ?? 0) >= targetDepth) continue;
    if (!containsBounds(candidate, target)) continue;
    if (candidate.clickable === true && enabled(candidate)) return candidate;
  }
  return null;
}

function selectorMatches(node, selector) {
  const kind = String(selector?.kind || '').toUpperCase();
  const value = String(selector?.value ?? '');
  switch (kind) {
    case 'HANDLE': return String(node?.handle ?? '') === value;
    case 'TEXT': return String(node?.text ?? '') === value;
    case 'CONTENT_DESCRIPTION': return String(node?.content_description ?? '') === value;
    case 'RESOURCE_ID': return String(node?.resource_id ?? '') === value;
    case 'CLASS_NAME': return String(node?.class_name ?? '') === value;
    default: return false;
  }
}

function findExactNode(snapshot, selector) {
  return allNodes(snapshot).find((node) => selectorMatches(node, selector)) || null;
}

function findExactText(snapshot, text) {
  const expected = String(text ?? '');
  return allNodes(snapshot).find((node) => (
    String(node?.text ?? '') === expected
    || String(node?.content_description ?? '') === expected
  )) || null;
}

function findClickable(snapshot, target) {
  const nodes = allNodes(snapshot);
  const index = nodes.indexOf(target);
  return index < 0 ? null : clickableAncestor(nodes, index);
}

function centerOfBounds(node) {
  const bounds = node?.bounds;
  if (!bounds) return null;
  const left = Number(bounds.left);
  const top = Number(bounds.top);
  const right = Number(bounds.right);
  const bottom = Number(bounds.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right <= left || bottom <= top) return null;
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  };
}

function viewport(snapshot) {
  const bounds = allNodes(snapshot)
    .map((node) => node?.bounds)
    .filter((value) => value && Number.isFinite(Number(value.right)) && Number.isFinite(Number(value.bottom)));
  return {
    width: Math.max(1, ...bounds.map((value) => Number(value.right))),
    height: Math.max(1, ...bounds.map((value) => Number(value.bottom))),
  };
}

function scrollDirective(snapshot, stepIndex) {
  const { width, height } = viewport(snapshot);
  const x = Math.max(1, Math.floor(width * 0.5));
  return {
    type: 'SWIPE',
    start_x: x,
    start_y: Math.max(1, Math.floor(height * 0.78)),
    end_x: x,
    end_y: Math.max(1, Math.floor(height * 0.38)),
    duration_ms: 350,
    step_index: stepIndex,
  };
}

function stop(error_code, message) {
  return { type: 'STOP', error_code, message };
}

function sensitive(snapshot, node) {
  return node?.sensitive === true
    || descendants(snapshot, node).some((candidate) => candidate?.sensitive === true)
    || AUTH_PATTERN.test(semanticDescriptor(snapshot, node));
}

function captureText(snapshot, root) {
  const direct = [root?.text, root?.content_description]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (direct.length > 0) return direct.join('\n').slice(0, MAX_CAPTURE_CHARS);

  const parts = [];
  for (const candidate of descendants(snapshot, root)) {
    for (const value of [candidate?.text, candidate?.content_description]) {
      const text = String(value ?? '').trim();
      if (text && !parts.includes(text)) parts.push(text);
    }
  }
  return parts.join('\n').slice(0, MAX_CAPTURE_CHARS);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function createNativeExactPlanSkill({
  id,
  packages,
  effect,
  risk,
  forbiddenClickPattern = null,
}) {
  const allowedPackages = Object.freeze([...packages]);
  const allowedSet = new Set(allowedPackages);
  const dangerous = forbiddenClickPattern instanceof RegExp ? forbiddenClickPattern : null;

  const isDangerous = (snapshot, node) => dangerous ? dangerous.test(semanticDescriptor(snapshot, node)) : false;

  return Object.freeze({
    id,
    packages: allowedPackages,
    safety: { effect, risk },

    createContext({ inputs = {} } = {}) {
      return {
        target_package: String(inputs.package || ''),
        steps: Array.isArray(inputs.steps) ? inputs.steps.map((step) => ({ ...step })) : [],
        index: 0,
        captures: {},
        wait_attempts: {},
      };
    },

    recognize(snapshot, context) {
      return snapshot?.package === context.target_package ? 'TARGET_APP' : 'OTHER_APP';
    },

    async next({ state, snapshot, context }) {
      if (!allowedSet.has(context.target_package)) {
        return stop('SKILL_PACKAGE_NOT_ALLOWED', 'Requested package is outside this skill package allowlist.');
      }
      if (state === 'OTHER_APP') {
        return { type: 'LAUNCH', package: context.target_package };
      }
      if (context.index >= context.steps.length) {
        return {
          type: 'COMPLETE',
          output: {
            package: context.target_package,
            completed_steps: context.index,
            captures: { ...context.captures },
          },
        };
      }

      const step = context.steps[context.index];
      const stepIndex = context.index;

      if (step.type === 'ASSERT_EXACT_TEXT') {
        if (!findExactText(snapshot, step.text)) {
          return stop('NATIVE_ASSERTION_FAILED', `Expected exact text was not present: ${String(step.text || '')}`);
        }
        context.index += 1;
        return { type: 'OBSERVE' };
      }

      if (step.type === 'SCROLL_DOWN') {
        return scrollDirective(snapshot, stepIndex);
      }

      if (step.type === 'WAIT_FOR_EXACT_SELECTOR') {
        const target = findExactNode(snapshot, step.selector);
        if (target) {
          delete context.wait_attempts[stepIndex];
          context.index += 1;
          return { type: 'OBSERVE' };
        }
        const maxAttempts = boundedInteger(step.max_attempts, 20, 1, 40);
        const attempts = Number(context.wait_attempts[stepIndex] || 0) + 1;
        context.wait_attempts[stepIndex] = attempts;
        if (attempts >= maxAttempts) {
          return stop('NATIVE_WAIT_TIMEOUT', `Exact selector did not appear after ${maxAttempts} attempts.`);
        }
        return {
          type: 'WAIT',
          duration_ms: boundedInteger(step.poll_ms, 500, 50, 2_000),
          step_index: stepIndex,
        };
      }

      if (step.type === 'CAPTURE_EXACT_SELECTOR_TEXT') {
        const target = findExactNode(snapshot, step.selector);
        if (!target) return stop('NATIVE_TARGET_NOT_FOUND', 'Exact native capture target was not found.');
        if (sensitive(snapshot, target)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive native content cannot be captured.');
        }
        const key = String(step.key || '').trim();
        if (!key || key.length > 80) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Capture key must be a non-empty string up to 80 characters.');
        }
        context.captures[key] = captureText(snapshot, target);
        context.index += 1;
        return { type: 'OBSERVE' };
      }

      let target = null;
      if (step.type === 'CLICK_EXACT_TEXT') target = findExactText(snapshot, step.text);
      if (
        step.type === 'CLICK_EXACT_SELECTOR'
        || step.type === 'SET_TEXT_EXACT_SELECTOR'
        || step.type === 'TAP_EXACT_SELECTOR_CENTER'
      ) {
        target = findExactNode(snapshot, step.selector);
      }

      if (step.type === 'CLICK_EXACT_TEXT' || step.type === 'CLICK_EXACT_SELECTOR') {
        if (!target) return stop('NATIVE_TARGET_NOT_FOUND', 'Exact native click target was not found.');
        const clickable = findClickable(snapshot, target);
        if (!clickable) return stop('NATIVE_TARGET_NOT_CLICKABLE', 'Matched native target is not clickable.');
        if (sensitive(snapshot, target) || sensitive(snapshot, clickable)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive native control is user-only.');
        }
        if (isDangerous(snapshot, target) || isDangerous(snapshot, clickable)) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Matched native action is outside the skill safety boundary.');
        }
        return { type: 'CLICK_HANDLE', handle: clickable.handle, step_index: stepIndex };
      }

      if (step.type === 'TAP_EXACT_SELECTOR_CENTER') {
        if (!target) return stop('NATIVE_TARGET_NOT_FOUND', 'Exact semantic tap target was not found.');
        if (sensitive(snapshot, target)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive native target is user-only.');
        }
        if (isDangerous(snapshot, target)) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Matched native tap target is outside the skill safety boundary.');
        }
        const center = centerOfBounds(target);
        if (!center) return stop('NATIVE_TARGET_HAS_NO_BOUNDS', 'Semantic tap target has no usable bounds.');
        return {
          type: 'TAP_POINT',
          x: center.x,
          y: center.y,
          selector: { ...step.selector },
          step_index: stepIndex,
        };
      }

      if (step.type === 'SET_TEXT_EXACT_SELECTOR') {
        if (!target) return stop('NATIVE_TARGET_NOT_FOUND', 'Exact native text target was not found.');
        if (target.editable !== true || !enabled(target)) {
          return stop('NATIVE_TARGET_NOT_EDITABLE', 'Matched native target is not editable.');
        }
        if (step.sensitive === true || sensitive(snapshot, target)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive native text entry is user-only.');
        }
        return {
          type: 'SET_TEXT_HANDLE',
          handle: target.handle,
          value: String(step.value ?? ''),
          sensitive: false,
          step_index: stepIndex,
        };
      }

      return stop('SKILL_ACTION_NOT_ALLOWED', `Unsupported native plan step: ${String(step.type || '')}`);
    },

    async validateDirective({ snapshot, directive, context }) {
      if (directive.type === 'LAUNCH') {
        return allowedSet.has(directive.package) && directive.package === context.target_package
          ? { ok: true }
          : { ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'Native skill may launch only its selected package.' };
      }
      if (directive.type === 'SET_TEXT_HANDLE') {
        if (directive.sensitive === true) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive text is user-only.' };
        }
        const target = findExactNode(snapshot, { kind: 'HANDLE', value: directive.handle });
        if (!target || target.editable !== true || !enabled(target)) {
          return { ok: false, code: 'NATIVE_TARGET_NOT_EDITABLE', message: 'Text target changed or is not editable.' };
        }
        if (sensitive(snapshot, target)) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive text is user-only.' };
        }
        return { ok: true };
      }
      if (directive.type === 'CLICK_HANDLE') {
        const target = findExactNode(snapshot, { kind: 'HANDLE', value: directive.handle });
        if (!target || target.clickable !== true || !enabled(target)) {
          return { ok: false, code: 'NATIVE_TARGET_NOT_CLICKABLE', message: 'Click target changed or is not clickable.' };
        }
        if (sensitive(snapshot, target)) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive native control is user-only.' };
        }
        if (isDangerous(snapshot, target)) {
          return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'Native action is outside the skill safety boundary.' };
        }
        return { ok: true };
      }
      if (directive.type === 'TAP_POINT') {
        const target = findExactNode(snapshot, directive.selector);
        if (!target) {
          return { ok: false, code: 'NATIVE_TARGET_NOT_FOUND', message: 'Semantic tap target changed before execution.' };
        }
        if (sensitive(snapshot, target)) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive native target is user-only.' };
        }
        if (isDangerous(snapshot, target)) {
          return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'Native tap target is outside the skill safety boundary.' };
        }
        const center = centerOfBounds(target);
        if (!center || center.x !== Number(directive.x) || center.y !== Number(directive.y)) {
          return { ok: false, code: 'NATIVE_TAP_TARGET_CHANGED', message: 'Semantic tap target moved before execution.' };
        }
        return { ok: true };
      }
      if (directive.type === 'SWIPE') return { ok: true };
      return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'Native skill emitted an unsupported directive.' };
    },

    async acceptResult({ directive, context }) {
      if (directive.type === 'LAUNCH') return true;
      if (Number.isInteger(directive.step_index) && directive.step_index === context.index) {
        context.index += 1;
      }
      return true;
    },
  });
}
