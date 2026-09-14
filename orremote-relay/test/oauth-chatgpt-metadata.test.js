import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthService } from '../src/oauth.js';

function fixture() {
  const config = {
    publicOrigin: 'https://orremote-relay.onrender.com',
    mcpResource: 'https://orremote-relay.onrender.com/mcp',
    oauthIssuer: 'https://orremote-relay.onrender.com',
    relayTokenSecret: 'x'.repeat(64),
    oauthCodeTtlMs: 300000,
    oauthAccessTtlMs: 600000,
    oauthRefreshTtlMs: 2592000000,
    allowedClientId: 'https://chatgpt.com/oauth/client.json',
    allowedRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  };
  const deviceRelay = { claimPairing() { return null; } };
  return createOAuthService({ config, deviceRelay });
}

test('authorization metadata advertises RFC 9207 issuer identification for stable ChatGPT callback', () => {
  const metadata = fixture().authorizationServerMetadata();
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
});
