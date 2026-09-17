import { sanitizeVisibleUi } from '../visible-ui.js';
import { createBrowserAdminRunPlanSkill } from './admin-run-plan.js';
import { normalizeBrowserAdminExecutionInputs } from './policy-inputs.js';

const OPERA_TOP_OMNIBAR_PLACEHOLDER_ID = 'com.opera.browser:id/top_omnibar_placeholder';

function stop(error_code, message) {
  return { type: 'STOP', error_code, message };
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
      return base.next({ ...args, snapshot: normalizeOperaStartPageSnapshot(snapshot) });
    },
  });
}
