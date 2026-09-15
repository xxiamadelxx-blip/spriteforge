import { getRelaySkillsRuntime } from './skills/index.js';

const ANDROID_TOOLS = new Set([
  'screen.observe',
  'ui.click',
  'ui.set_text',
  'touch.tap',
  'touch.swipe',
  'system.back',
  'system.home',
  'screen.screenshot',
  'app.list',
  'app.launch',
]);

const ALLOWED_TOOLS = new Set([...ANDROID_TOOLS, 'skill.run']);

function asObject(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return { raw_body: String(text || '') };
  }
}

function skillEnvelope(commandId, run) {
  const failed = run?.status !== 'COMPLETED';
  return {
    jsonrpc: '2.0',
    id: `bus:${commandId}`,
    result: {
      resultType: 'complete',
      content: [{
        type: 'text',
        text: failed
          ? `${run?.error_code || 'SKILL_EXECUTION_FAILED'}: ${run?.message || 'Skill stopped.'}`
          : `Skill ${run?.skill_id || ''} completed.`,
      }],
      structuredContent: run,
      isError: failed,
    },
  };
}

export function createSupabaseCommandBus({
  config,
  deviceRelay,
  skillsRuntime = null,
  fetchImpl = fetch,
}) {
  const enabled = Boolean(
    config.supabaseUrl
    && config.supabasePublishableKey
    && config.orremoteBusSecret,
  );
  let timer = null;
  let stopped = false;
  let running = false;

  function resolveSkillsRuntime() {
    return skillsRuntime || getRelaySkillsRuntime(deviceRelay);
  }

  async function rpc(name, body) {
    if (!enabled) throw new Error('SUPABASE_BUS_DISABLED');
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.supabasePublishableKey,
        authorization: `Bearer ${config.supabasePublishableKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!response.ok) {
      const error = new Error(`SUPABASE_RPC_${name.toUpperCase()}_${response.status}`);
      error.status = response.status;
      error.data = parsed;
      throw error;
    }
    return parsed;
  }

  async function registerPair({ deviceId, pairId }) {
    if (!enabled) return false;
    const result = await rpc('orremote_register_pair', {
      p_bus_secret: config.orremoteBusSecret,
      p_device_id: deviceId,
      p_pair_id: pairId,
    });
    return result === true;
  }

  async function failCommand(commandId, error) {
    return rpc('orremote_fail_command', {
      p_bus_secret: config.orremoteBusSecret,
      p_command_id: commandId,
      p_error: {
        code: String(error?.code || 'RELAY_FORWARD_FAILED'),
        message: String(error?.message || error || 'RELAY_FORWARD_FAILED'),
      },
    });
  }

  async function failArtifact(requestId, error) {
    return rpc('orremote_fail_artifact', {
      p_bus_secret: config.orremoteBusSecret,
      p_request_id: requestId,
      p_error: {
        code: String(error?.code || 'ARTIFACT_FORWARD_FAILED'),
        message: String(error?.message || error || 'ARTIFACT_FORWARD_FAILED'),
      },
    });
  }

  async function completeCommand(commandId, httpStatus, body) {
    return rpc('orremote_complete_command', {
      p_bus_secret: config.orremoteBusSecret,
      p_command_id: commandId,
      p_result: {
        http_status: Number(httpStatus || 200),
        body,
      },
    });
  }

  async function processSkillCommand(command) {
    const runtime = resolveSkillsRuntime();
    if (!runtime || typeof runtime.run !== 'function') {
      const error = new Error('SKILL_RUNTIME_UNAVAILABLE');
      error.code = 'SKILL_RUNTIME_UNAVAILABLE';
      throw error;
    }
    const args = command.arguments && typeof command.arguments === 'object' ? command.arguments : {};
    const run = await runtime.run({
      skillId: String(args.skill_id || ''),
      inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
      deviceId: command.device_id,
      pairId: command.pair_id,
    });
    await completeCommand(command.command_id, 200, skillEnvelope(command.command_id, run));
  }

  async function processAndroidCommand(command) {
    const requestBody = JSON.stringify({
      jsonrpc: '2.0',
      id: `bus:${command.command_id}`,
      method: 'tools/call',
      params: {
        name: command.tool_name,
        arguments: command.arguments || {},
      },
    });
    const forwarded = await deviceRelay.forwardMcp({
      deviceId: command.device_id,
      pairId: command.pair_id,
      headers: {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': command.tool_name,
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    await completeCommand(
      command.command_id,
      Number(forwarded.status || 200),
      asObject(forwarded.body),
    );
  }

  async function processOnce() {
    if (!enabled) return 'disabled';
    const rows = await rpc('orremote_claim_command', {
      p_bus_secret: config.orremoteBusSecret,
    });
    if (!Array.isArray(rows) || rows.length === 0) return 'idle';
    const command = rows[0];
    if (!ALLOWED_TOOLS.has(command.tool_name)) {
      await failCommand(command.command_id, { code: 'UNKNOWN_TOOL_CLAIM', message: 'UNKNOWN_TOOL_CLAIM' });
      return 'failed';
    }

    try {
      if (command.tool_name === 'skill.run') {
        await processSkillCommand(command);
      } else if (ANDROID_TOOLS.has(command.tool_name)) {
        await processAndroidCommand(command);
      } else {
        const error = new Error('UNKNOWN_TOOL_CLAIM');
        error.code = 'UNKNOWN_TOOL_CLAIM';
        throw error;
      }
      return 'completed';
    } catch (error) {
      await failCommand(command.command_id, error);
      return 'failed';
    }
  }

  async function processArtifactOnce() {
    if (!enabled) return 'disabled';
    const rows = await rpc('orremote_claim_artifact', {
      p_bus_secret: config.orremoteBusSecret,
    });
    if (!Array.isArray(rows) || rows.length === 0) return 'idle';
    const request = rows[0];

    try {
      const artifact = await deviceRelay.requestArtifact({
        deviceId: request.device_id,
        pairId: request.pair_id,
        artifactId: String(request.artifact_id || ''),
      });
      await rpc('orremote_complete_artifact', {
        p_bus_secret: config.orremoteBusSecret,
        p_request_id: request.request_id,
        p_result: {
          artifact_id: artifact.artifactId,
          mime_type: artifact.mimeType,
          byte_size: artifact.byteSize,
          sha256: artifact.sha256,
          expires_at: new Date(artifact.expiresAt).toISOString(),
          download_url: `${config.publicOrigin}/artifacts/${encodeURIComponent(artifact.downloadToken)}`,
        },
      });
      return 'completed';
    } catch (error) {
      await failArtifact(request.request_id, error);
      return 'failed';
    }
  }

  function schedule(delay) {
    if (!enabled || stopped) return;
    timer = setTimeout(async () => {
      if (running || stopped) return schedule(config.orremoteBusPollMs || 1000);
      running = true;
      let commandOutcome = 'idle';
      let artifactOutcome = 'idle';
      try {
        commandOutcome = await processOnce();
      } catch (error) {
        console.error('Supabase command bus poll failed', error?.message || error);
      }
      try {
        artifactOutcome = await processArtifactOnce();
      } catch (error) {
        console.error('Supabase artifact bus poll failed', error?.message || error);
      } finally {
        running = false;
      }
      const bothIdle = commandOutcome === 'idle' && artifactOutcome === 'idle';
      schedule(bothIdle ? (config.orremoteBusPollMs || 1000) : 0);
    }, Math.max(0, delay));
    timer.unref?.();
  }

  function start() {
    if (!enabled || timer || stopped) return;
    schedule(0);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    enabled,
    processOnce,
    processArtifactOnce,
    registerPair,
    start,
    stop,
  };
}
