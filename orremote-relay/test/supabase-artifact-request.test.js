import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCommandBus } from '../src/supabase-command-bus.js';

function configured() {
  return {
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    orremoteBusSecret: 's'.repeat(48),
    orremoteBusPollMs: 1000,
    publicOrigin: 'https://relay.test',
  };
}

function fakeFetch(sequence, calls) {
  return async (url, options = {}) => {
    const rpc = String(url).split('/rpc/')[1] || '';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ rpc, body });
    const next = sequence.shift();
    if (!next) throw new Error(`unexpected RPC ${rpc}`);
    assert.equal(rpc, next.rpc);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
}

test('artifact queue resolves current pair internally and returns only safe staged metadata', async () => {
  const calls = [];
  const requestId = '11111111-1111-4111-8111-111111111111';
  const artifactId = '22222222-2222-4222-8222-222222222222';
  const pairId = 'pair-generation-must-not-leak';
  const fetchImpl = fakeFetch([
    { rpc: 'orremote_claim_artifact', body: [{ request_id: requestId, device_id: 'a'.repeat(24), pair_id: pairId, artifact_id: artifactId }] },
    { rpc: 'orremote_complete_artifact', body: true },
  ], calls);
  const bus = createSupabaseCommandBus({
    config: configured(), fetchImpl,
    deviceRelay: {
      async requestArtifact(request) {
        assert.equal(request.pairId, pairId);
        return {
          artifactId, mimeType: 'image/png', byteSize: 1234, sha256: 'a'.repeat(64),
          expiresAt: Date.parse('2026-09-15T12:00:00Z'), downloadToken: 'signed.token',
        };
      },
    },
  });

  assert.equal(await bus.processArtifactOnce(), 'completed');
  const complete = calls.find((call) => call.rpc === 'orremote_complete_artifact');
  assert.equal(complete.body.p_request_id, requestId);
  assert.equal(complete.body.p_result.artifact_id, artifactId);
  assert.equal(complete.body.p_result.download_url, 'https://relay.test/artifacts/signed.token');
  assert.equal(JSON.stringify(complete.body.p_result).includes(pairId), false);
});

test('artifact transport failure is completed as one failed request without replay', async () => {
  const calls = [];
  let attempts = 0;
  const fetchImpl = fakeFetch([
    { rpc: 'orremote_claim_artifact', body: [{ request_id: '33333333-3333-4333-8333-333333333333', device_id: 'b'.repeat(24), pair_id: 'pair-current', artifact_id: '44444444-4444-4444-8444-444444444444' }] },
    { rpc: 'orremote_fail_artifact', body: true },
    { rpc: 'orremote_claim_artifact', body: [] },
  ], calls);
  const bus = createSupabaseCommandBus({
    config: configured(), fetchImpl,
    deviceRelay: {
      async requestArtifact() {
        attempts += 1;
        const error = new Error('ARTIFACT_NOT_FOUND'); error.code = 'ARTIFACT_NOT_FOUND'; throw error;
      },
    },
  });

  assert.equal(await bus.processArtifactOnce(), 'failed');
  assert.equal(await bus.processArtifactOnce(), 'idle');
  assert.equal(attempts, 1);
  const failed = calls.find((call) => call.rpc === 'orremote_fail_artifact');
  assert.deepEqual(failed.body.p_error, { code: 'ARTIFACT_NOT_FOUND', message: 'ARTIFACT_NOT_FOUND' });
});
