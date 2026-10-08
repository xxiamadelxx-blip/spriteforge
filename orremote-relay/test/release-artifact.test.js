import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ReleaseArtifactError, createImmutableReleaseArtifactStore, createReleaseArtifactVerifier } from '../src/release-artifact.js';

const signer = 'A1'.repeat(32);
const sourceSha = 'b'.repeat(40);
const bytes = Buffer.from('verified APK fixture bytes');
const inspector = async () => ({ packageName: 'dev.orremote', versionName: '0.5.0-m5.174', versionCode: 174, signerFingerprint: signer });
const fails = (code, fn) => assert.rejects(fn, (error) => error instanceof ReleaseArtifactError && error.code === code);

test('artifact verifier binds exact bytes, package/version metadata and pinned signer to one source request', async () => {
  const verifier = createReleaseArtifactVerifier({ approvedSignerFingerprint: signer, inspectApk: inspector });
  const result = await verifier.verify({ bytes, sourceSha, requestId: 'request-1', expectedPackage: 'dev.orremote' });
  assert.equal(result.apkSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.objectPath, `android/${sourceSha}/${result.apkSha256}.apk`);
  assert.equal(result.signerFingerprint, signer.toLowerCase());
});

test('artifact verifier rejects a signer or package mismatch before storage', async () => {
  const verifier = createReleaseArtifactVerifier({ approvedSignerFingerprint: signer, inspectApk: async () => ({ packageName: 'other.package', versionName: '1', versionCode: 1, signerFingerprint: 'B2'.repeat(32) }) });
  await fails('APK_PACKAGE_MISMATCH', () => verifier.verify({ bytes, sourceSha, requestId: 'request-2', expectedPackage: 'dev.orremote' }));
  const signerOnly = createReleaseArtifactVerifier({ approvedSignerFingerprint: signer, inspectApk: async () => ({ packageName: 'dev.orremote', versionName: '1', versionCode: 1, signerFingerprint: 'B2'.repeat(32) }) });
  await fails('APK_SIGNER_MISMATCH', () => signerOnly.verify({ bytes, sourceSha, requestId: 'request-3', expectedPackage: 'dev.orremote' }));
});

test('immutable storage writes without overwrite and independently verifies readback bytes', async () => {
  const verifier = createReleaseArtifactVerifier({ approvedSignerFingerprint: signer, inspectApk: inspector });
  const verification = await verifier.verify({ bytes, sourceSha, requestId: 'request-4', expectedPackage: 'dev.orremote' });
  const objects = new Map();
  const store = createImmutableReleaseArtifactStore({
    bucket: 'orremote-release-artifacts',
    async putObject({ path, bytes: incoming, upsert }) { assert.equal(upsert, false); if (objects.has(path)) throw new Error('already exists'); objects.set(path, Buffer.from(incoming)); },
    async getObject({ path }) { return objects.get(path); },
  });
  const stored = await store.putVerified({ verification, bytes });
  assert.equal(stored.objectPath, verification.objectPath);
  await fails('APK_LOCAL_VERIFICATION_MISMATCH', () => store.putVerified({ verification, bytes: Buffer.from('tampered') }));
});
