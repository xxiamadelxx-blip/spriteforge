import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserAdminPolicyInputs } from '../src/skills/browser/policy-inputs.js';

test('browser site-home step is normalized to the selected profile URL for base safety policy', () => {
  assert.deepEqual(
    normalizeBrowserAdminPolicyInputs({
      site: 'render',
      domain: 'render.com',
      steps: [{ type: 'NAVIGATE_SITE_HOME' }, { type: 'ASSERT_EXACT_TEXT', text: 'Services' }],
    }),
    {
      site: 'render',
      domain: 'render.com',
      steps: [
        { type: 'NAVIGATE_URL', url: 'https://dashboard.render.com/' },
        { type: 'ASSERT_EXACT_TEXT', text: 'Services' },
      ],
    },
  );
});

test('unknown site-home step remains fail-closed for base policy', () => {
  const normalized = normalizeBrowserAdminPolicyInputs({
    site: 'unknown',
    domain: 'example.com',
    steps: [{ type: 'NAVIGATE_SITE_HOME' }],
  });
  assert.equal(normalized.steps[0].type, 'NAVIGATE_URL');
  assert.equal(normalized.steps[0].url, '');
});
