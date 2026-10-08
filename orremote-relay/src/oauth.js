import crypto from 'node:crypto';
import { createCredential, verifyCredential } from './credentials.js';
import { createOAuthRevocationStore } from './oauth-revocations.js';
import { createSupabaseOAuthRevocationBackend } from './oauth-supabase-backend.js';

const SUPPORTED_SCOPES = ['android.observe', 'android.control'];

function oauthError(code) {
  return new Error(code);
}

function parseScopes(value) {
  const requested = Array.isArray(value)
    ? value.map(String)
    : String(value || '').split(/\s+/).filter(Boolean);
  const unique = [...new Set(requested)];
  if (!unique.length) throw oauthError('invalid_scope');
  for (const scope of unique) {
    if (!SUPPORTED_SCOPES.includes(scope)) throw oauthError('invalid_scope');
  }
  return SUPPORTED_SCOPES.filter((scope) => unique.includes(scope));
}

function sha256Base64url(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactRedirectAllowed(config, redirectUri) {
  return Array.isArray(config.allowedRedirectUris) && config.allowedRedirectUris.includes(redirectUri);
}

function validateRequestObject(config, candidate) {
  if (!candidate || typeof candidate !== 'object') throw oauthError('invalid_request');
  const clientId = String(candidate.clientId || '');
  const redirectUri = String(candidate.redirectUri || '');
  const resource = String(candidate.resource || '');
  const codeChallenge = String(candidate.codeChallenge || '');
  const codeChallengeMethod = String(candidate.codeChallengeMethod || '');
  if (!clientId || clientId !== config.allowedClientId) throw oauthError('invalid_request');
  if (!redirectUri || !exactRedirectAllowed(config, redirectUri)) throw oauthError('invalid_request');
  if (resource !== config.mcpResource) throw oauthError('invalid_request');
  if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw oauthError('invalid_request');
  const scopes = parseScopes(candidate.scopes);
  return {
    clientId,
    redirectUri,
    resource,
    scopes,
    state: String(candidate.state || ''),
    codeChallenge,
    codeChallengeMethod,
  };
}

export function createOAuthService({ config, deviceRelay }) {
  const authorizationCodes = new Map();
  const backend = config.oauthRevocationBackend === 'supabase'
    ? createSupabaseOAuthRevocationBackend(config)
    : null;
  const revoked = createOAuthRevocationStore(config.oauthRevocationFile, backend);

  // Earlier signed refresh tokens lacked a shared grant_id. Deriving a stable
  // per-token identity allows a no-pairing migration and prevents a previously
  // issued legacy refresh from recreating independent grants after revocation.
  function grantIdFor(payload) {
    if (typeof payload?.grant_id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(payload.grant_id)) {
      return payload.grant_id;
    }
    if ((payload?.kind === 'oauth_refresh' || payload?.kind === 'oauth_access')
      && typeof payload.jti === 'string' && payload.jti.length >= 16) {
      return crypto.createHash('sha256')
        .update('orremote-legacy-grant/' + payload.kind + '/' + payload.jti)
        .digest('base64url').slice(0, 22);
    }
    return null;
  }

  function protectedResourceMetadata() {
    return {
      resource: config.mcpResource,
      authorization_servers: [config.oauthIssuer],
      scopes_supported: [...SUPPORTED_SCOPES],
      bearer_methods_supported: ['header'],
    };
  }

  function authorizationServerMetadata() {
    return {
      issuer: config.oauthIssuer,
      authorization_endpoint: `${config.oauthIssuer}/oauth/authorize`,
      token_endpoint: `${config.oauthIssuer}/oauth/token`,
      revocation_endpoint: `${config.oauthIssuer}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ['none'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SUPPORTED_SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  function validateAuthorizeRequest(url) {
    const params = url.searchParams;
    if (params.get('response_type') !== 'code') throw oauthError('unsupported_response_type');

    const clientId = String(params.get('client_id') || '');
    if (!clientId || clientId !== config.allowedClientId) throw oauthError('invalid_client');

    const redirectUri = String(params.get('redirect_uri') || '');
    if (!redirectUri || !exactRedirectAllowed(config, redirectUri)) throw oauthError('invalid_redirect_uri');

    const resource = String(params.get('resource') || '');
    if (resource !== config.mcpResource) throw oauthError('invalid_resource');

    const method = String(params.get('code_challenge_method') || '');
    const challenge = String(params.get('code_challenge') || '');
    if (method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw oauthError('PKCE S256 required');

    const scopes = parseScopes(params.get('scope'));
    return {
      clientId,
      redirectUri,
      resource,
      scopes,
      state: String(params.get('state') || ''),
      codeChallenge: challenge,
      codeChallengeMethod: method,
    };
  }

  function sealAuthorizeRequest(request) {
    const validated = validateRequestObject(config, request);
    return createCredential(config, {
      kind: 'oauth_request',
      iss: config.oauthIssuer,
      aud: config.mcpResource,
      client_id: validated.clientId,
      redirect_uri: validated.redirectUri,
      resource: validated.resource,
      scopes: validated.scopes,
      state: validated.state,
      code_challenge: validated.codeChallenge,
      code_challenge_method: validated.codeChallengeMethod,
      ttlMs: Number(config.oauthCodeTtlMs),
    });
  }

  function openAuthorizeRequest(requestToken) {
    const payload = verifyCredential(config, requestToken, {
      kind: 'oauth_request',
      issuer: config.oauthIssuer,
      audience: config.mcpResource,
    });
    if (!payload) throw oauthError('invalid_request');
    return validateRequestObject(config, {
      clientId: payload.client_id,
      redirectUri: payload.redirect_uri,
      resource: payload.resource,
      scopes: payload.scopes,
      state: payload.state,
      codeChallenge: payload.code_challenge,
      codeChallengeMethod: payload.code_challenge_method,
    });
  }

  function completeAuthorizationResult({ request, requestToken, pairingCode }) {
    const resolvedRequest = requestToken ? openAuthorizeRequest(requestToken) : validateRequestObject(config, request);
    const pairing = deviceRelay.claimPairing(String(pairingCode || ''));
    if (!pairing?.deviceId || !pairing?.pairId) throw oauthError('invalid_pairing_code');

    const code = crypto.randomBytes(32).toString('base64url');
    authorizationCodes.set(sha256Hex(code), {
      clientId: resolvedRequest.clientId,
      redirectUri: resolvedRequest.redirectUri,
      resource: resolvedRequest.resource,
      scopes: [...resolvedRequest.scopes],
      deviceId: pairing.deviceId,
      pairId: pairing.pairId,
      codeChallenge: resolvedRequest.codeChallenge,
      codeChallengeMethod: resolvedRequest.codeChallengeMethod,
      grantId: crypto.randomBytes(16).toString('base64url'),
      expiresAt: Date.now() + Number(config.oauthCodeTtlMs),
    });

    const redirect = new URL(resolvedRequest.redirectUri);
    redirect.searchParams.set('code', code);
    if (resolvedRequest.state) redirect.searchParams.set('state', resolvedRequest.state);
    redirect.searchParams.set('iss', config.oauthIssuer);
    return {
      location: redirect.toString(),
      pairing: {
        deviceId: pairing.deviceId,
        pairId: pairing.pairId,
      },
    };
  }

  function completeAuthorization(args) {
    return completeAuthorizationResult(args).location;
  }

  function issueTokenSet(record) {
    const baseClaims = {
      iss: config.oauthIssuer,
      aud: config.mcpResource,
      device_id: record.deviceId,
      pair_id: record.pairId,
      scopes: [...record.scopes],
      client_id: record.clientId,
      grant_id: record.grantId || crypto.randomBytes(16).toString('base64url'),
    };
    return {
      token_type: 'Bearer',
      expires_in: Math.floor(Number(config.oauthAccessTtlMs) / 1000),
      scope: record.scopes.join(' '),
      access_token: createCredential(config, {
        ...baseClaims,
        kind: 'oauth_access',
        ttlMs: Number(config.oauthAccessTtlMs),
      }),
      refresh_token: createCredential(config, {
        ...baseClaims,
        kind: 'oauth_refresh',
        ttlMs: Number(config.oauthRefreshTtlMs),
      }),
    };
  }

  function exchangeAuthorizationCode({ code, codeVerifier, clientId, redirectUri, resource }) {
    const key = sha256Hex(String(code || ''));
    const record = authorizationCodes.get(key);
    if (!record || record.expiresAt <= Date.now()) {
      authorizationCodes.delete(key);
      throw oauthError('invalid_grant');
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri || record.resource !== resource) {
      throw oauthError('invalid_grant');
    }
    if (!codeVerifier || sha256Base64url(String(codeVerifier)) !== record.codeChallenge) {
      throw oauthError('invalid_grant');
    }

    authorizationCodes.delete(key);
    return issueTokenSet(record);
  }

  function refresh({ refreshToken, clientId, resource, scope }) {
    const payload = verifyCredential(config, refreshToken, {
      kind: 'oauth_refresh',
      issuer: config.oauthIssuer,
      audience: config.mcpResource,
      clientId,
    });
    if (!payload || resource !== config.mcpResource || revoked.isRevoked(grantIdFor(payload))) throw oauthError('invalid_grant');

    const requested = scope ? parseScopes(scope) : [...payload.scopes];
    if (requested.some((item) => !payload.scopes.includes(item))) throw oauthError('invalid_scope');

    return issueTokenSet({
      clientId: payload.client_id,
      deviceId: payload.device_id,
      pairId: payload.pair_id,
      grantId: grantIdFor(payload),
      scopes: requested,
    });
  }

  function verifyAccessToken(token, requiredScope = null) {
    const claims = verifyCredential(config, token, {
      kind: 'oauth_access',
      issuer: config.oauthIssuer,
      audience: config.mcpResource,
      requiredScope,
    });
    return claims && !revoked.isRevoked(grantIdFor(claims)) ? claims : null;
  }

  function revokeToken({ token, clientId }) {
    // Public OAuth clients authenticate the request by possession of a valid
    // issued token. A stolen/invalid token cannot revoke someone else's grant.
    if (!clientId || clientId !== config.allowedClientId) return false;
    const requirements = {
      issuer: config.oauthIssuer,
      audience: config.mcpResource,
      clientId,
    };
    const claims = verifyCredential(config, token, { ...requirements, kind: 'oauth_access' })
      || verifyCredential(config, token, { ...requirements, kind: 'oauth_refresh' });
    const grantId = grantIdFor(claims);
    if (!grantId) return false;
    return revoked.revoke(grantId, Math.max(
      Number(config.oauthRefreshTtlMs),
      Number(config.oauthAccessTtlMs),
    ) + 60_000);
  }

  return {
    protectedResourceMetadata,
    authorizationServerMetadata,
    validateAuthorizeRequest,
    sealAuthorizeRequest,
    openAuthorizeRequest,
    completeAuthorization,
    completeAuthorizationResult,
    exchangeAuthorizationCode,
    refresh,
    verifyAccessToken,
    revokeToken,
    revocationDurable: revoked.durable,
    get revocationReady() { return revoked.ready; },
    initializeRevocations: () => revoked.initialize(),
  };
}
