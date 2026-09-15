import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function artifactError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pairFingerprint(pairId) {
  return crypto.createHash('sha256').update(String(pairId || ''), 'utf8').digest('hex').slice(0, 24);
}

function validMime(mimeType) {
  return mimeType === 'image/png' || mimeType === 'application/json';
}

function validBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function createArtifactBroker(config, options = {}) {
  const now = options.now || (() => Date.now());
  const root = path.resolve(config.artifactStagingDir || path.join(os.tmpdir(), 'orremote-artifacts'));
  const pending = new Map();
  const stages = new Map();

  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root)) {
    try { fs.rmSync(path.join(root, entry), { force: true, recursive: false }); } catch {}
  }

  function closePart(transfer, remove = true) {
    if (transfer.fd != null) {
      try { fs.closeSync(transfer.fd); } catch {}
      transfer.fd = null;
    }
    if (remove && transfer.partPath) {
      try { fs.rmSync(transfer.partPath, { force: true }); } catch {}
    }
  }

  function fail(requestId, code, status = 400) {
    const transfer = pending.get(requestId);
    if (!transfer) return;
    pending.delete(requestId);
    clearTimeout(transfer.timer);
    closePart(transfer, true);
    transfer.reject(artifactError(code, status));
  }

  function countForDevice(deviceId) {
    let count = 0;
    for (const value of pending.values()) if (value.deviceId === deviceId) count += 1;
    return count;
  }

  function beginRequest({ requestId, deviceId, pairId, artifactId, sessionEpoch }) {
    if (!crypto.randomUUID || !requestId || !deviceId || !pairId || !artifactId || !Number.isFinite(Number(sessionEpoch))) {
      return Promise.reject(artifactError('ARTIFACT_REQUEST_INVALID'));
    }
    if (pending.has(requestId)) return Promise.reject(artifactError('ARTIFACT_REQUEST_DUPLICATE'));
    if (countForDevice(deviceId) >= config.artifactMaxConcurrentPerDevice) {
      return Promise.reject(artifactError('ARTIFACT_CONCURRENCY_LIMIT', 429));
    }

    return new Promise((resolve, reject) => {
      const transfer = {
        requestId,
        deviceId,
        pairFingerprint: pairFingerprint(pairId),
        artifactId,
        sessionEpoch: Number(sessionEpoch),
        expectedSequence: 0,
        receivedBytes: 0,
        expectedBytes: null,
        mimeType: null,
        digest: null,
        fd: null,
        partPath: null,
        resolve,
        reject,
        timer: null,
      };
      transfer.timer = setTimeout(() => fail(requestId, 'ARTIFACT_TIMEOUT', 504), config.artifactTransferTimeoutMs);
      transfer.timer.unref?.();
      pending.set(requestId, transfer);
    });
  }

  function beginFrame(transfer, message) {
    if (transfer.fd != null || transfer.expectedBytes != null) return fail(transfer.requestId, 'ARTIFACT_PROTOCOL_INVALID');
    if (String(message.artifact_id || '') !== transfer.artifactId) return fail(transfer.requestId, 'ARTIFACT_ID_MISMATCH');
    const mimeType = String(message.mime_type || '');
    const byteSize = Number(message.byte_size);
    if (!validMime(mimeType)) return fail(transfer.requestId, 'ARTIFACT_TYPE_UNSUPPORTED');
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > config.artifactMaxBytes) {
      return fail(transfer.requestId, 'ARTIFACT_TOO_LARGE', 413);
    }
    const partPath = path.join(root, `${transfer.requestId}.part`);
    try {
      transfer.fd = fs.openSync(partPath, 'wx', 0o600);
    } catch {
      return fail(transfer.requestId, 'ARTIFACT_STAGE_FAILED', 500);
    }
    transfer.partPath = partPath;
    transfer.mimeType = mimeType;
    transfer.expectedBytes = byteSize;
    transfer.digest = crypto.createHash('sha256');
  }

  function chunkFrame(transfer, message) {
    if (transfer.fd == null || transfer.expectedBytes == null || !transfer.digest) {
      return fail(transfer.requestId, 'ARTIFACT_PROTOCOL_INVALID');
    }
    const sequence = Number(message.sequence);
    if (!Number.isSafeInteger(sequence) || sequence !== transfer.expectedSequence) {
      return fail(transfer.requestId, 'ARTIFACT_SEQUENCE_INVALID');
    }
    const encoded = message.data_b64;
    if (!validBase64(encoded)) return fail(transfer.requestId, 'ARTIFACT_CHUNK_INVALID');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || transfer.receivedBytes + bytes.length > transfer.expectedBytes || transfer.receivedBytes + bytes.length > config.artifactMaxBytes) {
      return fail(transfer.requestId, 'ARTIFACT_SIZE_MISMATCH');
    }
    try {
      fs.writeSync(transfer.fd, bytes);
    } catch {
      return fail(transfer.requestId, 'ARTIFACT_STAGE_FAILED', 500);
    }
    transfer.digest.update(bytes);
    transfer.receivedBytes += bytes.length;
    transfer.expectedSequence += 1;
  }

  function completeFrame(transfer, message) {
    if (transfer.fd == null || transfer.expectedBytes == null || !transfer.digest) {
      return fail(transfer.requestId, 'ARTIFACT_PROTOCOL_INVALID');
    }
    if (transfer.receivedBytes !== transfer.expectedBytes) return fail(transfer.requestId, 'ARTIFACT_SIZE_MISMATCH');
    const actualHash = transfer.digest.digest('hex');
    const claimedHash = String(message.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(claimedHash) || !safeEqualText(actualHash, claimedHash)) {
      return fail(transfer.requestId, 'ARTIFACT_HASH_MISMATCH');
    }

    try { fs.fsyncSync(transfer.fd); } catch {}
    closePart(transfer, false);
    const stageId = crypto.randomUUID();
    const stagedPath = path.join(root, `${stageId}.stage`);
    try {
      fs.renameSync(transfer.partPath, stagedPath);
    } catch {
      try { fs.rmSync(transfer.partPath, { force: true }); } catch {}
      return fail(transfer.requestId, 'ARTIFACT_STAGE_FAILED', 500);
    }

    pending.delete(transfer.requestId);
    clearTimeout(transfer.timer);
    const expiresAt = now() + config.artifactDownloadTtlMs;
    const stage = {
      stageId,
      filePath: stagedPath,
      deviceId: transfer.deviceId,
      pairFingerprint: transfer.pairFingerprint,
      artifactId: transfer.artifactId,
      mimeType: transfer.mimeType,
      byteSize: transfer.receivedBytes,
      sha256: actualHash,
      expiresAt,
      consumed: false,
    };
    stages.set(stageId, stage);
    const downloadToken = signDownloadToken(stage);
    transfer.resolve({
      stageId,
      downloadToken,
      expiresAt,
      mimeType: stage.mimeType,
      byteSize: stage.byteSize,
      sha256: stage.sha256,
      artifactId: stage.artifactId,
    });
  }

  function acceptFrame({ deviceId, sessionEpoch, message }) {
    const requestId = String(message?.request_id || '');
    const transfer = pending.get(requestId);
    if (!transfer) return false;
    if (transfer.deviceId !== deviceId || transfer.sessionEpoch !== Number(sessionEpoch)) return false;
    if (Number(message.session_epoch) !== transfer.sessionEpoch) return false;

    switch (message.type) {
      case 'artifact_begin': beginFrame(transfer, message); break;
      case 'artifact_chunk': chunkFrame(transfer, message); break;
      case 'artifact_complete': completeFrame(transfer, message); break;
      case 'artifact_error': fail(requestId, String(message.code || 'ARTIFACT_REMOTE_ERROR')); break;
      default: return false;
    }
    return true;
  }

  function signDownloadToken(stage) {
    const payload = Buffer.from(JSON.stringify({
      s: stage.stageId,
      d: stage.deviceId,
      p: stage.pairFingerprint,
      e: stage.expiresAt,
      n: crypto.randomBytes(12).toString('base64url'),
    }), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', config.relayTokenSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verifyDownloadToken(token) {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra) throw artifactError('ARTIFACT_TOKEN_INVALID', 401);
    const expected = crypto.createHmac('sha256', config.relayTokenSecret).update(payload).digest('base64url');
    if (!safeEqualText(signature, expected)) throw artifactError('ARTIFACT_TOKEN_INVALID', 401);
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw artifactError('ARTIFACT_TOKEN_INVALID', 401); }
    if (!claims || typeof claims.s !== 'string' || !Number.isFinite(Number(claims.e))) throw artifactError('ARTIFACT_TOKEN_INVALID', 401);
    if (Number(claims.e) <= now()) throw artifactError('ARTIFACT_EXPIRED', 410);
    return claims;
  }

  function openDownload(token) {
    cleanupExpiredStages();
    const claims = verifyDownloadToken(token);
    const stage = stages.get(claims.s);
    if (!stage || stage.consumed) throw artifactError('ARTIFACT_NOT_FOUND', 404);
    if (stage.expiresAt <= now()) {
      deleteStage(stage.stageId);
      throw artifactError('ARTIFACT_EXPIRED', 410);
    }
    if (stage.deviceId !== claims.d || stage.pairFingerprint !== claims.p) throw artifactError('ARTIFACT_TOKEN_INVALID', 401);
    if (!fs.existsSync(stage.filePath)) {
      stages.delete(stage.stageId);
      throw artifactError('ARTIFACT_NOT_FOUND', 404);
    }
    return { ...stage };
  }

  function consumeStage(stageId) {
    const stage = stages.get(stageId);
    if (!stage) return false;
    stage.consumed = true;
    try { fs.rmSync(stage.filePath, { force: true }); } catch {}
    stages.delete(stageId);
    return true;
  }

  function deleteStage(stageId) {
    const stage = stages.get(stageId);
    if (!stage) return;
    try { fs.rmSync(stage.filePath, { force: true }); } catch {}
    stages.delete(stageId);
  }

  function cleanupExpiredStages() {
    for (const stage of stages.values()) {
      if (stage.expiresAt <= now()) deleteStage(stage.stageId);
    }
  }

  function cancelForDevice(deviceId, code = 'DEVICE_DISCONNECTED') {
    for (const [requestId, transfer] of pending.entries()) {
      if (transfer.deviceId === deviceId) fail(requestId, code, 503);
    }
  }

  return {
    beginRequest,
    acceptFrame,
    openDownload,
    consumeStage,
    cleanupExpiredStages,
    cancelForDevice,
    pendingCount: () => pending.size,
    stagedCount: () => stages.size,
  };
}
