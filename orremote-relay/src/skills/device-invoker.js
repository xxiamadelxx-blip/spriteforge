import crypto from 'node:crypto';

function protocolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { status: 'ERROR', error_code: 'DEVICE_PROTOCOL_ERROR', message },
    isError: true,
  };
}

export function createDevicePrimitiveInvoker(deviceRelay) {
  if (!deviceRelay || typeof deviceRelay.forwardMcp !== 'function') {
    throw new Error('deviceRelay.forwardMcp is required');
  }

  return async function invokePrimitive(name, args = {}, context = {}) {
    const requestId = crypto.randomUUID();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const remote = await deviceRelay.forwardMcp({
      deviceId: context.deviceId,
      pairId: context.pairId,
      headers: {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
        'content-type': 'application/json',
      },
      body,
    });

    let envelope;
    try {
      envelope = JSON.parse(String(remote?.body || ''));
    } catch {
      return protocolError(`Android returned non-JSON response (HTTP ${remote?.status ?? 'unknown'}).`);
    }

    if (envelope?.error) {
      const data = envelope.error.data && typeof envelope.error.data === 'object'
        ? envelope.error.data
        : {};
      const errorCode = String(envelope.error.message || envelope.error.code || 'DEVICE_MCP_ERROR');
      return {
        content: [{ type: 'text', text: errorCode }],
        structuredContent: {
          status: 'ERROR',
          error_code: errorCode,
          message: errorCode,
          ...data,
        },
        isError: true,
      };
    }

    const result = envelope?.result;
    if (!result || typeof result !== 'object') {
      return protocolError('Android MCP response did not contain result.');
    }

    return {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : {},
      isError: Boolean(result.isError) || Number(remote?.status || 200) >= 400,
      ...(result._meta && typeof result._meta === 'object' ? { _meta: result._meta } : {}),
    };
  };
}
