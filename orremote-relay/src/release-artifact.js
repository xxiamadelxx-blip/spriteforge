import crypto from 'node:crypto';

export class ReleaseArtifactError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new ReleaseArtifactError(code);
  return value.trim();
}

export function normalizeSha256(value) {
  const sha = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new ReleaseArtifactError('APK_SHA256_INVALID');
  return sha;
}

export function normalizeFingerprint(value) {
  const fingerprint = String(value || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ReleaseArtifactError('SIGNER_FINGERPRINT_INVALID');
  return fingerprint;
}

export function contentAddressedApkPath({ sourceSha, apkSha256 }) {
  const source = String(sourceSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(source)) throw new ReleaseArtifactError('SOURCE_SHA_INVALID');
  return `android/${source}/${normalizeSha256(apkSha256)}.apk`;
}

export function createReleaseArtifactVerifier({ approvedSignerFingerprint, inspectApk }) {
  const approved = normalizeFingerprint(approvedSignerFingerprint);
  if (typeof inspectApk !== 'function') throw new TypeError('inspectApk is required');

  return {
    async verify({ bytes, sourceSha, requestId, expectedPackage }) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new ReleaseArtifactError('APK_BYTES_INVALID');
      const source = String(sourceSha || '').toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(source)) throw new ReleaseArtifactError('SOURCE_SHA_INVALID');
      nonEmpty(requestId, 'RELEASE_REQUEST_ID_REQUIRED');
      const inspection = await inspectApk(bytes);
      const packageName = nonEmpty(inspection?.packageName, 'APK_PACKAGE_MISSING');
      if (expectedPackage && packageName !== expectedPackage) throw new ReleaseArtifactError('APK_PACKAGE_MISMATCH');
      const versionName = nonEmpty(inspection?.versionName, 'APK_VERSION_NAME_MISSING');
      const versionCode = Number(inspection?.versionCode);
      if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw new ReleaseArtifactError('APK_VERSION_CODE_INVALID');
      const signerFingerprint = normalizeFingerprint(inspection?.signerFingerprint);
      if (!crypto.timingSafeEqual(Buffer.from(signerFingerprint, 'hex'), Buffer.from(approved, 'hex'))) {
        throw new ReleaseArtifactError('APK_SIGNER_MISMATCH');
      }
      const apkSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      return Object.freeze({
        requestId: String(requestId), sourceSha: source, packageName, versionName, versionCode,
        signerFingerprint, apkSha256, byteSize: bytes.length,
        objectPath: contentAddressedApkPath({ sourceSha: source, apkSha256 }),
      });
    },
  };
}

export function createImmutableReleaseArtifactStore({ bucket, putObject, getObject }) {
  nonEmpty(bucket, 'RELEASE_ARTIFACT_BUCKET_REQUIRED');
  if (typeof putObject !== 'function' || typeof getObject !== 'function') throw new TypeError('storage functions are required');
  return {
    async putVerified({ verification, bytes }) {
      if (!verification || !Buffer.isBuffer(bytes)) throw new ReleaseArtifactError('APK_BYTES_INVALID');
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== normalizeSha256(verification.apkSha256) || bytes.length !== verification.byteSize) throw new ReleaseArtifactError('APK_LOCAL_VERIFICATION_MISMATCH');
      await putObject({ bucket, path: verification.objectPath, bytes, contentType: 'application/vnd.android.package-archive', upsert: false });
      const readback = await getObject({ bucket, path: verification.objectPath });
      const returned = Buffer.from(readback);
      if (returned.length !== verification.byteSize || crypto.createHash('sha256').update(returned).digest('hex') !== verification.apkSha256) {
        throw new ReleaseArtifactError('APK_STORAGE_READBACK_MISMATCH');
      }
      return Object.freeze({ bucket, objectPath: verification.objectPath, apkSha256: verification.apkSha256, byteSize: verification.byteSize });
    },
  };
}
