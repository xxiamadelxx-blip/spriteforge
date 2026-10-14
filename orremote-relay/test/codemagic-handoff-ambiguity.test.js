import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCommandBus } from '../src/supabase-command-bus.js';

const REQUEST_ID = '996ca91f-d90a-4e51-9594-fac5b3ab6233';
const SHA = 'e'.repeat(40);
const TAG_REF = 'refs/tags/orremote/android/' + REQUEST_ID;
const CM = 'https://api.codemagic.io/builds';
const config = (release = false) => ({
  supabaseUrl: 'https://supabase.invalid',
  supabasePublishableKey: 'test-publishable',
  orremoteBusSecret: 'fixture-only',
  codemagicApiToken: 'fixture-only',
  codemagicAppId: 'fixture-app',
  codemagicWorkflowId: 'android-m1',
  releaseSourceRepo: 'xxiamadelxx-blip/-remote',
  releaseGithubToken: release ? 'fixture-github' : '',
});
const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });
const downstreamLost = () => { const e = new Error('network response lost AFTER commit'); e.code = 'SUPABASE_BUS_RPC_TIMEOUT'; throw e; };

test('CI accepted build with lost handoff acknowledgement is never marked failed', async () => {
  let postCount = 0, failedCount = 0, startCount = 0;
  const bus = createSupabaseCommandBus({
    config: config(),
    deviceRelay: {},
    fetchImpl: async (url) => {
      if (url.endsWith('/rpc/orremote_claim_ci_request')) return ok([{ request_id: REQUEST_ID, branch: 'ci/android-build', workflow_id: 'android-m1', expected_commit: SHA }]);
      if (url === CM) { postCount++; return ok({ buildId: 'build-accepted' }); }
      if (url.endsWith('/rpc/orremote_start_ci_request')) { startCount++; return downstreamLost(); }
      if (url.endsWith('/rpc/orremote_fail_ci_request')) { failedCount++; return ok(true); }
      throw Error('unexpected ' + url);
    },
  });
  assert.equal(await bus.processCiOnce(), 'handoff_ambiguous');
  assert.equal(postCount, 1);
  assert.equal(startCount, 1);
  assert.equal(failedCount, 0, 'ambiguous successful external build MUST NOT be marked as failed');
});

test('release accepted build with lost handoff acknowledgement is never marked failed', async () => {
  let postCount = 0, failedCount = 0, startCount = 0;
  const bus = createSupabaseCommandBus({
    config: config(true),
    deviceRelay: {},
    fetchImpl: async (url) => {
      if (url.endsWith('/rpc/orremote_claim_release_build_request')) return ok([{ request_id: REQUEST_ID, source_repo: 'xxiamadelxx-blip/-remote', source_sha: SHA, tag_ref: TAG_REF, workflow_id: 'android-m1' }]);
      if (url.endsWith('/git/refs')) return ok({ object: { sha: SHA } });
      if (url.includes('/git/ref/')) return ok({ object: { type: 'commit', sha: SHA } });
      if (url === CM) { postCount++; return ok({ buildId: 'build-accepted' }); }
      if (url.endsWith('/rpc/orremote_start_release_build_request')) { startCount++; return downstreamLost(); }
      if (url.endsWith('/rpc/orremote_fail_release_build_request')) { failedCount++; return ok(true); }
      throw Error('unexpected ' + url);
    },
  });
  assert.equal(await bus.processReleaseBuildOnce(), 'handoff_ambiguous');
  assert.equal(postCount, 1);
  assert.equal(startCount, 1);
  assert.equal(failedCount, 0, 'ambiguous successful external build MUST NOT be marked as failed');
});
