import crypto from 'node:crypto';

function hmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createCredential(config, claims) {
  const now = Date.now();
  const ttlMs = Number(claims.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('credential ttl must be positive');
  const payload = {
    v: 1,
    ...claims,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: crypto.randomBytes(16).toString('base64url'),
  };
  delete payload.ttlMs;
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(config.relayTokenSecret, body)}`;
}

export function verifyCredential(config, token, requirements = {}) {
  const [body, signature, extra] = String(token || '').split('.');
  if (!body || !signature || extra !== undefined) return null;
  if (!safeEqualText(signature, hmac(config.relayTokenSecret, body))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return null;
  if (!Number.isInteger(payload?.iat) || payload.iat > now + 60) return null;
  if (!Number.isInteger(payload?.exp) || payload.exp <= now) return null;
  if (requirements.kind && payload.kind !== requirements.kind) return null;
  if (requirements.issuer && payload.iss !== requirements.issuer) return null;
  if (requirements.audience && payload.aud !== requirements.audience) return null;
  if (requirements.clientId && payload.client_id !== requirements.clientId) return null;
  if (requirements.deviceId && payload.device_id !== requirements.deviceId) return null;
  if (requirements.pairId && payload.pair_id !== requirements.pairId) return null;
  if (requirements.requiredScope) {
    if (!Array.isArray(payload.scopes) || !payload.scopes.includes(requirements.requiredScope)) return null;
  }
  return payload;
}
