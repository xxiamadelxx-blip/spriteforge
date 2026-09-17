import { sanitizeVisibleUi } from '../visible-ui.js';
import { createBrowserAdminRunPlanSkill } from './admin-run-plan.js';
import { normalizeBrowserAdminExecutionInputs } from './policy-inputs.js';

const OPERA_TOP_OMNIBAR_PLACEHOLDER_ID = 'com.opera.browser:id/top_omnibar_placeholder';
const OPERA_EDITABLE_URL_FIELD_ID = 'com.opera.browser:id/editable_url_field';

function stop(error_code, message) {
  return { type: 'STOP', error_code, message };
}

function primitiveBody(result) {
  if (!result || typeof result !== 'object') return {};
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : result;
}

function normalizeOperaStartPageSnapshot(snapshot) {
  if (snapshot?.package !== 'com.opera.browser' || !Array.isArray(snapshot?.nodes)) return snapshot;
  let changed = false;
  const nodes = snapshot.nodes.map((node) => {
    if (
      node?.resource_id !== OPERA_TOP_OMNIBAR_PLACEHOLDER_ID
      || node?.editable === true
      || node?.sensitive === true
    ) {
      return node;
    }
    changed = true;
    return { ...node, editable: true };
  });
  return changed ? { ...snapshot, nodes } : snapshot;
}

function editableUrlField(snapshot) {
  if (snapshot?.package !== 'com.opera.browser' || !Array.isArray(snapshot?.nodes)) return null;
  return snapshot.nodes.find((node) => (
    node?.resource_id === OPERA_EDITABLE_URL_FIELD_ID
    && node?.editable === true
    && node?.enabled !== false
    && node?.sensitive !== true
  )) || null;
}

function visibleNodeText(node) {
  return String(node?.text ?? node?.content_description ?? '').trim();
}

export function createBrowserAdminSkill() {
  const base = createBrowserAdminRunPlanSkill();
  return Object.freeze({
    ...base,
    createContext(args = {}) {
      return base.createContext({
        ...args,
        inputs: normalizeBrowserAdminExecutionInputs(args.inputs || {}),
      });
    },
    async next(args) {
      const { state, snapshot, context } = args;
      const step = context?.steps?.[context?.index];
      if (state === 'BROWSER' && step?.type === 'CAPTURE_VISIBLE_UI') {
        const key = String(step.key || '').trim();
        if (!key || key.length > 80) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Capture key must be a non-empty string up to 80 characters.');
        }
        context.captures ||= {};
        context.captures[key] = sanitizeVisibleUi(snapshot);
        context.index += 1;
        return { type: 'OBSERVE' };
      }
      if (
        state === 'BROWSER'
        && step?.type === 'NAVIGATE_URL'
        && context?.navigation_phase === 'verify_enter'
      ) {
        const field = editableUrlField(snapshot);
        const expected = String(step.url || '').trim();
        if (!field || visibleNodeText(field) !== expected) {
          return stop(
            'BROWSER_NAVIGATION_TEXT_NOT_VERIFIED',
            'Opera URL entry was not semantically verified after the delayed set-text result.',
          );
        }
        context.navigation_phase = 'submit';
        return { type: 'OBSERVE' };
      }
      return base.next({ ...args, snapshot: normalizeOperaStartPageSnapshot(snapshot) });
    },
    async acceptResult(args) {
      const { directive, primitiveResult, context } = args;
      if (directive?.navigation_enter === true) {
        const body = primitiveBody(primitiveResult);
        if (body?.error_code === 'ACTION_NOT_VERIFIED') {
          context.navigation_phase = 'verify_enter';
          return { handled_error: true };
        }
      }
      return base.acceptResult(args);
    },
  });
}
