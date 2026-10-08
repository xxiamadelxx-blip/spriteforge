import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCommandBus } from '../src/supabase-command-bus.js';

function config(overrides = {}) {
  return {
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    orremoteBusSecret: 's'.repeat(48),
    orremoteBusPollMs: 1000,
    codemagicApiToken: 'cm-secret-token',
    codemagicAppId: '6aa6542caf15c45faf8dbe96',
    codemagicWorkflowId: 'android-m1',
    releaseGithubToken: '',
    releaseSourceRepo: 'xxiamadelxx-blip/-remote',
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('CI queue stays disabled and does not claim when Codemagic token is absent', async () => {
  let fetched = false;
  const bus = createSupabaseCommandBus({
    config: config({ codemagicApiToken: '' }),
    deviceRelay: {},
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });

  assert.equal(await bus.processCiOnce(), 'disabled');
  assert.equal(fetched, false);
});

test('CI queue starts the allowed Codemagic workflow and records the build id', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const textUrl = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: textUrl, headers: options.headers || {}, body });

    if (textUrl.endsWith('/rpc/orremote_claim_ci_request')) {
      return jsonResponse([{
        request_id: '11111111-1111-4111-8111-111111111111',
        branch: 'ci/android-build',
        workflow_id: 'android-m1',
        expected_commit: 'abc123',
      }]);
    }
    if (textUrl === 'https://api.codemagic.io/builds') {
      assert.equal(options.headers['x-auth-token'], 'cm-secret-token');
      assert.deepEqual(body, {
        appId: '6aa6542caf15c45faf8dbe96',
        workflowId: 'android-m1',
        branch: 'ci/android-build',
        labels: ['orremote-ci-queue', 'commit:abc123'],
      });
      return jsonResponse({ buildId: 'cm-build-123' });
    }
    if (textUrl.endsWith('/rpc/orremote_start_ci_request')) {
      assert.equal(body.p_request_id, '11111111-1111-4111-8111-111111111111');
      assert.equal(body.p_build_id, 'cm-build-123');
      assert.equal(typeof body.p_bus_secret, 'string');
      return jsonResponse(true);
    }
    throw new Error(`unexpected fetch ${textUrl}`);
  };

  const bus = createSupabaseCommandBus({ config: config(), deviceRelay: {}, fetchImpl });
  assert.equal(await bus.processCiOnce(), 'started');
  assert.equal(calls.filter((call) => call.url === 'https://api.codemagic.io/builds').length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/rpc/orremote_start_ci_request')).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/rpc/orremote_fail_ci_request')).length, 0);
});

test('CI queue rejects a non-gate branch before contacting Codemagic', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const textUrl = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: textUrl, body });
    if (textUrl.endsWith('/rpc/orremote_claim_ci_request')) {
      return jsonResponse([{
        request_id: '22222222-2222-4222-8222-222222222222',
        branch: 'main',
        workflow_id: 'android-m1',
        expected_commit: 'bad-branch',
      }]);
    }
    if (textUrl.endsWith('/rpc/orremote_fail_ci_request')) {
      assert.equal(body.p_request_id, '22222222-2222-4222-8222-222222222222');
      assert.equal(body.p_error.code, 'CODEMAGIC_BRANCH_NOT_ALLOWED');
      return jsonResponse(true);
    }
    if (textUrl === 'https://api.codemagic.io/builds') {
      throw new Error('Codemagic must not be contacted for a rejected branch');
    }
    throw new Error(`unexpected fetch ${textUrl}`);
  };

  const bus = createSupabaseCommandBus({ config: config(), deviceRelay: {}, fetchImpl });
  assert.equal(await bus.processCiOnce(), 'failed');
  assert.equal(calls.filter((call) => call.url === 'https://api.codemagic.io/builds').length, 0);
});

