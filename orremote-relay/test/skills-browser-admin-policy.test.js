import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';

function browserSkill() {
  return {
    id: 'browser.admin.run_plan',
    packages: ['com.opera.browser'],
    safety: { effect: 'configuration', risk: 'R2' },
  };
}

test('approved browser admin skill accepts allowlisted non-secret configuration plan', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const result = policy.authorizeSkill(browserSkill(), {
    inputs: {
      domain: 'codemagic.io',
      steps: [
        { type: 'CLICK_EXACT_TEXT', text: 'Builds' },
        { type: 'SET_TEXT_EXACT_LABEL', label: 'Branch', value: 'ci/android-build', sensitive: false },
      ],
    },
  });
  assert.equal(result.ok, true);
});

test('browser admin rejects domains outside the external allowlist', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const result = policy.authorizeSkill(browserSkill(), {
    inputs: { domain: 'example.invalid', steps: [] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_DOMAIN_NOT_ALLOWED');
});

test('browser admin rejects secret values and auth-like fields', () => {
  const policy = createDefaultSkillSafetyPolicy();
  for (const step of [
    { type: 'SET_TEXT_EXACT_LABEL', label: 'API token', value: 'secret', sensitive: true },
    { type: 'SET_TEXT_EXACT_LABEL', label: 'Password', value: 'secret', sensitive: false },
    { type: 'SET_TEXT_EXACT_LABEL', label: 'OTP', value: '123456', sensitive: false },
  ]) {
    const result = policy.authorizeSkill(browserSkill(), {
      inputs: { domain: 'codemagic.io', steps: [step] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'USER_AUTH_REQUIRED');
  }
});

test('browser admin rejects destructive or billing click targets', () => {
  const policy = createDefaultSkillSafetyPolicy();
  for (const text of ['Delete project', 'Remove repository', 'Revoke token', 'Billing', 'Pay now']) {
    const result = policy.authorizeSkill(browserSkill(), {
      inputs: { domain: 'gitlab.com', steps: [{ type: 'CLICK_EXACT_TEXT', text }] },
    });
    assert.equal(result.ok, false, text);
    assert.equal(result.code, 'SKILL_ACTION_NOT_ALLOWED');
  }
});


test('browser admin policy allows bounded browser back step', () => {
  const policy = createDefaultSkillSafetyPolicy();
  const result = policy.authorizeSkill(browserSkill(), {
    inputs: {
      domain: 'github.com',
      steps: [{ type: 'BROWSER_BACK' }],
    },
  });
  assert.equal(result.ok, true);
});
