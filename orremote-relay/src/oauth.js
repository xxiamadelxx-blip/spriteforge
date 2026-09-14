import crypto from 'node:crypto';
import { createCredential, verifyCredential } from './credentials.js';

const SUPPORTED_SCOPES = ['android.observe', 'android.control'];

function oauthError(code) {
  return new Error(code);
}

function parseScopes(value) {
  const requested = String(value || '').split(/\s+/).filter(Boolean);
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

export function createOAuthService({ config, deviceRelay }) {
  const authorizationCodes = new Map();

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
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SUPPORTED_SCOPES],
      client_id_metadata_document_supported: true,
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

  function completeAuthorization({ request, pairingCode }) {
    const pairing = deviceRelay.claimPairing(String(pairingCode || ''));
    if (!pairing?.deviceId || !pairing?.pairId) throw oauthError('invalid_pairing_code');

    const code = crypto.randomBytes(32).toString('base64url');
    authorizationCodes.set(sha256Hex(code), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scopes: [...request.scopes],
      deviceId: pairing.deviceId,
      pairId: pairing.pairId,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      expiresAt: Date.now() + Number(config.oauthCodeTtlMs),
    });

    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', config.oauthIssuer);
    return redirect.toString();
  }

  function issueTokenSet(record) {
    const baseClaims = {
      iss: config.oauthIssuer,
      aud: config.mcpResource,
      device_id: record.deviceId,
      pair_id: record.pairId,
      scopes: [...record.scopes],
      client_id: record.clientId,
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
    if (!payload || resource !== config.mcpResource) throw oauthError('invalid_grant');

    const requested = scope ? parseScopes(scope) : [...payload.scopes];
    if (requested.some((item) => !payload.scopes.includes(item))) throw oauthError('invalid_scope');

    return issueTokenSet({
      clientId: payload.client_id,
      deviceId: payload.device_id,
      pairId: payload.pair_id,
      scopes: requested,
    });
  }

  function verifyAccessToken(token, requiredScope = null) {
    return verifyCredential(config, token, {
      kind: 'oauth_access',
      issuer: config.oauthIssuer,
      audience: config.mcpResource,
      requiredScope,
    });
  }

  return {
    protectedResourceMetadata,
    authorizationServerMetadata,
    validateAuthorizeRequest,
    completeAuthorization,
    exchangeAuthorizationCode,
    refresh,
    verifyAccessToken,
  };
}
