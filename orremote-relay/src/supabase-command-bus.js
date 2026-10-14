import { getRelaySkillsRuntime } from './skills/index.js';

const ANDROID_TOOLS = new Set([
  'screen.observe',
  'ui.click',
  'ui.set_text',
  'ui.editor_action',
  'touch.tap',
  'touch.swipe',
  'system.back',
  'system.home',
  'screen.screenshot',
  'app.list',
  'app.launch',
]);

const ALLOWED_TOOLS = new Set([...ANDROID_TOOLS, 'skill.run']);
const CODEMAGIC_BUILD_URL = 'https://api.codemagic.io/builds';
const CODEMAGIC_ALLOWED_BRANCH = 'ci/android-build';
const RELEASE_TAG_PREFIX = 'refs/tags/orremote/android/';

function asObject(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return { raw_body: String(text || '') };
  }
}

function releaseTagName(tagRef) {
  const value = String(tagRef || '');
  if (!value.startsWith(RELEASE_TAG_PREFIX) || value.length <= RELEASE_TAG_PREFIX.length) {
    const error = new Error('RELEASE_TAG_INVALID');
    error.code = 'RELEASE_TAG_INVALID';
    throw error;
  }
  return value.slice('refs/tags/'.length);
}

function releaseSourceSha(value) {
  const sha = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    const error = new Error('RELEASE_SOURCE_SHA_INVALID');
    error.code = 'RELEASE_SOURCE_SHA_INVALID';
    throw error;
  }
  return sha;
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
  onM8Metric = (metric) => console.info('Ø Remote M8 bus timing', JSON.stringify(metric)),
}) {
  const enabled = Boolean(
    config.supabaseUrl
    && config.supabasePublishableKey
    && config.orremoteBusSecret,
  );
  const releaseBuildEnabled = Boolean(
    enabled
    && config.codemagicApiToken
    && config.releaseGithubToken,
  );
  let stopped = false;
  const laneTimers = new Map();
  const activeLanes = new Set();

  function resolveSkillsRuntime() {
    return skillsRuntime || getRelaySkillsRuntime(deviceRelay);
  }

  async function rpc(name, body) {
    if (!enabled) throw new Error('SUPABASE_BUS_DISABLED');
    // A stalled claim/completion request must not block the command queue forever.
    // Abort the transport AND race the deadline: injected fetch clients may ignore abort.
    const configuredDeadline = Number(config.orremoteBusRpcTimeoutMs);
    const deadlineMs = Number.isFinite(configuredDeadline) && configuredDeadline > 0
      ? Math.min(30_000, Math.max(1, Math.floor(configuredDeadline)))
      : 10_000;
    const controller = new AbortController();
    let timeoutHandle = null;
    const deadline = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        const error = new Error('SUPABASE_BUS_RPC_TIMEOUT');
        error.code = 'SUPABASE_BUS_RPC_TIMEOUT';
        reject(error);
      }, deadlineMs);
    });
    let response;
    let text;
    try {
      ({ response, text } = await Promise.race([
        (async () => {
          const result = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: {
              apikey: config.supabasePublishableKey,
              authorization: `Bearer ${config.supabasePublishableKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          return { response: result, text: await result.text() };
        })(),
        deadline,
      ]));
    } finally {
      clearTimeout(timeoutHandle);
    }
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

  async function failCiRequest(requestId, error) {
    return rpc('orremote_fail_ci_request', {
      p_bus_secret: config.orremoteBusSecret,
      p_request_id: requestId,
      p_error: {
        code: String(error?.code || 'CODEMAGIC_BUILD_FAILED'),
        message: String(error?.message || error || 'CODEMAGIC_BUILD_FAILED'),
      },
    });
  }

  async function failReleaseBuildRequest(requestId, error) {
    return rpc('orremote_fail_release_build_request', {
      p_bus_secret: config.orremoteBusSecret,
      p_request_id: requestId,
      p_error: {
        code: String(error?.code || 'RELEASE_BUILD_FAILED'),
        message: String(error?.message || error || 'RELEASE_BUILD_FAILED'),
      },
    });
  }

  async function githubRequest(path, options = {}) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${config.releaseGithubToken}`,
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const body = text ? asObject(text) : {};
    return { response, body };
  }

  async function ensureReleaseTag(request) {
    const sourceRepo = String(request.source_repo || '');
    const sourceSha = releaseSourceSha(request.source_sha);
    const tagName = releaseTagName(request.tag_ref);
    if (sourceRepo !== config.releaseSourceRepo) {
      const error = new Error('RELEASE_SOURCE_REPO_NOT_ALLOWED');
      error.code = 'RELEASE_SOURCE_REPO_NOT_ALLOWED';
      throw error;
    }
    const [owner, repository, extra] = sourceRepo.split('/');
    if (!owner || !repository || extra) {
      const error = new Error('RELEASE_SOURCE_REPO_INVALID');
      error.code = 'RELEASE_SOURCE_REPO_INVALID';
      throw error;
    }
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const create = await githubRequest(`${repoPath}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: request.tag_ref, sha: sourceSha }),
    });
    if (!create.response.ok && create.response.status !== 422) {
      const error = new Error(`GITHUB_TAG_CREATE_HTTP_${create.response.status}`);
      error.code = `GITHUB_TAG_CREATE_HTTP_${create.response.status}`;
      throw error;
    }
    const ref = await githubRequest(`${repoPath}/git/ref/${encodeURIComponent(`tags/${tagName}`)}`);
    if (!ref.response.ok || ref.body?.object?.type !== 'commit' || String(ref.body?.object?.sha || '').toLowerCase() !== sourceSha) {
      const error = new Error('RELEASE_TAG_TARGET_MISMATCH');
      error.code = 'RELEASE_TAG_TARGET_MISMATCH';
      throw error;
    }
    return { sourceSha, tagName };
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
    const startedAtMs = performance.now();
    let transportMs = null;
    // Only allow an opaque UUID and the known tool name into timing logs.
    // Never log device/pair identifiers, request bodies, selectors or screen content.
    const commandId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(command.command_id || ''))
      ? String(command.command_id) : null;
    const record = (metric) => {
      try { onM8Metric?.({ command_id: commandId, tool: command.tool_name, ...metric }); } catch {}
    };
    try {
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
        traceId: commandId,
        headers: {
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': command.tool_name,
          'content-type': 'application/json',
        },
        body: requestBody,
      });
      transportMs = Math.round(performance.now() - startedAtMs);
      await completeCommand(
        command.command_id,
        Number(forwarded.status || 200),
        asObject(forwarded.body),
      );
      record({
        outcome: 'completed',
        transport_ms: transportMs,
        persist_ms: Math.round(performance.now() - startedAtMs - transportMs),
      });
    } catch (error) {
      const code = String(error?.code || '');
      record({
        outcome: 'failed',
        phase: transportMs === null ? 'transport' : 'persist',
        failure_code: ['DEVICE_OFFLINE', 'DEVICE_DISCONNECTED', 'DEVICE_TIMEOUT', 'SESSION_SUPERSEDED', 'DEVICE_SEND_FAILED'].includes(code) ? code : 'OTHER',
        elapsed_ms: Math.round(performance.now() - startedAtMs),
      });
      throw error; // Existing fail-once / no-replay behavior is unchanged.
    }
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

  async function processCiOnce() {
    if (!enabled || !config.codemagicApiToken) return 'disabled';
    const rows = await rpc('orremote_claim_ci_request', {
      p_bus_secret: config.orremoteBusSecret,
    });
    if (!Array.isArray(rows) || rows.length === 0) return 'idle';
    const request = rows[0];
    let acceptedBuildId = null;

    try {
      const branch = String(request.branch || '');
      const workflowId = String(request.workflow_id || '');
      const expectedCommit = String(request.expected_commit || '');
      if (branch !== CODEMAGIC_ALLOWED_BRANCH) {
        const error = new Error('CODEMAGIC_BRANCH_NOT_ALLOWED');
        error.code = 'CODEMAGIC_BRANCH_NOT_ALLOWED';
        throw error;
      }
      if (workflowId !== config.codemagicWorkflowId) {
        const error = new Error('CODEMAGIC_WORKFLOW_NOT_ALLOWED');
        error.code = 'CODEMAGIC_WORKFLOW_NOT_ALLOWED';
        throw error;
      }

      const response = await fetchImpl(CODEMAGIC_BUILD_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-token': config.codemagicApiToken,
        },
        body: JSON.stringify({
          appId: config.codemagicAppId,
          workflowId,
          branch,
          labels: expectedCommit ? ['orremote-ci-queue', `commit:${expectedCommit}`] : ['orremote-ci-queue'],
        }),
      });
      const text = await response.text();
      const parsed = text ? asObject(text) : {};
      if (!response.ok) {
        const error = new Error(`CODEMAGIC_BUILD_HTTP_${response.status}`);
        error.code = `CODEMAGIC_BUILD_HTTP_${response.status}`;
        throw error;
      }
      const buildId = String(parsed?.buildId || '');
      if (!buildId) {
        const error = new Error('CODEMAGIC_BUILD_ID_MISSING');
        error.code = 'CODEMAGIC_BUILD_ID_MISSING';
        throw error;
      }
      acceptedBuildId = buildId;
      await rpc('orremote_start_ci_request', {
        p_bus_secret: config.orremoteBusSecret,
        p_request_id: request.request_id,
        p_build_id: buildId,
      });
      return 'started';
    } catch (error) {
      if (acceptedBuildId) {
        // Codemagic accepted the build. A lost Supabase handoff ACK is not
        // evidence that the build failed; preserve the claimed record for
        // explicit reconciliation instead of publishing a false failed state.
        console.error('CI build accepted; Supabase start acknowledgement uncertain');
        return 'handoff_ambiguous';
      }
      await failCiRequest(request.request_id, error);
      return 'failed';
    }
  }

  async function processReleaseBuildOnce() {
    if (!releaseBuildEnabled) return 'disabled';
    const rows = await rpc('orremote_claim_release_build_request', {
      p_bus_secret: config.orremoteBusSecret,
    });
    if (!Array.isArray(rows) || rows.length === 0) return 'idle';
    const request = rows[0];
    let acceptedBuildId = null;
    try {
      const requestId = String(request.request_id || '');
      if (!requestId) {
        const error = new Error('RELEASE_REQUEST_ID_MISSING');
        error.code = 'RELEASE_REQUEST_ID_MISSING';
        throw error;
      }
      if (String(request.workflow_id || '') !== config.codemagicWorkflowId) {
        const error = new Error('CODEMAGIC_WORKFLOW_NOT_ALLOWED');
        error.code = 'CODEMAGIC_WORKFLOW_NOT_ALLOWED';
        throw error;
      }
      const { sourceSha, tagName } = await ensureReleaseTag(request);
      let response;
      try {
        response = await fetchImpl(CODEMAGIC_BUILD_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-auth-token': config.codemagicApiToken,
          },
          body: JSON.stringify({
            appId: config.codemagicAppId,
            workflowId: config.codemagicWorkflowId,
            tag: tagName,
            environment: {
              variables: {
                ORREMOTE_EXPECTED_COMMIT: sourceSha,
                ORREMOTE_RELEASE_REQUEST_ID: requestId,
                ORREMOTE_RELEASE_TAG: tagName,
              },
            },
            labels: ['orremote-release', `request:${requestId}`, `commit:${sourceSha}`, `tag:${tagName}`],
          }),
        });
      } catch (cause) {
        const error = new Error('CODEMAGIC_BUILD_POST_AMBIGUOUS');
        error.code = 'CODEMAGIC_BUILD_POST_AMBIGUOUS';
        error.cause = cause;
        throw error;
      }
      const text = await response.text();
      const parsed = text ? asObject(text) : {};
      if (!response.ok) {
        const error = new Error(`CODEMAGIC_BUILD_HTTP_${response.status}`);
        error.code = `CODEMAGIC_BUILD_HTTP_${response.status}`;
        throw error;
      }
      const buildId = String(parsed?.buildId || '');
      if (!buildId) {
        const error = new Error('CODEMAGIC_BUILD_ID_MISSING');
        error.code = 'CODEMAGIC_BUILD_ID_MISSING';
        throw error;
      }
      acceptedBuildId = buildId;
      await rpc('orremote_start_release_build_request', {
        p_bus_secret: config.orremoteBusSecret,
        p_request_id: requestId,
        p_build_id: buildId,
        p_source_sha: sourceSha,
        p_tag_ref: request.tag_ref,
      });
      return 'started';
    } catch (error) {
      if (acceptedBuildId) {
        console.error('Release build accepted; Supabase start acknowledgement uncertain');
        return 'handoff_ambiguous';
      }
      await failReleaseBuildRequest(request.request_id, error);
      return 'failed';
    }
  }

  // Each queue has a serial worker, but no queue can block another queue.
  // In particular, a hung artifact/CI request must never starve Android claims.
  const lanes = [
    { name: 'command', worker: processOnce, label: 'command' },
    { name: 'artifact', worker: processArtifactOnce, label: 'artifact' },
    { name: 'ci', worker: processCiOnce, label: 'CI' },
    { name: 'release', worker: processReleaseBuildOnce, label: 'release build' },
  ];

  function scheduleLane(lane, delay) {
    if (!enabled || stopped || laneTimers.has(lane.name) || activeLanes.has(lane.name)) return;
    const timer = setTimeout(async () => {
      laneTimers.delete(lane.name);
      if (stopped || activeLanes.has(lane.name)) return;
      activeLanes.add(lane.name);
      let outcome = 'idle';
      try {
        outcome = await lane.worker();
      } catch (error) {
        console.error(`Supabase ${lane.label} bus poll failed`, error?.message || error);
      } finally {
        activeLanes.delete(lane.name);
        if (!stopped) {
          const idle = outcome === 'idle' || outcome === 'disabled';
          scheduleLane(lane, idle ? (config.orremoteBusPollMs || 1000) : 0);
        }
      }
    }, Math.max(0, delay));
    laneTimers.set(lane.name, timer);
    timer.unref?.();
  }

  function start() {
    if (!enabled || stopped) return;
    for (const lane of lanes) scheduleLane(lane, 0);
  }

  function stop() {
    stopped = true;
    for (const timer of laneTimers.values()) clearTimeout(timer);
    laneTimers.clear();
  }

  return {
    enabled,
    processOnce,
    processArtifactOnce,
    processCiOnce,
    processReleaseBuildOnce,
    registerPair,
    start,
    stop,
  };
}
