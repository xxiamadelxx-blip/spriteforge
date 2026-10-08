import http from 'node:http';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createCredential } from '../src/credentials.js';
import { createOAuthService } from '../src/oauth.js';
import { createMcpPluginHandler } from '../src/mcp-plugin.js';

function makeConfig() {
  return {
    publicOrigin: 'http://127.0.0.1',
    oauthIssuer: 'http://127.0.0.1',
    mcpResource: 'http://127.0.0.1/mcp',
    relayTokenSecret: 'm'.repeat(48),
    allowedClientId: 'chatgpt-test-client',
    oauthAccessTtlMs: 10 * 60 * 1000,
    oauthRefreshTtlMs: 30 * 24 * 60 * 60 * 1000,
    oauthCodeTtlMs: 5 * 60 * 1000,
    maxBodyBytes: 1024 * 1024,
  };
}

function accessToken(config, scopes) {
  return createCredential(config, {
    kind: 'oauth_access',
    iss: config.oauthIssuer,
    aud: config.mcpResource,
    device_id: 'a'.repeat(24),
    pair_id: 'pair_generation_1234567890',
    scopes,
    client_id: 'chatgpt-test-client',
    ttlMs: config.oauthAccessTtlMs,
  });
}

async function withMcpServer(t, scopes, { online = true, appList = null, appListError = false } = {}) {
  const config = makeConfig();
  const forwarded = [];
  const skillRuns = [];
  const presenceChecks = [];
  const deviceRelay = {
    presence(deviceId) {
      presenceChecks.push(deviceId);
      return { connected: online, deviceId, sessionEpoch: 1234 };
    },
    claimPairing() { return null; },
    async forwardMcp(request) {
      forwarded.push(request);
      const body = JSON.parse(request.body);
      const name = body.params?.name;
      const appContent = name === 'app.list' && appList !== null
        ? { status: 'OK', apps: appList.apps, count: appList.count ?? appList.apps.length,
          truncated: appList.truncated ?? false }
        : { tool: name, arguments: body.params.arguments ?? {} };
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            resultType: 'complete',
            content: [{ type: 'text', text: `forwarded:${body.params.name}` }],
            structuredContent: appContent,
            isError: name === 'app.list' && appListError,
          },
        }),
      };
    },
  };
  const skillsRuntime = {
    async run(request) {
      skillRuns.push(request);
      return {
        status: 'COMPLETED',
        skill_id: request.skillId,
        output: { source: 'skills-runtime' },
        trace: [],
      };
    },
  };
  const oauth = createOAuthService({ config, deviceRelay });
  const handler = createMcpPluginHandler({ config, oauth, deviceRelay, skillsRuntime });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const token = accessToken(config, scopes);
  const client = new Client(
    { name: 'orremote-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, forwarded, skillRuns, presenceChecks, base, oauth, token };
}

test('unauthenticated standard MCP endpoint advertises OAuth resource metadata', async (t) => {
  const config = makeConfig();
  const deviceRelay = { claimPairing() { return null; }, async forwardMcp() { throw new Error('should not forward'); } };
  const skillsRuntime = { async run() { throw new Error('should not run'); } };
  const oauth = createOAuthService({ config, deviceRelay });
  const handler = createMcpPluginHandler({ config, oauth, deviceRelay, skillsRuntime });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /Bearer/);
  assert.match(response.headers.get('www-authenticate') || '', /oauth-protected-resource/);
});

test('official MCP v2 client discovers eleven Android primitives plus relay skill.run', async (t) => {
  const { client } = await withMcpServer(t, ['android.observe', 'android.control']);
  const list = await client.listTools();
  assert.deepEqual(list.tools.map((tool) => tool.name), [
    'screen.observe', 'ui.click', 'ui.set_text', 'ui.editor_action', 'touch.tap', 'touch.swipe',
    'system.back', 'system.home', 'screen.screenshot', 'app.list', 'app.launch', 'skill.run',
    'orremote.status', 'orremote.observe', 'orremote.list_skills',
    'orremote.run_skill', 'orremote.disconnect', 'orremote.app_list',
  ]);
  assert.equal(list.tools.find((tool) => tool.name === 'screen.observe').annotations?.readOnlyHint, true);
  assert.equal(list.tools.find((tool) => tool.name === 'ui.click').annotations?.readOnlyHint, false);
  assert.equal(list.tools.find((tool) => tool.name === 'skill.run').annotations?.readOnlyHint, false);
});

