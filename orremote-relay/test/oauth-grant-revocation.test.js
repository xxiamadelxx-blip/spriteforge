import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOAuthService } from '../src/oauth.js';
import { verifyCredential, createCredential } from '../src/credentials.js';

const config = {
  publicOrigin: 'https://relay.test',
  oauthIssuer: 'https://relay.test',
  mcpResource: 'https://relay.test/mcp',
  relayTokenSecret: 'q'.repeat(48),
  oauthCodeTtlMs: 5 * 60 * 1000,
  oauthAccessTtlMs: 10 * 60 * 1000,
  oauthRefreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  allowedClientId: 'https://agent.test/client.json',
  allowedRedirectUris: ['https://agent.test/callback'],
};
const verifier = 'oauth-verifier-for-agent-revoke-1234567890';
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const relay = {
  claimPairing(code) {
    if (code === '11111111') return { deviceId: 'a'.repeat(24), pairId: 'pair_generation_A_123456789' };
    if (code === '22222222') return { deviceId: 'b'.repeat(24), pairId: 'pair_generation_B_123456789' };
    return null;
  },
};
function authorize(oauth, pairingCode, scopes = ['android.observe', 'android.control']) {
  const location = oauth.completeAuthorization({
    request: {
      clientId: config.allowedClientId, redirectUri: config.allowedRedirectUris[0],
      resource: config.mcpResource, scopes, codeChallenge: challenge,
      codeChallengeMethod: 'S256', state: 'state',
    },
    pairingCode,
  });
  return oauth.exchangeAuthorizationCode({
    code: new URL(location).searchParams.get('code'),
    codeVerifier: verifier, clientId: config.allowedClientId,
    redirectUri: config.allowedRedirectUris[0], resource: config.mcpResource,
  });
}

test('two independent OAuth grants can bind to the same phone; revoking one blocks its access and refresh only', () => {
  const oauth = createOAuthService({ config, deviceRelay: relay });
  const first = authorize(oauth, '11111111');
  const second = authorize(oauth, '11111111');
  const third = authorize(oauth, '22222222');
  const issued = verifyCredential(config, first.access_token, { kind: 'oauth_access' });
  assert.ok(issued.grant_id);
  assert.notEqual(issued.grant_id, verifyCredential(config, second.access_token, { kind: 'oauth_access' }).grant_id);
  assert.equal(issued.device_id, 'a'.repeat(24));
  assert.deepEqual(issued.scopes, ['android.observe', 'android.control']);
  assert.equal(oauth.revokeToken({ token: first.access_token, clientId: config.allowedClientId }), true);
  assert.equal(oauth.verifyAccessToken(first.access_token), null);
  assert.throws(() => oauth.refresh({ refreshToken: first.refresh_token, clientId: config.allowedClientId, resource: config.mcpResource }), /invalid_grant/);
  assert.ok(oauth.verifyAccessToken(second.access_token));
  assert.ok(oauth.verifyAccessToken(third.access_token));
  assert.ok(oauth.refresh({ refreshToken: second.refresh_token, clientId: config.allowedClientId, resource: config.mcpResource }).access_token);
  assert.equal(oauth.revokeToken({ token: first.access_token, clientId: config.allowedClientId }), true);
});

test('scope cannot escalate on refresh and access tokens cannot cross device identities', () => {
  const oauth = createOAuthService({ config, deviceRelay: relay });
  const first = authorize(oauth, '11111111', ['android.observe']);
  assert.deepEqual(oauth.verifyAccessToken(first.access_token).scopes, ['android.observe']);
  assert.throws(() => oauth.refresh({
    refreshToken: first.refresh_token, clientId: config.allowedClientId,
    resource: config.mcpResource, scope: 'android.observe android.control',
  }), /invalid_scope/);
  assert.equal(verifyCredential(config, first.access_token, { kind: 'oauth_access', deviceId: 'b'.repeat(24) }), null);
  assert.equal(oauth.revokeToken({ token: first.access_token, clientId: 'https://wrong.test/client.json' }), false);
  assert.ok(oauth.verifyAccessToken(first.access_token));
});

test('revoked grant survives a simulated process restart with persistent revocation file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-oauth-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { ...config, oauthRevocationFile: path.join(dir, 'revoked.json') };
  const oauth = createOAuthService({ config: cfg, deviceRelay: relay });
  const victim = authorize(oauth, '11111111');
  const remaining = authorize(oauth, '11111111');
  assert.equal(oauth.revokeToken({ token: victim.refresh_token, clientId: cfg.allowedClientId }), true);
  const restarted = createOAuthService({ config: cfg, deviceRelay: relay });
  assert.equal(restarted.verifyAccessToken(victim.access_token), null);
  assert.throws(() => restarted.refresh({
    refreshToken: victim.refresh_token, clientId: cfg.allowedClientId, resource: cfg.mcpResource,
  }), /invalid_grant/);
  assert.ok(restarted.verifyAccessToken(remaining.access_token));
  assert.equal(fs.statSync(cfg.oauthRevocationFile).mode & 0o077, 0);
});

test('invalid revocation state fails closed on boot; unknown or forged tokens cannot revoke a valid grant', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-oauth-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'revoked.json');
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  assert.throws(() => createOAuthService({ config: { ...config, oauthRevocationFile: file }, deviceRelay: relay }), /REVOCATION_STORE_INVALID/);
  fs.rmSync(file);
  const oauth = createOAuthService({ config: { ...config, oauthRevocationFile: file }, deviceRelay: relay });
  const valid = authorize(oauth, '11111111');
  assert.equal(oauth.revokeToken({ token: 'not-a-token', clientId: config.allowedClientId }), false);
  assert.ok(oauth.verifyAccessToken(valid.access_token));
  assert.equal(oauth.revokeToken({ token: valid.access_token, clientId: config.allowedClientId }), true);
});

test('legacy refresh token migrates to a stable isolated grant and cannot resurrect it after revocation', () => {
  const oauth = createOAuthService({ config, deviceRelay: relay });
  const legacy = createCredential(config, {
    kind: 'oauth_refresh',
    iss: config.oauthIssuer, aud: config.mcpResource,
    client_id: config.allowedClientId,
    device_id: 'a'.repeat(24), pair_id: 'pair_generation_A_123456789',
    scopes: ['android.observe'], ttlMs: config.oauthRefreshTtlMs,
  });
  const first = oauth.refresh({
    refreshToken: legacy, clientId: config.allowedClientId, resource: config.mcpResource,
  });
  const second = oauth.refresh({
    refreshToken: legacy, clientId: config.allowedClientId, resource: config.mcpResource,
  });
  const grant1 = verifyCredential(config, first.access_token, { kind: 'oauth_access' }).grant_id;
  const grant2 = verifyCredential(config, second.access_token, { kind: 'oauth_access' }).grant_id;
  assert.equal(grant1, grant2);
  assert.equal(oauth.revokeToken({ token: legacy, clientId: config.allowedClientId }), true);
  assert.equal(oauth.verifyAccessToken(first.access_token), null);
  assert.equal(oauth.verifyAccessToken(second.access_token), null);
  assert.throws(() => oauth.refresh({
    refreshToken: legacy, clientId: config.allowedClientId, resource: config.mcpResource,
  }), /invalid_grant/);
});
