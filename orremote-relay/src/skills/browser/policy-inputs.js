import { browserAdminProfileById } from './site-profiles.js';

export function normalizeBrowserAdminPolicyInputs(inputs = {}) {
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
