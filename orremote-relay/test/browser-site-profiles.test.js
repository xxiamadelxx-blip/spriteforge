import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserAdminProfileById,
  browserAdminProfileForHost,
  browserAdminProfileAllowsHost,
} from '../src/skills/browser/site-profiles.js';

test('browser admin site profiles resolve known infrastructure services', () => {
  assert.deepEqual(browserAdminProfileById('codemagic'), {
    id: 'codemagic',
    domains: ['codemagic.io'],
  });
  assert.deepEqual(browserAdminProfileById('render'), {
    id: 'render',
    domains: ['render.com'],
  });
  assert.equal(browserAdminProfileById('unknown'), null);
});

test('profile host matching is scoped to one service and supports subdomains', () => {
  assert.equal(browserAdminProfileAllowsHost('codemagic', 'codemagic.io'), true);
  assert.equal(browserAdminProfileAllowsHost('codemagic', 'api.codemagic.io'), true);
  assert.equal(browserAdminProfileAllowsHost('codemagic', 'gitlab.com'), false);
  assert.equal(browserAdminProfileAllowsHost('render', 'dashboard.render.com'), true);
  assert.equal(browserAdminProfileAllowsHost('unknown', 'render.com'), false);
});

test('profile can be inferred from a current host without crossing service boundaries', () => {
  assert.equal(browserAdminProfileForHost('app.circleci.com')?.id, 'circleci');
  assert.equal(browserAdminProfileForHost('dashboard.render.com')?.id, 'render');
  assert.equal(browserAdminProfileForHost('example.com'), null);
});
