import { browserAdminProfileById } from './site-profiles.js';

export function normalizeBrowserAdminExecutionInputs(inputs = {}) {
  const site = String(inputs.site || '').trim().toLowerCase();
  const profile = browserAdminProfileById(site);
  const steps = Array.isArray(inputs.steps) ? inputs.steps : [];
  return {
    ...inputs,
    site,
    steps: steps.map((step) => (
      step?.type === 'NAVIGATE_SITE_HOME'
        ? { ...step, type: 'NAVIGATE_URL', url: profile?.start_url || '' }
        : { ...step }
    )),
  };
}

export function normalizeBrowserAdminPolicyInputs(inputs = {}) {
  const normalized = normalizeBrowserAdminExecutionInputs(inputs);
  return {
    ...normalized,
    steps: normalized.steps.map((step) => (
      step?.type === 'CAPTURE_VISIBLE_UI'
        ? { type: 'ASSERT_EXACT_TEXT', text: '__orremote_safe_visible_ui_capture__' }
        : { ...step }
    )),
  };
}
