import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('isolated relay tests cannot enable production mutation backends', () => {
  const config = loadConfig({
    OREMOTE_TEST_ISOLATED: '1',
    RELAY_TOKEN_SECRET: 'x'.repeat(64),
    PUBLIC_ORIGIN: 'https://example.test',
    SUPABASE_URL: 'https://prod-project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'prod-publishable-key',
    OREMOTE_BUS_SECRET: 'prod-bus-secret',
    CM_API_TOKEN: 'prod-codemagic-token',
    CODEMAGIC_APP_ID: 'prod-app',
    CODEMAGIC_WORKFLOW_ID: 'android-m1',
  });

  assert.equal(config.supabaseUrl, '');
  assert.equal(config.supabasePublishableKey, '');
  assert.equal(config.orremoteBusSecret, '');
  assert.equal(config.codemagicApiToken, '');
});
