export const OPERA_PACKAGE = 'com.opera.browser';

export const BrowserAdminState = Object.freeze({
  OTHER_APP: 'OTHER_APP',
  BROWSER: 'BROWSER',
});

const AUTH_INPUT_PATTERN = /(?:password|passcode|pin|otp|2fa|verification code|security code|api[ _-]?token|access[ _-]?token|secret|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|токен|секрет)/iu;
const AUTH_CONTROL_PATTERN = /(?:password|passcode|pin|otp|2fa|two[- ]?factor|verification code|security code|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|(?:reveal|show|copy|create|generate|regenerate|rotate)\s+(?:api[ _-]?|access[ _-]?)?(?:token|key|secret)|(?:показать|открыть|скопировать|создать|сгенерировать|перевыпустить|ротировать)\s+(?:api[- ]?)?(?:токен|ключ|секрет))/iu;
const DANGEROUS_CLICK_PATTERN = /(?:delete|remove|revoke|rotate|billing|pay now|purchase|checkout|buy now|reset pairing|удал|отозв|ротац|оплат|купить|оформить заказ|сбросить pairing)/iu;
const ADDRESS_HINT_PATTERN = /(?:url|address|search|omnibox|адрес|поиск)/iu;
const GO_PATTERN = /^(?:go|open|enter|ok|перейти|открыть|ввод|ок)$/iu;
const OPERA_URL_FIELD_ID = 'com.opera.browser:id/url_field';
const OPERA_EDITABLE_URL_FIELD_ID = 'com.opera.browser:id/editable_url_field';
const OPERA_TOP_OMNIBAR_PLACEHOLDER_ID = 'com.opera.browser:id/top_omnibar_placeholder';
const MAX_CAPTURE_CHARS = 20_000;

function allNodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function nodeText(node) {
  return String(node?.text ?? node?.content_description ?? '').trim();
}

function nodeDescriptor(node) {
  return [
    node?.text,
    node?.content_description,
    node?.resource_id,
    node?.class_name,
  ].filter(Boolean).join(' ');
}

function enabled(node) {
  return node?.enabled !== false && typeof node?.handle === 'string' && node.handle.length > 0;
}

