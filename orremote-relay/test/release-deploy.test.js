import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseDeployError, createReleaseDeployController } from '../src/release-deploy.js';

const mirrorSha = 'a'.repeat(40), sourceSha = 'b'.repeat(40), manifestSha256 = 'c'.repeat(64);
function controller(overrides = {}) {
  const calls = { cas: 0, create: 0 };
  return { calls, controller: createReleaseDeployController({
    render: { async createDeploy({ commitId }) { calls.create += 1; return { id: 'dep-1', commitId }; }, async getDeploy() { return { status: 'live', commitId: mirrorSha }; } },
    async readHealth() { return { ok: true, relay_source_sha: sourceSha, build_manifest_hash: manifestSha256 }; },
    async getRunningPointer() { return { revision: 7 }; },
    async compareAndSwapRunningPointer(input) { calls.cas += 1; assert.equal(input.expectedRevision, 7); return true; },
    ...overrides,
  })};
}

test('exact-commit LIVE deployment advances running pointer only after matching health identity', async () => {
  const { controller: subject, calls } = controller();
  const result = await subject.deploy({ mirrorSha, sourceSha, manifestSha256, releaseId: 'release-1', reason: 'approved deploy' });
  assert.equal(result.deployId, 'dep-1'); assert.equal(calls.create, 1); assert.equal(calls.cas, 1);
});

test('deploy mismatch, non-LIVE result or ambiguous POST never advances running pointer', async () => {
  const mismatch = controller({ render: { async createDeploy() { return { id: 'dep-1' }; }, async getDeploy() { return { status: 'live', commitId: 'd'.repeat(40) }; } } });
  await assert.rejects(() => mismatch.controller.deploy({ mirrorSha, sourceSha, manifestSha256, releaseId: 'release-1', reason: 'approved deploy' }), (e) => e instanceof ReleaseDeployError && e.code === 'RENDER_DEPLOY_COMMIT_MISMATCH');
  assert.equal(mismatch.calls.cas, 0);
  const unhealthy = controller({ async readHealth() { return { ok: true, relay_source_sha: sourceSha, build_manifest_hash: 'd'.repeat(64) }; } });
  await assert.rejects(() => unhealthy.controller.deploy({ mirrorSha, sourceSha, manifestSha256, releaseId: 'release-1', reason: 'approved deploy' }), /RELAY_HEALTH_IDENTITY_MISMATCH/);
  assert.equal(unhealthy.calls.cas, 0);
  const ambiguous = controller({ render: { async createDeploy() { throw new Error('socket reset'); }, async getDeploy() { throw new Error('must not poll'); } } });
  await assert.rejects(() => ambiguous.controller.deploy({ mirrorSha, sourceSha, manifestSha256, releaseId: 'release-1', reason: 'approved deploy' }), /RENDER_DEPLOY_POST_AMBIGUOUS/);
  assert.equal(ambiguous.calls.cas, 0);
});
