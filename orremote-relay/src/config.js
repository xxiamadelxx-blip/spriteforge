function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  const relayTokenSecret = String(env.RELAY_TOKEN_SECRET || '');
  if (Buffer.byteLength(relayTokenSecret, 'utf8') < 32) {
    throw new Error('RELAY_TOKEN_SECRET must be configured with at least 32 bytes');
  }

  const publicOrigin = stripTrailingSlash(env.PUBLIC_ORIGIN || 'https://orremote-relay.onrender.com');
  const allowedRedirectUris = String(env.OAUTH_ALLOWED_REDIRECT_URIS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    port: positiveNumber(env.PORT, 3000),
    host: String(env.HOST || '0.0.0.0'),
    publicOrigin,
    mcpResource: `${publicOrigin}/mcp`,
    oauthIssuer: publicOrigin,
    relayTokenSecret,
    mcpTimeoutMs: positiveNumber(env.MCP_TIMEOUT_MS, 15_000),
    pairTtlMs: positiveNumber(env.PAIR_TTL_MS, 10 * 60 * 1000),
    pairCredentialTtlMs: positiveNumber(env.PAIR_CREDENTIAL_TTL_MS, 365 * 24 * 60 * 60 * 1000),
    capabilityTtlMs: positiveNumber(env.CAPABILITY_TTL_MS, 10 * 60 * 1000),
    oauthCodeTtlMs: positiveNumber(env.OAUTH_CODE_TTL_MS, 5 * 60 * 1000),
    oauthAccessTtlMs: positiveNumber(env.OAUTH_ACCESS_TTL_MS, 10 * 60 * 1000),
    oauthRefreshTtlMs: positiveNumber(env.OAUTH_REFRESH_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    workSessionTtlMs: positiveNumber(env.WORK_SESSION_TTL_MS, 60 * 60 * 1000),
    maxBodyBytes: positiveNumber(env.MAX_BODY_BYTES, 1024 * 1024),
    pairAttemptWindowMs: positiveNumber(env.PAIR_ATTEMPT_WINDOW_MS, 10 * 60 * 1000),
    maxPairAttemptsPerIp: positiveNumber(env.MAX_PAIR_ATTEMPTS_PER_IP, 8),
    allowedClientId: String(env.OAUTH_ALLOWED_CLIENT_ID || ''),
    allowedRedirectUris,
    supabaseUrl: stripTrailingSlash(env.SUPABASE_URL || ''),
    supabasePublishableKey: String(env.SUPABASE_PUBLISHABLE_KEY || ''),
    orremoteBusSecret: String(env.OREMOTE_BUS_SECRET || ''),
    orremoteBusPollMs: positiveNumber(env.OREMOTE_BUS_POLL_MS, 1000),
    codemagicApiToken: String(env.CM_API_TOKEN || ''),
    codemagicAppId: String(env.CODEMAGIC_APP_ID || '6aa6542caf15c45faf8dbe96'),
    codemagicWorkflowId: String(env.CODEMAGIC_WORKFLOW_ID || 'android-m1'),
    artifactTransferTimeoutMs: positiveNumber(env.ARTIFACT_TRANSFER_TIMEOUT_MS, 30_000),
    artifactDownloadTtlMs: positiveNumber(env.ARTIFACT_DOWNLOAD_TTL_MS, 15 * 60 * 1000),
    artifactMaxBytes: positiveNumber(env.ARTIFACT_MAX_BYTES, 32 * 1024 * 1024),
    artifactMaxConcurrentPerDevice: positiveNumber(env.ARTIFACT_MAX_CONCURRENT_PER_DEVICE, 2),
    artifactStagingDir: String(env.ARTIFACT_STAGING_DIR || ''),
  };
}