test('CI queue rejects an unexpected workflow before contacting Codemagic', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const textUrl = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: textUrl, body });
    if (textUrl.endsWith('/rpc/orremote_claim_ci_request')) {
      return jsonResponse([{
        request_id: '33333333-3333-4333-8333-333333333333',
        branch: 'ci/android-build',
        workflow_id: 'release',
        expected_commit: 'bad-workflow',
      }]);
    }
    if (textUrl.endsWith('/rpc/orremote_fail_ci_request')) {
      assert.equal(body.p_request_id, '33333333-3333-4333-8333-333333333333');
      assert.equal(body.p_error.code, 'CODEMAGIC_WORKFLOW_NOT_ALLOWED');
      return jsonResponse(true);
    }
    if (textUrl === 'https://api.codemagic.io/builds') {
      throw new Error('Codemagic must not be contacted for a rejected workflow');
    }
    throw new Error(`unexpected fetch ${textUrl}`);
  };

  const bus = createSupabaseCommandBus({ config: config(), deviceRelay: {}, fetchImpl });
  assert.equal(await bus.processCiOnce(), 'failed');
  assert.equal(calls.filter((call) => call.url === 'https://api.codemagic.io/builds').length, 0);
});

test('release queue stays disabled without its separate GitHub release credential', async () => {
  let fetched = false;
  const bus = createSupabaseCommandBus({
    config: config(),
    deviceRelay: {},
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assert.equal(await bus.processReleaseBuildOnce(), 'disabled');
  assert.equal(fetched, false);
});

test('release queue creates and verifies one immutable tag, then starts Codemagic by tag only', async () => {
  const calls = [];
  const requestId = '11111111-1111-4111-8111-111111111111';
  const sourceSha = 'a'.repeat(40);
  const tagRef = `refs/tags/orremote/android/${requestId}`;
  const tagName = `orremote/android/${requestId}`;
  const fetchImpl = async (url, options = {}) => {
    const textUrl = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: textUrl, headers: options.headers || {}, body });
    if (textUrl.endsWith('/rpc/orremote_claim_release_build_request')) {
      return jsonResponse([{ request_id: requestId, source_repo: 'xxiamadelxx-blip/-remote', source_sha: sourceSha, tag_ref: tagRef, workflow_id: 'android-m1' }]);
    }
    if (textUrl === 'https://api.github.com/repos/xxiamadelxx-blip/-remote/git/refs') {
      assert.equal(options.headers.authorization, 'Bearer gh-release-token');
      assert.deepEqual(body, { ref: tagRef, sha: sourceSha });
      return jsonResponse({ ref: tagRef, object: { type: 'commit', sha: sourceSha } }, 201);
    }
    if (textUrl === `https://api.github.com/repos/xxiamadelxx-blip/-remote/git/ref/${encodeURIComponent(`tags/${tagName}`)}`) {
      return jsonResponse({ ref: tagRef, object: { type: 'commit', sha: sourceSha } });
    }
    if (textUrl === 'https://api.codemagic.io/builds') {
      assert.deepEqual(body, {
        appId: '6aa6542caf15c45faf8dbe96', workflowId: 'android-m1', tag: tagName,
        environment: { variables: { ORREMOTE_EXPECTED_COMMIT: sourceSha, ORREMOTE_RELEASE_REQUEST_ID: requestId, ORREMOTE_RELEASE_TAG: tagName } },
        labels: ['orremote-release', `request:${requestId}`, `commit:${sourceSha}`, `tag:${tagName}`],
      });
      assert.equal('branch' in body, false);
      return jsonResponse({ buildId: 'cm-release-123' });
    }
    if (textUrl.endsWith('/rpc/orremote_start_release_build_request')) {
      assert.deepEqual(body, { p_bus_secret: 's'.repeat(48), p_request_id: requestId, p_build_id: 'cm-release-123', p_source_sha: sourceSha, p_tag_ref: tagRef });
      return jsonResponse(true);
    }
    throw new Error(`unexpected fetch ${textUrl}`);
  };
  const bus = createSupabaseCommandBus({ config: config({ releaseGithubToken: 'gh-release-token' }), deviceRelay: {}, fetchImpl });
  assert.equal(await bus.processReleaseBuildOnce(), 'started');
  assert.equal(calls.filter((call) => call.url === 'https://api.codemagic.io/builds').length, 1);
  assert.equal(calls.some((call) => call.url.endsWith('/rpc/orremote_fail_release_build_request')), false);
});

