import { sanitizeVisibleUi } from '../visible-ui.js';
import { createNativeExactPlanSkill } from './exact-plan.js';

function stop(error_code, message) {
  return { type: 'STOP', error_code, message };
}

export function createNativeDiscoverablePlanSkill(options) {
  const base = createNativeExactPlanSkill(options);
  return Object.freeze({
    ...base,
    async next(args) {
      const { state, snapshot, context } = args;
      const step = context?.steps?.[context?.index];
      if (state === 'TARGET_APP' && step?.type === 'CAPTURE_VISIBLE_UI') {
        const key = String(step.key || '').trim();
        if (!key || key.length > 80) {
          return stop('SKILL_ACTION_NOT_ALLOWED', 'Capture key must be a non-empty string up to 80 characters.');
        }
        context.captures ||= {};
        context.captures[key] = sanitizeVisibleUi(snapshot);
        context.index += 1;
        return { type: 'OBSERVE' };
      }
      return base.next(args);
    },
  });
}
