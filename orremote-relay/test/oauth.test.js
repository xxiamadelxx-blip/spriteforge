import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOAuthService } from '../src/oauth.js';

const config = {
  publicOrigin: 'https://relay.test',
  oauthIssuer: 'https://relay.test',
  mcpResource: 'https://relay.test/mcp',
  relayTokenSecret: 'x'.repeat(48),
  oauthCodeTtlMs: 5 * 60 * 1000,
  oauthAccessTtlMs: 10 * 60 * 1000,
  oauthRefreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  allowedClientId: 'https://chatgpt.test/client-metadata.json',
  allowedRedirectUris: ['https://chatgpt.test/oauth/callback'],
};

function base64urlSha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

function deviceRelayStub() {
  return {
    claimPairing(code) {
      assert.equal(code, '12345678');
      return {
        deviceId: 'a'.repeat(24),
        pairId: 'pair_generation_1234567890',
      };
    },
  };
}

test('OAuth discovery advertises PKCE S256 and exact MCP resource', () => {
  const oauth = createOAuthService({ config, deviceRelay: deviceRelayStub() });
  const resource = oauth.protectedResourceMetadata();
  const server = oauth.authorizationServerMetadata();

  assert.equal(resource.resource, config.mcpResource);
  assert.deepEqual(resource.authorization_servers, [config.oauthIssuer]);
  assert.deepEqual(resource.scopes_supported, ['android.observe', 'android.control']);
  assert.equal(server.issuer, config.oauthIssuer);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ['none']);
});

test('authorize validation rejects wrong resource, plain PKCE and unknown client', () => {
  const oauth = createOAuthService({ config, deviceRelay: deviceRelayStub() });
  const base = {
    response_type: 'code',
    client_id: config.allowedClientId,
    redirect_uri: config.allowedRedirectUris[0],
    resource: config.mcpResource,
    scope: 'android.observe android.control',
    state: 'state-1',
    code_challenge: base64urlSha256('verifier-value'),
    code_challenge_method: 'S256',
  };

  assert.throws(() => oauth.validateAuthorizeRequest(new URL(`https://relay.test/oauth/authorize?${new URLSearchParams({ ...base, resource: 'https://wrong.test/mcp' })}`)), /resource/i);
  assert.throws(() => oauth.validateAuthorizeRequest(new URL(`https://relay.test/oauth/authorize?${new URLSearchParams({ ...base, code_challenge_method: 'plain' })}`)), /PKCE|S256/i);
  assert.throws(() => oauth.validateAuthorizeRequest(new URL(`https://relay.test/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'https://evil.test/client.json' })}`)), /client/i);
});

test('authorization code is one-time and bound to PKCE verifier', () => {
  const oauth = createOAuthService({ config, deviceRelay: deviceRelayStub() });
  const verifier = 'correct-verifier-value-abcdefghijklmnopqrstuvwxyz';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.allowedClientId,
    redirect_uri: config.allowedRedirectUris[0],
    resource: config.mcpResource,
    scope: 'android.observe android.control',
    state: 'state-2',
    code_challenge: base64urlSha256(verifier),
    code_challenge_method: 'S256',
  });
  const request = oauth.validateAuthorizeRequest(new URL(`https://relay.test/oauth/authorize?${params}`));
  const redirect = new URL(oauth.completeAuthorization({ request, pairingCode: '12345678' }));
  const code = redirect.searchParams.get('code');

  assert.ok(code);
  assert.equal(redirect.searchParams.get('state'), 'state-2');
  assert.equal(redirect.searchParams.get('iss'), config.oauthIssuer);

  assert.throws(() => oauth.exchangeAuthorizationCode({
    code,
    codeVerifier: 'wrong-verifier-value',
    clientId: config.allowedClientId,
    redirectUri: config.allowedRedirectUris[0],
    resource: config.mcpResource,
  }), /invalid_grant/i);

  const tokens = oauth.exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    clientId: config.allowedClientId,
    redirectUri: config.allowedRedirectUris[0],
    resource: config.mcpResource,
  });
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 600);
  assert.equal(tokens.scope, 'android.observe android.control');
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  assert.throws(() => oauth.exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    clientId: config.allowedClientId,
    redirectUri: config.allowedRedirectUris[0],
    resource: config.mcpResource,
  }), /invalid_grant/i);
});