test('release queue fails closed when an existing tag resolves to a different commit', async () => {
  const calls = [];
  const requestId = '22222222-2222-4222-8222-222222222222';
  const sourceSha = 'b'.repeat(40);
  const tagRef = `refs/tags/orremote/android/${requestId}`;
  const fetchImpl = async (url, options = {}) => {
    const textUrl = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: textUrl, body });
    if (textUrl.endsWith('/rpc/orremote_claim_release_build_request')) return jsonResponse([{ request_id: requestId, source_repo: 'xxiamadelxx-blip/-remote', source_sha: sourceSha, tag_ref: tagRef, workflow_id: 'android-m1' }]);
    if (textUrl.endsWith('/git/refs')) return jsonResponse({ message: 'Reference already exists' }, 422);
    if (textUrl.includes('/git/ref/')) return jsonResponse({ object: { type: 'commit', sha: 'c'.repeat(40) } });
    if (textUrl.endsWith('/rpc/orremote_fail_release_build_request')) {
      assert.equal(body.p_error.code, 'RELEASE_TAG_TARGET_MISMATCH'); return jsonResponse(true);
    }
    if (textUrl === 'https://api.codemagic.io/builds') throw new Error('must not enqueue mismatched tag');
    throw new Error(`unexpected fetch ${textUrl}`);
  };
  const bus = createSupabaseCommandBus({ config: config({ releaseGithubToken: 'gh-release-token' }), deviceRelay: {}, fetchImpl });
  assert.equal(await bus.processReleaseBuildOnce(), 'failed');
  assert.equal(calls.filter((call) => call.url === 'https://api.codemagic.io/builds').length, 0);
});

test('ambiguous Codemagic POST is recorded once and never retried by the worker', async () => {
  const calls = []; let claimed = false;
  const requestId = '33333333-3333-4333-8333-333333333333';
  const sourceSha = 'd'.repeat(40); const tagRef = `refs/tags/orremote/android/${requestId}`;
  const fetchImpl = async (url, options = {}) => {
    const textUrl = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: textUrl, body });
    if (textUrl.endsWith('/rpc/orremote_claim_release_build_request')) {
      if (claimed) return jsonResponse([]); claimed = true;
      return jsonResponse([{ request_id: requestId, source_repo: 'xxiamadelxx-blip/-remote', source_sha: sourceSha, tag_ref: tagRef, workflow_id: 'android-m1' }]);
    }
    if (textUrl.endsWith('/git/refs')) return jsonResponse({}, 201);
    if (textUrl.includes('/git/ref/')) return jsonResponse({ object: { type: 'commit', sha: sourceSha } });
    if (textUrl === 'https://api.codemagic.io/builds') throw new Error('connection dropped after request write');
    if (textUrl.endsWith('/rpc/orremote_fail_release_build_request')) {
      assert.equal(body.p_error.code, 'CODEMAGIC_BUILD_POST_AMBIGUOUS'); return jsonResponse(true);
    }
    throw new Error(`unexpected fetch ${textUrl}`);
  };
  const bus = createSupabaseCommandBus({ config: config({ releaseGithubToken: 'gh-release-token' }), deviceRelay: {}, fetchImpl });
  assert.equal(await bus.processReleaseBuildOnce(), 'failed');
  assert.equal(await bus.processReleaseBuildOnce(), 'idle');
  assert.equal(calls.filter((call) => call.url === 'https://api.codemagic.io/builds').length, 1);
});
