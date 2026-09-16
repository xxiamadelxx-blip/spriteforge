import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserAdminProfileById,
  browserAdminProfileForHost,
  browserAdminProfileAllowsHost,
} from '../src/skills/browser/site-profiles.js';

test('browser admin site profiles resolve known infrastructure services with safe start URLs', () => {
  assert.deepEqual(browserAdminProfileById('codemagic'), {
    id: 'codemagic',
    domains: ['codemagic.io'],
    start_url: 'https://codemagic.io/apps',
  });
  assert.deepEqual(browserAdminProfileById('render'), {
    id: 'render',
    domains: ['render.com'],
    start_url: 'https://dashboard.render.com/',
  });
  assert.deepEqual(browserAdminProfileById('supabase'), {
    id: 'supabase',
    domains: ['supabase.com'],
    start_url: 'https://supabase.com/dashboard/projects',
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

test('every start URL remains inside its own approved service boundary', () => {
  for (const id of ['codemagic', 'gitlab', 'github', 'render', 'supabase', 'circleci', 'railway', 'vercel']) {
    const profile = browserAdminProfileById(id);
    assert.ok(profile?.start_url?.startsWith('https://'));
    assert.equal(browserAdminProfileAllowsHost(id, profile.start_url), true);
  }
});