test('standard primitive tools/call forwards OAuth device and pair claims into Android relay path', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe', 'android.control']);
  const result = await client.callTool({ name: 'screen.observe', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.tool, 'screen.observe');
  assert.equal(forwarded.length, 1);
  assert.equal(skillRuns.length, 0);
  assert.equal(forwarded[0].deviceId, 'a'.repeat(24));
  assert.equal(forwarded[0].pairId, 'pair_generation_1234567890');
  assert.equal(forwarded[0].headers['mcp-protocol-version'], '2026-07-28');
  assert.equal(forwarded[0].headers['mcp-method'], 'tools/call');
  assert.equal(forwarded[0].headers['mcp-name'], 'screen.observe');
});

test('skill.run is executed in relay and is never forwarded as an Android tool', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe', 'android.control']);
  const result = await client.callTool({
    name: 'skill.run',
    arguments: {
      skill_id: 'yandex_pro.planned_slot_orders.read',
      inputs: { date: '2026-09-15' },
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.status, 'COMPLETED');
  assert.equal(result.structuredContent?.output?.source, 'skills-runtime');
  assert.equal(forwarded.length, 0);
  assert.equal(skillRuns.length, 1);
  assert.deepEqual(skillRuns[0], {
    skillId: 'yandex_pro.planned_slot_orders.read',
    inputs: { date: '2026-09-15' },
    deviceId: 'a'.repeat(24),
    pairId: 'pair_generation_1234567890',
  });
});

test('observe-only OAuth token cannot execute a control tool, including skill.run', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe']);
  const click = await client.callTool({
    name: 'ui.click',
    arguments: { expected_revision: 311, selector_kind: 'TEXT', selector_value: 'M3 REMOTE TEST TARGET' },
  });
  assert.equal(click.isError, true);
  assert.match(click.content?.[0]?.text || '', /insufficient_scope/i);

  const skill = await client.callTool({
    name: 'skill.run',
    arguments: { skill_id: 'yandex_pro.planned_slot_orders.read', inputs: { date: '2026-09-15' } },
  });
  assert.equal(skill.isError, true);
  assert.match(skill.content?.[0]?.text || '', /insufficient_scope/i);
  assert.equal(forwarded.length, 0);
  assert.equal(skillRuns.length, 0);
});

test('zero-context status uses only scoped relay presence and never exposes pairing identifiers', async (t) => {
  const { client, forwarded, skillRuns, presenceChecks } = await withMcpServer(t, ['android.observe']);
  const result = await client.callTool({ name: 'orremote.status', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.protocol, 'orremote-agent/1');
  assert.equal(result.structuredContent?.device?.online, true);
  assert.equal(result.structuredContent?.session?.authenticated, true);
  assert.equal(result.structuredContent?.capabilities?.observe, true);
  assert.equal(result.structuredContent?.capabilities?.run_skill, false);
  assert.deepEqual(presenceChecks, ['a'.repeat(24)]);
  assert.equal(forwarded.length, 0);
  assert.equal(skillRuns.length, 0);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /pair_generation_1234567890|aaaaaaaaaaaaaaaaaaaaaaaa|1234/);
});

test('status can report an offline device without forwarding or attempting to re-pair', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe'], { online: false });
  const result = await client.callTool({ name: 'orremote.status', arguments: {} });
  assert.equal(result.structuredContent?.device?.online, false);
  assert.equal(result.structuredContent?.session?.authenticated, true);
  assert.equal(forwarded.length, 0);
  assert.equal(skillRuns.length, 0);
});

test('zero-context list_skills exposes bounded public descriptors without forwarding phone commands', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe']);
  const result = await client.callTool({ name: 'orremote.list_skills', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.protocol, 'orremote-agent/1');
  assert.equal(result.structuredContent?.skills?.length, 8);
  const settings = result.structuredContent.skills.find((skill) => skill.id === 'settings.device_info.read');
  assert.equal(settings.risk, 'R0');
  assert.equal(settings.effect, 'read_only');
  assert.equal(settings.oauth_scope, 'android.control');
  assert.deepEqual(forwarded.map((item) => JSON.parse(item.body).params.name), ['app.list']);
  assert.equal(skillRuns.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /pair_generation_1234567890/);
});