function containsBounds(parent, child) {
  const p = parent?.bounds;
  const c = child?.bounds;
  if (!p || !c) return false;
  return p.left <= c.left && p.top <= c.top && p.right >= c.right && p.bottom >= c.bottom;
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
  const parts = [nodeDescriptor(root)];
  for (const candidate of descendants(snapshot, root)) {
    parts.push(nodeDescriptor(candidate));
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

function findExactTextNode(snapshot, text) {
  const expected = String(text ?? '');
  return allNodes(snapshot).find((node) => (
    String(node?.text ?? '') === expected
    || String(node?.content_description ?? '') === expected
  )) || null;
}

function findClickableForNode(snapshot, target) {
  const nodes = allNodes(snapshot);
  const index = nodes.indexOf(target);
  return index < 0 ? null : clickableAncestor(nodes, index);
}

function viewport(snapshot) {
  const bounds = allNodes(snapshot)
    .map((node) => node?.bounds)
    .filter((value) => value && Number.isFinite(Number(value.right)) && Number.isFinite(Number(value.bottom)));
  const width = Math.max(1, ...bounds.map((value) => Number(value.right)));
  const height = Math.max(1, ...bounds.map((value) => Number(value.bottom)));
  return { width, height };
}

function safeScrollDirective(snapshot, stepIndex) {
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

function targetIsSensitiveInput(snapshot, node) {
  return node?.sensitive === true || AUTH_INPUT_PATTERN.test(semanticDescriptor(snapshot, node));
}

function targetIsSensitiveControl(snapshot, node) {
  return node?.sensitive === true || AUTH_CONTROL_PATTERN.test(semanticDescriptor(snapshot, node));
}

function targetIsDangerous(snapshot, node) {
  return DANGEROUS_CLICK_PATTERN.test(semanticDescriptor(snapshot, node));
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

function addressBar(snapshot) {
  const nodes = allNodes(snapshot);
  const editable = nodes.filter((node) => node?.editable === true && enabled(node) && node?.sensitive !== true);
  return editable.find((node) => node?.resource_id === OPERA_EDITABLE_URL_FIELD_ID)
    || editable.find((node) => node?.resource_id === OPERA_URL_FIELD_ID)
    || editable.find((node) => ADDRESS_HINT_PATTERN.test(nodeDescriptor(node)))
    || (editable.length === 1 ? editable[0] : null)
    || nodes.find((node) => node?.resource_id === OPERA_TOP_OMNIBAR_PLACEHOLDER_ID && node?.clickable === true && enabled(node) && node?.sensitive !== true)
    || null;
}

function goButton(snapshot) {
  const nodes = allNodes(snapshot);
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!GO_PATTERN.test(nodeText(node))) continue;
    const clickable = clickableAncestor(nodes, i);
    if (clickable) return clickable;
  }
  return null;
}

function primitiveBody(result) {
  if (!result || typeof result !== 'object') return {};
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : result;
}

export function createBrowserAdminRunPlanSkill() {
  return Object.freeze({
    id: 'browser.admin.run_plan',
    packages: [OPERA_PACKAGE],
    safety: { effect: 'configuration', risk: 'R2' },

    createContext({ inputs = {} } = {}) {
      return {
        domain: String(inputs.domain || ''),
        steps: Array.isArray(inputs.steps) ? inputs.steps.map((step) => ({ ...step })) : [],
        index: 0,
        navigation_phase: null,
        captures: {},
        wait_attempts: {},
      };
    },

    recognize(snapshot) {
      return snapshot?.package === OPERA_PACKAGE
        ? BrowserAdminState.BROWSER
        : BrowserAdminState.OTHER_APP;
    },

    async next({ state, snapshot, context }) {
      if (state === BrowserAdminState.OTHER_APP) {
        return { type: 'LAUNCH', package: OPERA_PACKAGE };
      }

      if (context.index >= context.steps.length) {
        return {
          type: 'COMPLETE',
          output: {
            domain: context.domain,
            completed_steps: context.index,
            captures: { ...context.captures },
          },
        };
      }

      const step = context.steps[context.index];
      const stepIndex = context.index;

      if (step.type === 'ASSERT_EXACT_TEXT') {
        if (!findExactTextNode(snapshot, step.text)) {
          return stop('BROWSER_ASSERTION_FAILED', `Expected exact text was not present: ${String(step.text || '')}`);
        }
        context.index += 1;
        return { type: 'OBSERVE' };
      }

      if (step.type === 'SCROLL_DOWN') {
        return safeScrollDirective(snapshot, stepIndex);
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
          return stop('BROWSER_WAIT_TIMEOUT', `Exact selector did not appear after ${maxAttempts} attempts.`);
        }
        return {
          type: 'WAIT',
          duration_ms: boundedInteger(step.poll_ms, 500, 50, 2_000),
          step_index: stepIndex,
        };
      }

      if (step.type === 'CAPTURE_EXACT_SELECTOR_TEXT') {
        const target = findExactNode(snapshot, step.selector);
        if (!target) return stop('BROWSER_TARGET_NOT_FOUND', 'Exact browser capture target was not found.');
        if (targetIsSensitiveInput(snapshot, target) || targetIsSensitiveControl(snapshot, target)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive browser content cannot be captured.');
        }
        const key = String(step.key || '').trim();
        if (!key || key.length > 80) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Capture key must be a non-empty string up to 80 characters.');
        }
        context.captures[key] = captureText(snapshot, target);
        context.index += 1;
        return { type: 'OBSERVE' };
      }

      if (step.type === 'CLICK_EXACT_TEXT') {
        const target = findExactTextNode(snapshot, step.text);
        if (!target) return stop('BROWSER_TARGET_NOT_FOUND', `Exact click text not found: ${String(step.text || '')}`);
        const clickable = findClickableForNode(snapshot, target);
        if (!clickable) return stop('BROWSER_TARGET_NOT_CLICKABLE', 'Matched browser target is not clickable.');
        if (targetIsSensitiveControl(snapshot, target) || targetIsSensitiveControl(snapshot, clickable)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive browser control is user-only.');
        }
        if (targetIsDangerous(snapshot, target) || targetIsDangerous(snapshot, clickable)) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Matched browser action is destructive, billing-related or payment-related.');
        }
        return { type: 'CLICK_HANDLE', handle: clickable.handle, step_index: stepIndex };
      }

      if (step.type === 'CLICK_EXACT_SELECTOR') {
        const target = findExactNode(snapshot, step.selector);
        if (!target) return stop('BROWSER_TARGET_NOT_FOUND', 'Exact click selector did not match the current screen.');
        const clickable = findClickableForNode(snapshot, target);
        if (!clickable) return stop('BROWSER_TARGET_NOT_CLICKABLE', 'Matched browser target is not clickable.');
        if (targetIsSensitiveControl(snapshot, target) || targetIsSensitiveControl(snapshot, clickable)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive browser control is user-only.');
        }
        if (targetIsDangerous(snapshot, target) || targetIsDangerous(snapshot, clickable)) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Matched browser action is destructive, billing-related or payment-related.');
        }
        return { type: 'CLICK_HANDLE', handle: clickable.handle, step_index: stepIndex };
      }

      if (step.type === 'SET_TEXT_EXACT_SELECTOR') {
        const target = findExactNode(snapshot, step.selector);
        if (!target) return stop('BROWSER_TARGET_NOT_FOUND', 'Exact text-entry selector did not match the current screen.');
        if (target.editable !== true || !enabled(target)) {
          return stop('BROWSER_TARGET_NOT_EDITABLE', 'Matched browser target is not editable.');
        }
        if (step.sensitive === true || targetIsSensitiveInput(snapshot, target)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive browser text entry is user-only.');
        }
        return {
          type: 'SET_TEXT_HANDLE',
          handle: target.handle,
          value: String(step.value ?? ''),
          sensitive: false,
          step_index: stepIndex,
        };
      }

      if (step.type === 'SET_TEXT_EXACT_LABEL') {
        const target = findExactTextNode(snapshot, step.label);
        if (!target) return stop('BROWSER_TARGET_NOT_FOUND', 'Exact text-entry label did not match the current screen.');
        if (target.editable !== true || !enabled(target)) {
          return stop('BROWSER_TARGET_NOT_EDITABLE', 'Matched browser label is not itself an editable field.');
        }
        if (step.sensitive === true || targetIsSensitiveInput(snapshot, target)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive browser text entry is user-only.');
        }
        return {
          type: 'SET_TEXT_HANDLE',
          handle: target.handle,
          value: String(step.value ?? ''),
          sensitive: false,
          step_index: stepIndex,
        };
      }

      if (step.type === 'NAVIGATE_URL') {
        if (context.navigation_phase === 'submit') {
          const go = goButton(snapshot);
          if (!go) {
            return stop('BROWSER_NAVIGATION_SUBMIT_NOT_FOUND', 'Browser navigation submit control was not semantically available.');
          }
          if (targetIsSensitiveControl(snapshot, go) || targetIsDangerous(snapshot, go)) {
            return stop('SKILL_ACTION_NOT_ALLOWED', 'Browser navigation submit control failed safety validation.');
          }
          return { type: 'CLICK_HANDLE', handle: go.handle, step_index: stepIndex, navigation_submit: true };
        }

        const bar = addressBar(snapshot);
        if (!bar) {
          return stop('BROWSER_ADDRESS_BAR_NOT_FOUND', 'Opera address bar was not semantically available.');
        }
        if (targetIsSensitiveInput(snapshot, bar)) {
          return stop('USER_AUTH_REQUIRED', 'Sensitive browser text entry is user-only.');
        }

        if (context.navigation_phase === 'enter') {
          if (bar.editable !== true) {
            return stop('BROWSER_TARGET_NOT_EDITABLE', 'Opera focused address bar was not editable after focus.');
          }
          return {
            type: 'SET_TEXT_HANDLE',
            handle: bar.handle,
            value: String(step.url || ''),
            sensitive: false,
            step_index: stepIndex,
            navigation_enter: true,
          };
        }

        if (bar.clickable !== true) {
          return stop('BROWSER_ADDRESS_BAR_NOT_CLICKABLE', 'Opera address bar must be focused before URL entry.');
        }
        return {
          type: 'CLICK_HANDLE',
          handle: bar.handle,
          step_index: stepIndex,
          navigation_focus: true,
        };
      }

      return stop('SKILL_ACTION_NOT_ALLOWED', `Unsupported browser plan step: ${String(step.type || '')}`);
    },

    async validateDirective({ snapshot, directive }) {
      if (directive.type === 'LAUNCH') {
        return directive.package === OPERA_PACKAGE
          ? { ok: true }
          : { ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'Browser skill may launch Opera only.' };
      }
      if (directive.type === 'SET_TEXT_HANDLE') {
        if (directive.sensitive === true) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive text is user-only.' };
        }
        const target = findExactNode(snapshot, { kind: 'HANDLE', value: directive.handle });
        if (!target || target.editable !== true || !enabled(target)) {
          return { ok: false, code: 'BROWSER_TARGET_NOT_EDITABLE', message: 'Text target changed or is not editable.' };
        }
        if (targetIsSensitiveInput(snapshot, target)) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive browser text entry is user-only.' };
        }
        return { ok: true };
      }
      if (directive.type === 'CLICK_HANDLE') {
        const target = findExactNode(snapshot, { kind: 'HANDLE', value: directive.handle });
        if (!target || target.clickable !== true || !enabled(target)) {
          return { ok: false, code: 'BROWSER_TARGET_NOT_CLICKABLE', message: 'Click target changed or is not clickable.' };
        }
        if (targetIsSensitiveControl(snapshot, target)) {
          return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Sensitive browser control is user-only.' };
        }
        if (targetIsDangerous(snapshot, target)) {
          return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'Dangerous browser action is blocked.' };
        }
        return { ok: true };
      }
      if (directive.type === 'SWIPE') return { ok: true };
      return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'Browser skill emitted an unsupported directive.' };
    },

    async acceptResult({ directive, primitiveResult, context }) {
      if (directive.type === 'LAUNCH') return true;
      if (directive.navigation_focus === true) {
        context.navigation_phase = 'enter';
        const body = primitiveBody(primitiveResult);
        if (body?.error_code === 'ACTION_NOT_VERIFIED') {
          return { handled_error: true };
        }
        return true;
      }
      if (directive.navigation_enter === true) {
        context.navigation_phase = 'submit';
        return true;
      }
      if (directive.navigation_submit === true) {
        context.navigation_phase = null;
        context.index += 1;
        return true;
      }
      if (Number.isInteger(directive.step_index) && directive.step_index === context.index) {
        context.index += 1;
      }
      return true;
    },
  });
}
