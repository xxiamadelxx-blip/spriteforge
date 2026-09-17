const blockedKeys = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'OREMOTE_BUS_SECRET',
  'CM_API_TOKEN',
  'CODEMAGIC_APP_ID',
  'CODEMAGIC_WORKFLOW_ID',
  'OAUTH_ALLOWED_CLIENT_ID',
  'OAUTH_ALLOWED_REDIRECT_URIS',
];

for (const key of blockedKeys) delete process.env[key];

process.env.OREMOTE_TEST_ISOLATED = '1';
process.env.RUN_LIVE_EXTERNAL_SMOKE = '0';
process.env.RELAY_TOKEN_SECRET = 'orremote-test-only-secret-never-production-0001';
process.env.PUBLIC_ORIGIN = 'https://orremote.test.invalid';