test('zero-context aliases use existing scoped Android primitives and relay skill runtime', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe', 'android.control']);
  for (const [alias, native] of [
    ['orremote.observe', 'screen.observe'],
    ['orremote.app_list', 'app.list'],
  ]) {
    const result = await client.callTool({ name: alias, arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent?.tool, native);
  }
  assert.deepEqual(forwarded.map((item) => JSON.parse(item.body).params.name), ['screen.observe', 'app.list']);
  const result = await client.callTool({
    name: 'orremote.run_skill',
    arguments: { skill_id: 'settings.device_info.read', inputs: {} },
  });
  assert.equal(result.structuredContent?.status, 'COMPLETED');
  assert.deepEqual(skillRuns[0], {
    skillId: 'settings.device_info.read',
    inputs: {},
    deviceId: 'a'.repeat(24),
    pairId: 'pair_generation_1234567890',
  });
});

test('zero-context write alias denies observe-only OAuth without executing or forwarding', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe']);
  const result = await client.callTool({
    name: 'orremote.run_skill',
    arguments: { skill_id: 'settings.device_info.read' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /insufficient_scope/);
  assert.equal(forwarded.length, 0);
  assert.equal(skillRuns.length, 0);
});

test('discovery exports concrete bounded input schemas and provider applicability', async (t) => {
  const { client } = await withMcpServer(t, ['android.observe'], { online: false });
  const result = await client.callTool({ name: 'orremote.list_skills', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.availability_source, 'device_offline');
  assert.equal(result.structuredContent?.skills?.length, 8);
  const settings = result.structuredContent.skills.find((skill) => skill.id === 'settings.device_info.read');
  assert.deepEqual(settings.input_schema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(settings.availability, 'unknown');
  assert.equal(settings.requires_user_takeover, true);
  const yandex = result.structuredContent.skills.find((skill) => skill.id === 'yandex_pro.planned_slot_orders.read');
  assert.equal(yandex.input_schema.properties.date.enum[0], 'today');
  const media = result.structuredContent.skills.find((skill) => skill.id === 'media.discovery.run_plan');
  assert.ok(media.input_schema.properties.provider.enum.includes('yandex_music'));
  assert.ok(media.input_schema.properties.steps);
  assert.ok(media.providers.some((p) => p.id === 'yandex_music' && p.package === 'ru.yandex.music'));
  assert.ok(media.providers.every((p) => p.availability === 'unknown'));
  assert.ok(result.structuredContent.skills.every((skill) => skill.input_schema?.type === 'object'));
});

test('complete Android app inventory makes provider and skill availability factual', async (t) => {
  const { client, forwarded } = await withMcpServer(t, ['android.observe'], {
    appList: { apps: [
      { package: 'com.android.settings', label: 'Secret token 987654321' },
      { package: 'ru.yandex.music', label: 'Yandex Music' },
    ] },
  });
  const result = await client.callTool({ name: 'orremote.list_skills', arguments: {} });
  assert.equal(result.structuredContent?.availability_source, 'android_app_list');
  const settings = result.structuredContent.skills.find((skill) => skill.id === 'settings.device_info.read');
  assert.equal(settings.availability, 'available');
  const files = result.structuredContent.skills.find((skill) => skill.id === 'files.downloads.apks.read');
  assert.equal(files.availability, 'unavailable');
  const media = result.structuredContent.skills.find((skill) => skill.id === 'media.discovery.run_plan');
  assert.equal(media.availability, 'available');
  assert.equal(media.providers.find((p) => p.id === 'yandex_music').availability, 'available');
  assert.equal(media.providers.find((p) => p.id === 'kinopoisk').availability, 'unavailable');
  assert.deepEqual(forwarded.map((item) => JSON.parse(item.body).params.name), ['app.list']);
  assert.doesNotMatch(JSON.stringify(result), /Secret token|987654321|pair_generation_1234567890/);
});

test('truncated app inventory never treats absence as a proven uninstalled package', async (t) => {
  const { client } = await withMcpServer(t, ['android.observe'], {
    appList: { apps: [{ package: 'ru.yandex.music' }], count: 200, truncated: true },
  });
  const result = await client.callTool({ name: 'orremote.list_skills', arguments: {} });
  assert.equal(result.structuredContent.availability_source, 'android_app_list_truncated');
  const media = result.structuredContent.skills.find((skill) => skill.id === 'media.discovery.run_plan');
  assert.equal(media.providers.find((p) => p.id === 'yandex_music').availability, 'available');
  assert.equal(media.providers.find((p) => p.id === 'kinopoisk').availability, 'unknown');
  assert.equal(result.structuredContent.skills.find((skill) => skill.id === 'files.downloads.apks.read').availability, 'unknown');
});

test('Android app inventory error does not become false unavailable and cannot initiate a write', async (t) => {
  const { client, forwarded, skillRuns } = await withMcpServer(t, ['android.observe'], { appListError: true });
  const result = await client.callTool({ name: 'orremote.list_skills', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.availability_source, 'unverified');
  assert.ok(result.structuredContent.skills.every((skill) => skill.availability === 'unknown'));
  assert.deepEqual(forwarded.map((item) => JSON.parse(item.body).params.name), ['app.list']);
  assert.equal(skillRuns.length, 0);
});

test('offline discovery does not forward app-list or require pairing', async (t) => {
  const { client, forwarded } = await withMcpServer(t, ['android.observe'], { online: false });
  const result = await client.callTool({ name: 'orremote.list_skills', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.availability_source, 'device_offline');
  assert.equal(forwarded.length, 0);
});

test('independent MCP SDK client uses a real OAuth grant that becomes invalid after self-revocation', async (t) => {
  const cfg = {
    ...makeConfig(),
    allowedClientId: 'https://agent.test/client.json',
    allowedRedirectUris: ['https://agent.test/callback'],
  };
  const verifier = 'independent-client-pkce-verifier-abcdefghijklmnopqrstuvwxyz';
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const deviceRelay = {
    claimPairing(code) {
      assert.equal(code, '12345678');
      return { deviceId: 'a'.repeat(24), pairId: 'pair_generation_1234567890' };
    },
    presence() { return { connected: true, sessionEpoch: 1 }; },
    async forwardMcp() { throw new Error('not requested by read-only connection test'); },
  };
  const oauth = createOAuthService({ config: cfg, deviceRelay });
  const redirect = new URL(oauth.completeAuthorization({
    request: {
      clientId: cfg.allowedClientId, redirectUri: cfg.allowedRedirectUris[0],
      resource: cfg.mcpResource, scopes: ['android.observe'],
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    },
    pairingCode: '12345678',
  }));
  const tokens = oauth.exchangeAuthorizationCode({
    code: redirect.searchParams.get('code'), codeVerifier: verifier,
    clientId: cfg.allowedClientId, redirectUri: cfg.allowedRedirectUris[0],
    resource: cfg.mcpResource,
  });
  const handler = createMcpPluginHandler({ config: cfg, oauth, deviceRelay });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'independent-mcp-agent', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { authorization: 'Bearer ' + tokens.access_token } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const reply = await client.callTool({ name: 'orremote.status', arguments: {} });
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent?.device?.online, true);
  assert.equal(reply.structuredContent?.capabilities?.run_skill, false);

  assert.equal(oauth.revokeToken({
    token: tokens.refresh_token, clientId: cfg.allowedClientId,
  }), true);
  const blocked = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tokens.access_token,
      'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
  });
  assert.equal(blocked.status, 401);
});

test('user-confirmed MCP disconnect revokes only invoking agent grant and preserves phone pairing', async (t) => {
  const { client, oauth, token, forwarded, skillRuns } = await withMcpServer(t, ['android.observe']);
  const listed = await client.listTools();
  const tool = listed.tools.find((entry) => entry.name === 'orremote.disconnect');
  assert.ok(tool, 'disconnection must be discoverable to a newly connected agent');
  assert.equal(tool.annotations?.destructiveHint, true);
  const denied = await client.callTool({ name: 'orremote.disconnect', arguments: { confirm: false } });
  assert.equal(denied.isError, true);
  assert.ok(oauth.verifyAccessToken(token));
  const confirmed = await client.callTool({ name: 'orremote.disconnect', arguments: { confirm: true } });
  assert.equal(confirmed.isError, false);
  assert.equal(confirmed.structuredContent.status, 'DISCONNECTED');
  assert.equal(oauth.verifyAccessToken(token), null);
  assert.equal(forwarded.length, 0);
  assert.equal(skillRuns.length, 0);
});
