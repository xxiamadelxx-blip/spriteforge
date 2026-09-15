import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevicePrimitiveInvoker } from '../src/skills/device-invoker.js';

test('skills primitive adapter forwards ordinary Android MCP tools with device and pair binding', async () => {
  const forwarded = [];
  const invoke = createDevicePrimitiveInvoker({
    async forwardMcp(request) {
      forwarded.push(request);
      const body = JSON.parse(request.body);
      return {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { status: 'OK', revision: 12 },
            isError: false,
          },
        }),
      };
    },
  });

  const result = await invoke(
    'screen.observe',
    {},
    { deviceId: 'a'.repeat(24), pairId: 'pair-generation-test' },
  );

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.revision, 12);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].deviceId, 'a'.repeat(24));
  assert.equal(forwarded[0].pairId, 'pair-generation-test');
  const body = JSON.parse(forwarded[0].body);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'screen.observe');
});

test('Android MCP error is normalized without throwing away authorization data', async () => {
  const invoke = createDevicePrimitiveInvoker({
    async forwardMcp() {
      return {
        status: 403,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'x',
          error: {
            code: -32043,
            message: 'USER_AUTH_REQUIRED',
            data: { authorization_required: true, user_only: true },
          },
        }),
      };
    },
  });

  const result = await invoke('ui.click', {}, { deviceId: 'd', pairId: 'p' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'USER_AUTH_REQUIRED');
  assert.equal(result.structuredContent.authorization_required, true);
  assert.equal(result.structuredContent.user_only, true);
});
