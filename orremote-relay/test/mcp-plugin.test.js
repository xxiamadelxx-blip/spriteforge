import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createCredential } from '../src/credentials.js';
import { createOAuthService } from '../src/oauth.js';
import { createMcpPluginHandler } from '../src/mcp-plugin.js';

function makeConfig() {
  return { publicOrigin: 'http://127.0.0.1', oauthIssuer: 'http://127.0.0.1', mcpResource: 'http://127.0.0.1/mcp', relayTokenSecret: 'm'.repeat(48), oauthAccessTtlMs: 10 * 60 * 1000, oauthRefreshTtlMs: 30 * 24 * 60 * 60 * 1000, oauthCodeTtlMs: 5 * 60 * 1000, maxBodyBytes: 1024 * 1024 };
}
function accessToken(config, scopes) {
  return createCredential(config, { kind: 'oauth_access', iss: config.oauthIssuer, aud: config.mcpResource, device_id: 'a'.repeat(24), pair_id: 'pair_generation_1234567890', scopes, client_id: 'chatgpt-test-client', ttlMs: config.oauthAccessTtlMs });
}
async function withMcpServer(t, scopes) {
  const config = makeConfig(); const forwarded = [];
  const deviceRelay = {
    claimPairing() { return null; },
    async forwardMcp(request) {
      forwarded.push(request); const body = JSON.parse(request.body);
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', content: [{ type: 'text', text: `forwarded:${body.params.name}` }], structuredContent: { tool: body.params.name, arguments: body.params.arguments ?? {} }, isError: false } }) };
    },
  };
  const oauth = createOAuthService({ config, deviceRelay });
  const handler = createMcpPluginHandler({ config, oauth, deviceRelay });
  const server = http.createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const address = server.address(); const base = `http://127.0.0.1:${address.port}`; const token = accessToken(config, scopes);
  const client = new Client({ name: 'orremote-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport); t.after(() => client.close()); return { client, forwarded, base };
}

test('unauthenticated standard MCP endpoint advertises OAuth resource metadata', async (t) => {
  const config = makeConfig(); const deviceRelay = { claimPairing() { return null; }, async forwardMcp() { throw new Error('should not forward'); } };
  const oauth = createOAuthService({ config, deviceRelay }); const handler = createMcpPluginHandler({ config, oauth, deviceRelay }); const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close()); const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }) });
  assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate') || '', /Bearer/); assert.match(response.headers.get('www-authenticate') || '', /oauth-protected-resource/);
});

test('official MCP v2 client discovers exactly the ten verified Android tools', async (t) => {
  const { client } = await withMcpServer(t, ['android.observe', 'android.control']); const list = await client.listTools();
  assert.deepEqual(list.tools.map((tool) => tool.name), ['screen.observe','ui.click','ui.set_text','touch.tap','touch.swipe','system.back','system.home','screen.screenshot','app.list','app.launch']);
  assert.equal(list.tools.find((tool) => tool.name === 'screen.observe').annotations?.readOnlyHint, true); assert.equal(list.tools.find((tool) => tool.name === 'ui.click').annotations?.readOnlyHint, false);
});

test('standard tools/call forwards OAuth device and pair claims into the existing Android relay path', async (t) => {
  const { client, forwarded } = await withMcpServer(t, ['android.observe', 'android.control']); const result = await client.callTool({ name: 'screen.observe', arguments: {} });
  assert.equal(result.isError, false); assert.equal(result.structuredContent?.tool, 'screen.observe'); assert.equal(forwarded.length, 1); assert.equal(forwarded[0].deviceId, 'a'.repeat(24)); assert.equal(forwarded[0].pairId, 'pair_generation_1234567890');
  assert.equal(forwarded[0].headers['mcp-protocol-version'], '2026-07-28'); assert.equal(forwarded[0].headers['mcp-method'], 'tools/call'); assert.equal(forwarded[0].headers['mcp-name'], 'screen.observe');
});

test('observe-only OAuth token cannot execute a control tool or reach Android', async (t) => {
  const { client, forwarded } = await withMcpServer(t, ['android.observe']);
  const result = await client.callTool({ name: 'ui.click', arguments: { expected_revision: 311, selector_kind: 'TEXT', selector_value: 'M3 REMOTE TEST TARGET' } });
  assert.equal(result.isError, true); assert.match(result.content?.[0]?.text || '', /insufficient_scope/i); assert.equal(forwarded.length, 0);
});
