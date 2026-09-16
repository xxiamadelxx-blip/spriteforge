import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';

const skill = createBrowserAdminRunPlanSkill();

function authorize(inputs) {
  return createDefaultSkillSafetyPolicy({ panicSwitch: () => false })
    .authorizeSkill(skill, { inputs });
}

test('Codemagic profile authorizes navigation inside Codemagic without a raw domain input', () => {
  assert.deepEqual(authorize({
    site: 'codemagic',
    steps: [{ type: 'NAVIGATE_URL', url: 'https://codemagic.io/apps' }],
  }), { ok: true });
});

test('Codemagic profile cannot laterally navigate to another globally approved admin service', () => {
  const result = authorize({
    site: 'codemagic',
    steps: [{ type: 'NAVIGATE_URL', url: 'https://gitlab.com/projects' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_DOMAIN_NOT_ALLOWED');
});

test('unknown browser admin site profile fails closed before device execution', () => {
  const result = authorize({ site: 'unknown', steps: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SKILL_SITE_NOT_ALLOWED');
});
