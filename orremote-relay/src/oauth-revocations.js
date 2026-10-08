import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A single-writer journal for a mounted private volume. When no file path is
// configured this is intentionally process-local (not production-durable).
// Grant identifiers are random and no access/refresh credentials are stored.
export function createOAuthRevocationStore(filePath = '', remoteBackend = null) {
  const location = String(filePath || '').trim();
  if (location && remoteBackend) throw new Error('REVOCATION_STORE_CONFLICT');
  let ready = !remoteBackend;
  const revocations = new Map();
  if (location && fs.existsSync(location)) {
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('REVOCATION_STORE_INVALID');
    }
    let raw;
    try {
      if (stat.size > 2_000_000) throw new Error('oversize');
      raw = JSON.parse(fs.readFileSync(location, 'utf8'));
    } catch {
      throw new Error('REVOCATION_STORE_INVALID');
    }
    if (raw?.version !== 1 || !Array.isArray(raw.revoked) || raw.revoked.length > 20_000) {
      throw new Error('REVOCATION_STORE_INVALID');
    }
    for (const entry of raw.revoked) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(entry?.id || '')
        || !Number.isSafeInteger(entry.expires_at)
        || entry.expires_at < 0) throw new Error('REVOCATION_STORE_INVALID');
      if (entry.expires_at > Date.now()) revocations.set(entry.id, entry.expires_at);
    }
  }

  function isRevoked(id) {
    if (!ready) return true;
    return typeof id === 'string'
      && revocations.has(id)
      && revocations.get(id) > Date.now();
  }

  function persist(map) {
    if (!location) return;
    const dir = path.dirname(location);
    const temporary = path.join(dir, `.oauth-revoke-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      handle = fs.openSync(temporary, 'wx', 0o600);
      const revoked = [...map].map(([id, expires_at]) => ({ id, expires_at }));
      fs.writeFileSync(handle, JSON.stringify({ version: 1, revoked }) + '\n');
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(temporary, location);
    } finally {
      if (handle !== null && handle !== undefined) fs.closeSync(handle);
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  function revoke(id, ttlMs) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id || '')) return false;
    if (isRevoked(id)) return true;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('REVOCATION_TTL_INVALID');
    const expires = Date.now() + ttlMs;
    const next = new Map([...revocations].filter(([, exp]) => exp > Date.now()));
    next.set(id, expires);
    if (remoteBackend) {
      if (!ready) throw new Error('REVOCATION_STORE_UNAVAILABLE');
      return Promise.resolve(remoteBackend.revoke(id, expires)).then((confirmed) => {
        if (confirmed !== true) throw new Error('REVOCATION_STORE_UNAVAILABLE');
        revocations.clear();
        for (const [key, expiry] of next) revocations.set(key, expiry);
        return true;
      });
    }
    persist(next); // Fail before accepting the revocation when storage fails.
    revocations.clear();
    for (const [key, expiry] of next) revocations.set(key, expiry);
    return true;
  }

  async function initialize() {
    if (!remoteBackend || ready) return;
    const rows = await remoteBackend.load();
    if (!Array.isArray(rows) || rows.length > 20_000) throw new Error('REVOCATION_STORE_INVALID');
    const staged = new Map();
    for (const entry of rows) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(entry?.id || '')
        || !Number.isSafeInteger(entry.expires_at) || entry.expires_at < 0) {
        throw new Error('REVOCATION_STORE_INVALID');
      }
      if (entry.expires_at > Date.now()) staged.set(entry.id, entry.expires_at);
    }
    revocations.clear();
    for (const [id, expiresAt] of staged) revocations.set(id, expiresAt);
    ready = true;
  }

  return Object.freeze({
    isRevoked, revoke, initialize,
    get ready() { return ready; },
    durable: Boolean(location || remoteBackend),
  });
}
