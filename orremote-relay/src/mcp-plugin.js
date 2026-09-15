import crypto from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { getRelaySkillsRuntime } from './skills/index.js';
import { TOOLS } from './tool-catalog.js';

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function writeJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function authChallenge(config) {
  return `Bearer resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource/mcp"`;
}

function toolError(message, structuredContent = undefined) {
  return {
    content: [{ type: 'text', text: message }],
    ...(structuredContent && typeof structuredContent === 'object' ? { structuredContent } : {}),
    isError: true,
  };
}

function resultFromAndroid(remote) {
  let envelope;
  try {
    envelope = JSON.parse(remote.body);
  } catch {
    return toolError(`DEVICE_PROTOCOL_ERROR: Android returned non-JSON response (HTTP ${remote.status}).`);
  }

  if (remote.status < 200 || remote.status >= 300 || envelope?.error) {
    const message = envelope?.error?.message || envelope?.error?.code || `Android MCP failed with HTTP ${remote.status}`;
    return toolError(String(message), envelope?.error?.data);
  }

  const result = envelope?.result;
  if (!result || typeof result !== 'object') {
    return toolError('DEVICE_PROTOCOL_ERROR: Android MCP response did not contain result.');
  }

  const content = Array.isArray(result.content) && result.content.length
    ? result.content
    : [{ type: 'text', text: JSON.stringify(result.structuredContent ?? result) }];

  return {
    content,
    ...(result.structuredContent && typeof result.structuredContent === 'object'
      ? { structuredContent: result.structuredContent }
      : {}),
    isError: Boolean(result.isError),
    ...(result._meta && typeof result._meta === 'object' ? { _meta: result._meta } : {}),
  };
}

function resultFromSkill(run) {
  if (!run || typeof run !== 'object') {
    return toolError('SKILL_EXECUTION_FAILED: Skills runtime returned no result.');
  }
  const failed = run.status !== 'COMPLETED';
  const text = failed
    ? `${run.error_code || 'SKILL_EXECUTION_FAILED'}: ${run.message || 'Skill stopped.'}`
    : `Skill ${run.skill_id || ''} completed.`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: run,
    isError: failed,
  };
}

function buildServer({ config, oauth, deviceRelay, skillsRuntime }, requestContext) {
  const token = requestContext?.authInfo?.token || '';
  const claims = oauth.verifyAccessToken(token);
  const server = new McpServer(
    { name: 'orremote-android', version: '0.5.0-m5' },
    { capabilities: { tools: { listChanged: false } } },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: {
          'io.zeroremote/risk': tool.risk,
          'io.zeroremote/permissionScope': tool.permissionScope,
          'io.zeroremote/oauthScope': tool.scope,
          'io.zeroremote/confirmation': 'none',
          'io.zeroremote/timeoutMs': tool.timeoutMs,
        },
      },
      async (arguments_) => {
        if (!claims) return toolError('invalid_token: OAuth access token is missing or expired.');
        if (!Array.isArray(claims.scopes) || !claims.scopes.includes(tool.scope)) {
          return toolError(`insufficient_scope: ${tool.name} requires ${tool.scope}`);
        }

        if (tool.name === 'skill.run') {
          if (!skillsRuntime || typeof skillsRuntime.run !== 'function') {
            return toolError('SKILL_RUNTIME_UNAVAILABLE: relay skills runtime is not configured.');
          }
          try {
            const run = await skillsRuntime.run({
              skillId: String(arguments_?.skill_id || ''),
              inputs: arguments_?.inputs && typeof arguments_.inputs === 'object' ? arguments_.inputs : {},
              deviceId: claims.device_id,
              pairId: claims.pair_id,
            });
            return resultFromSkill(run);
          } catch (error) {
            return toolError(`SKILL_EXECUTION_FAILED: ${error?.message || 'Skill execution failed.'}`);
          }
        }

        const requestId = crypto.randomUUID();
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: 'tools/call',
          params: { name: tool.name, arguments: arguments_ ?? {} },
        });

        try {
          const remote = await deviceRelay.forwardMcp({
            deviceId: claims.device_id,
            pairId: claims.pair_id,
            headers: {
              'mcp-protocol-version': '2026-07-28',
              'mcp-method': 'tools/call',
              'mcp-name': tool.name,
              'content-type': 'application/json',
            },
            body,
          });
          return resultFromAndroid(remote);
        } catch (error) {
          const code = String(error?.code || 'DEVICE_RELAY_ERROR');
          return toolError(`${code}: ${error?.message || code}`);
        }
      },
    );
  }

  return server;
}

export function createMcpPluginHandler({ config, oauth, deviceRelay, skillsRuntime = null }) {
  const resolvedSkillsRuntime = skillsRuntime || getRelaySkillsRuntime(deviceRelay);
  const handler = createMcpHandler(
    (ctx) => buildServer({ config, oauth, deviceRelay, skillsRuntime: resolvedSkillsRuntime }, ctx),
  );
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: config.maxBodyBytes });

  return async function mcpPluginHandler(req, res) {
    let path;
    try {
      path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
      writeJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }
    if (path !== '/mcp') {
      writeJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }

    const token = bearerToken(req);
    const claims = oauth.verifyAccessToken(token);
    if (!claims) {
      writeJson(
        res,
        401,
        { error: 'invalid_token' },
        { 'www-authenticate': authChallenge(config) },
      );
      return;
    }

    req.auth = {
      token,
      clientId: String(claims.client_id || ''),
      scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
      expiresAt: claims.exp,
    };
    await nodeHandler(req, res);
  };
}
