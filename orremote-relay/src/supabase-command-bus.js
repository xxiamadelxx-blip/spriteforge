const ALLOWED_TOOLS = new Set([
  'screen.observe', 'ui.click', 'ui.set_text', 'touch.tap', 'touch.swipe',
  'system.back', 'system.home', 'screen.screenshot', 'app.list', 'app.launch',
]);

function asObject(text) {
  try { return JSON.parse(String(text || '')); }
  catch { return { raw_body: String(text || '') }; }
}

export function createSupabaseCommandBus({ config, deviceRelay, fetchImpl = fetch }) {
  const enabled = Boolean(config.supabaseUrl && config.supabasePublishableKey && config.orremoteBusSecret);
  let timer = null;
  let stopped = false;
  let running = false;

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
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
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
    return (await rpc('orremote_register_pair', {
      p_bus_secret: config.orremoteBusSecret,
      p_device_id: deviceId,
      p_pair_id: pairId,
    })) === true;
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

  async function processOnce() {
    if (!enabled) return 'disabled';
    const rows = await rpc('orremote_claim_command', { p_bus_secret: config.orremoteBusSecret });
    if (!Array.isArray(rows) || rows.length === 0) return 'idle';
    const command = rows[0];
    if (!ALLOWED_TOOLS.has(command.tool_name)) {
      await failCommand(command.command_id, { code: 'UNKNOWN_TOOL_CLAIM', message: 'UNKNOWN_TOOL_CLAIM' });
      return 'failed';
    }
    const requestBody = JSON.stringify({
      jsonrpc: '2.0', id: `bus:${command.command_id}`, method: 'tools/call',
      params: { name: command.tool_name, arguments: command.arguments || {} },
    });
    try {
      const forwarded = await deviceRelay.forwardMcp({
        deviceId: command.device_id,
        pairId: command.pair_id,
        headers: {
          'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
          'mcp-name': command.tool_name, 'content-type': 'application/json',
        },
        body: requestBody,
      });
      await rpc('orremote_complete_command', {
        p_bus_secret: config.orremoteBusSecret,
        p_command_id: command.command_id,
        p_result: { http_status: Number(forwarded.status || 200), body: asObject(forwarded.body) },
      });
      return 'completed';
    } catch (error) {
      await failCommand(command.command_id, error);
      return 'failed';
    }
  }

  function schedule(delay) {
    if (!enabled || stopped) return;
    timer = setTimeout(async () => {
      if (running || stopped) return schedule(config.orremoteBusPollMs || 1000);
      running = true;
      let outcome = 'idle';
      try { outcome = await processOnce(); }
      catch (error) { console.error('Supabase command bus poll failed', error?.message || error); }
      finally { running = false; }
      schedule(outcome === 'idle' ? (config.orremoteBusPollMs || 1000) : 0);
    }, Math.max(0, delay));
    timer.unref?.();
  }

  function start() { if (enabled && !timer && !stopped) schedule(0); }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

  return { enabled, processOnce, registerPair, start, stop };
}
