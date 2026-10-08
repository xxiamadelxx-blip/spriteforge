export class ReleaseDeployError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const TERMINAL = new Set(['live', 'build_failed', 'canceled', 'deactivated', 'failed']);

function sha(value, code) {
  const result = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(result)) throw new ReleaseDeployError(code);
  return result;
}

export function createReleaseDeployController({ render, readHealth, getRunningPointer, compareAndSwapRunningPointer, wait = async () => {} }) {
  if (!render || !readHealth || !getRunningPointer || !compareAndSwapRunningPointer) throw new TypeError('release deploy collaborators are required');
  return {
    async deploy({ mirrorSha, sourceSha, manifestSha256, releaseId, reason, maxPolls = 20 }) {
      mirrorSha = sha(mirrorSha, 'MIRROR_SHA_INVALID');
      sourceSha = sha(sourceSha, 'SOURCE_SHA_INVALID');
      if (!/^[a-f0-9]{64}$/i.test(String(manifestSha256 || ''))) throw new ReleaseDeployError('MANIFEST_SHA_INVALID');
      if (!releaseId || !reason) throw new ReleaseDeployError('RELEASE_DEPLOY_METADATA_REQUIRED');
      let created;
      try { created = await render.createDeploy({ commitId: mirrorSha }); } catch { throw new ReleaseDeployError('RENDER_DEPLOY_POST_AMBIGUOUS'); }
      const deployId = String(created?.id || '');
      if (!deployId) throw new ReleaseDeployError('RENDER_DEPLOY_ID_MISSING');
      let deploy = null;
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        deploy = await render.getDeploy({ deployId });
        if (TERMINAL.has(String(deploy?.status || '').toLowerCase())) break;
        await wait(attempt);
      }
      if (String(deploy?.status || '').toLowerCase() !== 'live') throw new ReleaseDeployError('RENDER_DEPLOY_NOT_LIVE');
      if (String(deploy?.commitId || '').toLowerCase() !== mirrorSha) throw new ReleaseDeployError('RENDER_DEPLOY_COMMIT_MISMATCH');
      const health = await readHealth();
      if (health?.ok !== true || health?.relay_source_sha !== sourceSha || health?.build_manifest_hash !== String(manifestSha256).toLowerCase()) {
        throw new ReleaseDeployError('RELAY_HEALTH_IDENTITY_MISMATCH');
      }
      const pointer = await getRunningPointer();
      const advanced = await compareAndSwapRunningPointer({
        releaseId, expectedRevision: pointer.revision, reason, deployId, mirrorSha,
      });
      if (!advanced) throw new ReleaseDeployError('RUNNING_RELAY_POINTER_CONFLICT');
      return { deployId, mirrorSha, sourceSha, manifestSha256: String(manifestSha256).toLowerCase(), pointerRevision: pointer.revision + 1 };
    },
  };
}
