import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import * as deviceRelayModule from '../src/device-relay.js';

const token = 'x'.repeat(48);
function config(overrides = {}) {
  return loadConfig({ RELAY_TOKEN_SECRET: token, OREMOTE_TEST_ISOLATED: '1', ...overrides });
}
const request = (tool) => JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} },
});
const headers = (tool) => ({ 'mcp-method': 'tools/call', 'mcp-name': tool });

test('default read-only relay deadline exceeds Android localhost forwarder 15s read deadline', () => {
  const cfg = config();
  assert.equal(cfg.mcpTimeoutMs, 15_000);
  assert.equal(cfg.mcpReadOnlyTimeoutMs, 23_000);
});

test('read-only tool calls use the distinct bounded deadline without changing write timeout', () => {
  const select = deviceRelayModule.selectDeviceMcpTimeoutMs;
  assert.equal(typeof select, 'function', 'relay exports its trusted MCP deadline policy');
  const cfg = config();
  for (const name of ['screen.observe', 'app.list']) {
    assert.equal(select({ config: cfg, headers: headers(name), body: request(name) }), 23_000);
  }
  for (const name of ['ui.click', 'ui.set_text', 'touch.tap', 'app.launch', 'screen.screenshot', 'skill.run']) {
    assert.equal(select({ config: cfg, headers: headers(name), body: request(name) }), 15_000);
  }
});

test('spoofed headers and malformed or non-tool calls cannot receive read-only deadline', () => {
  const select = deviceRelayModule.selectDeviceMcpTimeoutMs;
  assert.equal(typeof select, 'function');
  const cfg = config();
  assert.equal(select({ config: cfg, headers: headers('screen.observe'), body: request('ui.click') }), 15_000);
  assert.equal(select({ config: cfg, headers: headers('ui.click'), body: request('screen.observe') }), 15_000);
  assert.equal(select({ config: cfg, headers: {}, body: request('screen.observe') }), 15_000);
  assert.equal(select({ config: cfg, headers: headers('screen.observe'), body: '{invalid' }), 15_000);
  assert.equal(select({ config: cfg, headers: headers('screen.observe'), body: JSON.stringify({ method: 'tools/list' }) }), 15_000);
});

test('explicit legitimate timeout overrides cannot shorten an already-longer global deadline', () => {
  const select = deviceRelayModule.selectDeviceMcpTimeoutMs;
  assert.equal(typeof select, 'function');
  const cfg = config({ MCP_TIMEOUT_MS: '30000', MCP_READ_ONLY_TIMEOUT_MS: '16000' });
  assert.equal(select({ config: cfg, headers: headers('screen.observe'), body: request('screen.observe') }), 30_000);
  assert.equal(select({ config: cfg, headers: headers('ui.click'), body: request('ui.click') }), 30_000);
});

test('finite environment override chooses custom read-only deadline', () => {
  const select = deviceRelayModule.selectDeviceMcpTimeoutMs;
  assert.equal(typeof select, 'function');
  const cfg = config({ MCP_READ_ONLY_TIMEOUT_MS: '21000' });
  assert.equal(select({ config: cfg, headers: headers('app.list'), body: request('app.list') }), 21_000);
  assert.equal(select({ config: cfg, headers: headers('ui.click'), body: request('ui.click') }), 15_000);
});
