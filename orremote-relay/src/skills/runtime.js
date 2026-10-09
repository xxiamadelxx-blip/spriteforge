import { randomUUID } from 'node:crypto';
import {
  TRI_STATE,
  evaluatePostconditionBaseline,
  evaluatePostconditionTransition,
  validatePostcondition,
} from './postconditions.js';

const DEFAULT_LIMITS = Object.freeze({
  maxTransitions: 80,
  maxStaleRecoveries: 6,
  maxReadOnlySessionRecoveries: 2,
  deadlineMs: 120_000,
});
const MAX_WAIT_MS = 2_000;
const SESSION_RECOVERY_DELAY_MS = 100;
// Two successive scoped observations must fit real Android/relay latency.
// The old 3s default could admit one TRUE proof yet stop before the second.
const DEFAULT_CONTRACTED_VERIFY = Object.freeze({
  timeoutMs: 20_000,
  pollMs: 500,
});
const MAX_CONTRACTED_VERIFY_OBSERVATIONS = 64;
const DISPLAY_SCOPED_ACTION_PRIMITIVES = new Set([
  'ui.click',
  'ui.set_text',
  'ui.editor_action',
  'touch.tap',
  'touch.swipe',
  'system.back',
]);

function structured(result) {
  if (!result || typeof result !== 'object') return {};
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : result;
}

function isError(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.isError === true) return true;
  const body = structured(result);
  return body.status === 'ERROR' || Boolean(body.error_code);
}

function stopped(errorCode, message, trace, extra = {}) {
  return {
    status: 'STOPPED',
    error_code: errorCode,
    message,
    trace,
    ...extra,
  };
}

function validationResult(value) {
  if (value === true || value == null) return { ok: true };
  if (value === false) return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
  if (typeof value === 'object') return value;
  return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
}

function thrownErrorCode(error) {
  const candidates = [error?.error_code, error?.code, error?.message, error];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return '';
}

function readOnlyObserveRecoveryCode(error) {
  const code = thrownErrorCode(error);
  return code === 'SESSION_SUPERSEDED' || code === 'DEVICE_OFFLINE'
    ? code
    : null;
}

function primitiveForDirective(directive, snapshot) {
  const revision = Number(snapshot?.revision);
  switch (directive?.type) {
    case 'LAUNCH':
      return {
        name: 'app.launch',
        args: { package: String(directive.package || '') },
      };
    case 'CLICK_HANDLE':
      return {
        name: 'ui.click',
        args: {
          expected_revision: revision,
          selector_kind: 'HANDLE',
          selector_value: String(directive.handle || ''),
          exact: true,
        },
      };
    case 'SET_TEXT_HANDLE':
      return {
        name: 'ui.set_text',
        args: {
          expected_revision: revision,
          selector_kind: 'HANDLE',
          selector_value: String(directive.handle || ''),
          exact: true,
          value: String(directive.value ?? ''),
        },
      };
    case 'SUBMIT_EDITOR_HANDLE':
      return {
        name: 'ui.editor_action',
        args: {
          expected_revision: revision,
          selector_kind: 'HANDLE',
          selector_value: String(directive.handle || ''),
          exact: true,
        },
      };
    case 'TAP_POINT': {
      const args = {
        expected_revision: revision,
        x: Number(directive.x),
        y: Number(directive.y),
      };
      const hasGuard = directive.target_handle != null ||
        directive.target_window_id != null ||
        directive.expected_hit_topology_signature != null;
      if (hasGuard) {
        args.target_handle = String(directive.target_handle || '');
        args.target_window_id = Number(directive.target_window_id);
        args.expected_hit_topology_signature = String(directive.expected_hit_topology_signature || '');
      }
      return { name: 'touch.tap', args };
    }
    case 'SWIPE': {
      const args = {
        expected_revision: revision,
        start_x: Number(directive.start_x),
        start_y: Number(directive.start_y),
        end_x: Number(directive.end_x),
        end_y: Number(directive.end_y),
      };
      if (directive.duration_ms != null) args.duration_ms = Number(directive.duration_ms);
      return { name: 'touch.swipe', args };
    }
    case 'BACK':
      return {
        name: 'system.back',
        args: { expected_revision: revision },
      };
    default:
      return null;
  }
}

function hasDeclaredPostcondition(directive) {
  return Object.prototype.hasOwnProperty.call(directive || {}, 'postcondition');
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isUserAuthorizationRequired(snapshot) {
  return snapshot?.authorization_required === true
    || snapshot?.error_code === 'USER_AUTH_REQUIRED'
    || snapshot?.privacy_mode === 'USER_AUTH_REDACTED'
    || snapshot?.redacted === true;
}

function verificationCompleteness(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    semantic_tree_complete: snapshot.semantic_tree_complete === true,
    truncated: snapshot.truncated === true,
  };
}

function dispatchStateFor(primitiveResult) {
  const body = structured(primitiveResult);
  if (body.action_dispatched === true) return 'DISPATCHED';
  if (body.action_dispatched === false) return 'NOT_DISPATCHED';
  return 'UNKNOWN';
}

function primitiveSupportsContractedAttempt(primitive) {
  if (!primitive || primitive.name === 'app.launch') {
    return { ok: false, reason: 'UNGUARDED_PRIMITIVE' };
  }
  if (!isNonNegativeInteger(primitive.args?.expected_revision)) {
    return { ok: false, reason: 'INVALID_EXPECTED_REVISION' };
  }
  if (primitive.name === 'touch.tap') {
    const guarded = typeof primitive.args?.target_handle === 'string'
      && primitive.args.target_handle.length > 0
      && Number.isInteger(primitive.args?.target_window_id)
      && typeof primitive.args?.expected_hit_topology_signature === 'string'
      && primitive.args.expected_hit_topology_signature.length > 0;
    if (!guarded) return { ok: false, reason: 'GUARDED_TAP_REQUIRED' };
  }
  return { ok: true };
}

function verificationLimits(postcondition, { startedAt, deadlineMs, now }) {
  const elapsedMs = Math.max(0, now() - startedAt);
  const remainingMs = Math.max(1, deadlineMs - elapsedMs);
  const declaredTimeoutMs = Number(postcondition.verify?.timeout_ms ?? DEFAULT_CONTRACTED_VERIFY.timeoutMs);
  const declaredPollMs = Number(postcondition.verify?.poll_ms ?? DEFAULT_CONTRACTED_VERIFY.pollMs);
  const timeoutMs = Math.max(1, Math.min(declaredTimeoutMs, remainingMs));
  const minimumBoundedPollMs = Math.max(
    1,
    Math.ceil(timeoutMs / Math.max(1, MAX_CONTRACTED_VERIFY_OBSERVATIONS - 1)),
  );
  const pollMs = Math.max(
    minimumBoundedPollMs,
    Math.min(declaredPollMs, timeoutMs),
  );
  return {
    timeoutMs,
    pollMs,
    maxObservations: Math.max(2, Math.ceil(timeoutMs / pollMs) + 1),
    deadlineAt: now() + timeoutMs,
  };
}

function semanticStopped({
  errorCode,
  message,
  trace,
  state,
  attempt = null,
  dispatchState = 'NOT_DISPATCHED',
  proofRevisions = [],
  predicateReason = null,
}) {
  trace.push({
    type: 'SEMANTIC_RESULT',
    attempt_id: attempt?.id ?? null,
    result: errorCode,
    dispatch_state: dispatchState,
    baseline_revision: attempt?.baselineRevision ?? null,
    proof_revisions: proofRevisions,
    predicate_reason: predicateReason,
  });
  return stopped(errorCode, message, trace, {
    state,
    semantic_result: errorCode,
    attempt_id: attempt?.id ?? null,
    dispatch_state: dispatchState,
    baseline_revision: attempt?.baselineRevision ?? null,
    proof_revisions: proofRevisions,
  });
}

function prepareContractedAttempt({
  directive,
  snapshot,
  primitive,
  startedAt,
  deadlineMs,
  now,
  createAttemptId,
  trace,
  state,
}) {
  const baselineTrace = trace.at(-1);
  if (baselineTrace?.type === 'OBSERVE') {
    baselineTrace.phase = 'BASELINE';
    baselineTrace.display_id = snapshot?.display_id ?? null;
  }
  if (isUserAuthorizationRequired(snapshot)) {
    return {
      stopped: semanticStopped({
        errorCode: 'USER_AUTH_REQUIRED',
        message: 'User authorization is required.',
        trace,
        state,
      }),
    };
  }
  const validation = validatePostcondition(directive.postcondition);
  if (!validation.ok) {
    return {
      stopped: semanticStopped({
        errorCode: 'ACTION_NOT_VERIFIED',
        message: 'Contracted action has an invalid postcondition declaration.',
        trace,
        state,
        predicateReason: 'INVALID_POSTCONDITION',
      }),
    };
  }

  const displayId = snapshot?.display_id;
  const requestedDisplayId = directive.display_id === undefined ? 0 : directive.display_id;
  if (!isNonNegativeInteger(displayId)) {
    return {
      stopped: semanticStopped({
        errorCode: 'ACTION_NOT_VERIFIED',
        message: 'Contracted action requires a valid baseline display id.',
        trace,
        state,
        predicateReason: 'BASELINE_DISPLAY_UNAVAILABLE',
      }),
    };
  }
  if (!isNonNegativeInteger(requestedDisplayId) || requestedDisplayId !== displayId) {
    return {
      stopped: semanticStopped({
        errorCode: 'ACTION_NOT_VERIFIED',
        message: 'Contracted action baseline does not match the declared display.',
        trace,
        state,
        predicateReason: 'BASELINE_DISPLAY_MISMATCH',
      }),
    };
  }

  const binding = primitiveSupportsContractedAttempt(primitive);
  if (!binding.ok) {
    return {
      stopped: semanticStopped({
        errorCode: 'ACTION_NOT_VERIFIED',
        message: 'Contracted action lacks the required revision/guard binding.',
        trace,
        state,
        predicateReason: binding.reason,
      }),
    };
  }
  const explicitlyScopedDisplay = directive.display_id !== undefined;
  if (
    (explicitlyScopedDisplay || requestedDisplayId !== 0)
    && !DISPLAY_SCOPED_ACTION_PRIMITIVES.has(primitive.name)
  ) {
    return {
      stopped: semanticStopped({
        errorCode: 'ACTION_NOT_VERIFIED',
        message: 'Contracted action does not support the declared display.',
        trace,
        state,
        predicateReason: 'DISPLAY_SCOPE_UNSUPPORTED',
      }),
    };
  }
  if (explicitlyScopedDisplay || requestedDisplayId !== 0) {
    primitive.args.display_id = requestedDisplayId;
  }

  const baseline = evaluatePostconditionBaseline(directive.postcondition, snapshot);
  if (baseline?.state === TRI_STATE.TRUE) {
    const preexistingAllowed = directive.postcondition.mode === 'state'
      && directive.postcondition.preexisting_ok === true;
    return {
      preexisting: {
        allowed: preexistingAllowed,
        predicateReason: baseline?.reason ?? 'POSTCONDITION_ALREADY_SATISFIED',
      },
    };
  }
  if (baseline?.can_dispatch !== true) {
    return {
      stopped: semanticStopped({
        errorCode: 'ACTION_NOT_VERIFIED',
        message: 'Contracted action baseline is not decisively usable.',
        trace,
        state,
        predicateReason: baseline?.reason ?? 'BASELINE_UNVERIFIABLE',
      }),
    };
  }

  const id = createAttemptId();
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw new Error('INVALID_ATTEMPT_ID');
  }
  const verify = verificationLimits(directive.postcondition, { startedAt, deadlineMs, now });
  const attempt = {
    id,
    postcondition: directive.postcondition,
    baseline: snapshot,
    baselineRevision: snapshot.revision,
    displayId: requestedDisplayId,
    observeArgs: explicitlyScopedDisplay || requestedDisplayId !== 0
      ? { display_id: requestedDisplayId }
      : {},
    verify,
  };
  trace.push({
    type: 'ATTEMPT',
    attempt_id: attempt.id,
    expected_revision: attempt.baselineRevision,
    display_id: attempt.displayId,
    guarded: primitive.name === 'touch.tap',
  });
  return { attempt };
}

async function verifyContractedAttempt({
  attempt,
  invokePrimitive,
  deviceId,
  pairId,
  skillId,
  state,
  trace,
  now,
  sleep,
  panicSwitch,
}) {
  let lastEvaluation = null;
  let trueStreak = 0;
  let proofRevisions = [];
  for (let index = 0; index < attempt.verify.maxObservations; index += 1) {
    if (index > 0) {
      const remainingMs = attempt.verify.deadlineAt - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(attempt.verify.pollMs, remainingMs));
    }
    if (now() > attempt.verify.deadlineAt) break;
    if (panicSwitch()) return { result: 'PANIC_SWITCH_ACTIVE' };

    let observed;
    try {
      observed = await invokePrimitive(
        'screen.observe',
        attempt.observeArgs,
        { deviceId, pairId, skillId, state, attemptId: attempt.id, verification: true },
      );
    } catch {
      trace.push({
        type: 'VERIFY',
        attempt_id: attempt.id,
        revision: null,
        display_id: null,
        completeness: null,
        predicate_state: TRI_STATE.UNKNOWN,
        predicate_reason: 'OBSERVE_UNAVAILABLE',
      });
      return {
        result: 'ACTION_NOT_VERIFIED',
        predicateReason: 'OBSERVE_UNAVAILABLE',
        proofRevisions,
      };
    }

    const snapshot = structured(observed);
    if (isUserAuthorizationRequired(snapshot)) {
      trace.push({
        type: 'VERIFY',
        attempt_id: attempt.id,
        revision: snapshot.revision ?? null,
        display_id: snapshot.display_id ?? null,
        completeness: verificationCompleteness(snapshot),
        predicate_state: TRI_STATE.UNKNOWN,
        predicate_reason: 'USER_AUTH_REQUIRED',
      });
      return { result: 'USER_AUTH_REQUIRED', proofRevisions };
    }
    if (isError(observed)) {
      trace.push({
        type: 'VERIFY',
        attempt_id: attempt.id,
        revision: snapshot.revision ?? null,
        display_id: snapshot.display_id ?? null,
        completeness: verificationCompleteness(snapshot),
        predicate_state: TRI_STATE.UNKNOWN,
        predicate_reason: 'OBSERVE_FAILED',
      });
      return {
        result: 'ACTION_NOT_VERIFIED',
        predicateReason: 'OBSERVE_FAILED',
        proofRevisions,
      };
    }

    const sameDisplay = isNonNegativeInteger(snapshot.display_id)
      && snapshot.display_id === attempt.displayId;
    const evaluation = sameDisplay
      ? evaluatePostconditionTransition(attempt.postcondition, {
        baseline: attempt.baseline,
        current: snapshot,
      })
      : { state: TRI_STATE.UNKNOWN, reason: 'VERIFY_DISPLAY_MISMATCH' };
    trace.push({
      type: 'VERIFY',
      attempt_id: attempt.id,
      revision: snapshot.revision ?? null,
      display_id: snapshot.display_id ?? null,
      completeness: verificationCompleteness(snapshot),
      predicate_state: evaluation.state,
      predicate_reason: evaluation.reason ?? null,
    });
    lastEvaluation = evaluation;

    if (evaluation.state === TRI_STATE.TRUE) {
      trueStreak += 1;
      proofRevisions.push(snapshot.revision ?? null);
      if (trueStreak === 2) {
        return {
          result: 'VERIFIED',
          predicateReason: evaluation.reason ?? null,
          proofRevisions,
        };
      }
    } else {
      trueStreak = 0;
      proofRevisions = [];
    }
  }

  if (lastEvaluation?.state === TRI_STATE.FALSE) {
    return {
      result: 'POSTCONDITION_NOT_MET',
      predicateReason: lastEvaluation.reason ?? null,
      proofRevisions,
    };
  }
  return {
    result: 'ACTION_NOT_VERIFIED',
    predicateReason: lastEvaluation?.reason ?? 'VERIFY_UNAVAILABLE',
    proofRevisions,
  };
}

export function createSkillRuntime({
  invokePrimitive,
  registry,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  authorizeSkill = null,
  panicSwitch = () => false,
  createAttemptId = () => randomUUID(),
}) {
  if (typeof invokePrimitive !== 'function') throw new Error('invokePrimitive is required');
  if (!registry || typeof registry.get !== 'function') throw new Error('registry is required');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');
  if (authorizeSkill != null && typeof authorizeSkill !== 'function') throw new Error('authorizeSkill must be a function');
  if (typeof panicSwitch !== 'function') throw new Error('panicSwitch must be a function');
  if (typeof createAttemptId !== 'function') throw new Error('createAttemptId must be a function');

  return Object.freeze({
    async run({ skillId, inputs = {}, deviceId = null, pairId = null, limits = {} }) {
      const skill = registry.get(skillId);
      if (!skill) return stopped('SKILL_NOT_FOUND', `Unknown skill: ${skillId}`, []);

      const trace = [];
      if (panicSwitch()) {
        return stopped('PANIC_SWITCH_ACTIVE', 'Skills runtime panic switch is active.', trace);
      }
      if (authorizeSkill) {
        const authorization = validationResult(await authorizeSkill(skill, { inputs, deviceId, pairId }));
        if (!authorization.ok) {
          return stopped(
            String(authorization.code || 'SKILL_POLICY_DENIED'),
            String(authorization.message || 'Skill safety policy denied execution.'),
            trace,
          );
        }
      }

      const effective = {
        maxTransitions: Math.max(1, Number(limits.maxTransitions ?? DEFAULT_LIMITS.maxTransitions)),
        maxStaleRecoveries: Math.max(0, Number(limits.maxStaleRecoveries ?? DEFAULT_LIMITS.maxStaleRecoveries)),
        maxReadOnlySessionRecoveries: Math.max(
          0,
          Number(limits.maxReadOnlySessionRecoveries ?? DEFAULT_LIMITS.maxReadOnlySessionRecoveries),
        ),
        deadlineMs: Math.max(1, Number(limits.deadlineMs ?? DEFAULT_LIMITS.deadlineMs)),
      };
      const context = typeof skill.createContext === 'function'
        ? skill.createContext({ inputs, deviceId, pairId })
        : { inputs };
      const startedAt = now();
      let transitions = 0;
      let staleRecoveries = 0;
      let readOnlySessionRecoveries = 0;

      while (true) {
        if (panicSwitch()) {
          return stopped('PANIC_SWITCH_ACTIVE', 'Skills runtime panic switch is active.', trace);
        }
        if (transitions >= effective.maxTransitions) {
          return stopped(
            'SKILL_TRANSITION_LIMIT',
            `Skill exceeded ${effective.maxTransitions} transitions.`,
            trace,
          );
        }
        if (now() - startedAt > effective.deadlineMs) {
          return stopped('SKILL_DEADLINE_EXCEEDED', 'Skill execution deadline exceeded.', trace);
        }

        let observed;
        try {
          observed = await invokePrimitive('screen.observe', {}, { deviceId, pairId, skillId });
        } catch (error) {
          const recoveryCode = readOnlyObserveRecoveryCode(error);
          if (
            skill?.safety?.effect === 'read_only'
            && recoveryCode != null
            && readOnlySessionRecoveries < effective.maxReadOnlySessionRecoveries
          ) {
            readOnlySessionRecoveries += 1;
            transitions += 1;
            trace.push({
              type: 'RECOVERY',
              recovery: recoveryCode,
              operation: 'screen.observe',
              attempt: readOnlySessionRecoveries,
            });
            await sleep(SESSION_RECOVERY_DELAY_MS);
            continue;
          }
          return stopped(
            'SKILL_OBSERVE_FAILED',
            String(error?.message || error || 'screen.observe failed'),
            trace,
          );
        }
        const snapshot = structured(observed);
        trace.push({ type: 'OBSERVE', revision: snapshot.revision ?? null, package: snapshot.package ?? null });

        if (isUserAuthorizationRequired(snapshot)) {
          return stopped('USER_AUTH_REQUIRED', 'User authorization is required.', trace);
        }
        if (isError(observed)) {
          return stopped(
            String(snapshot.error_code || 'SKILL_OBSERVE_FAILED'),
            String(snapshot.message || 'screen.observe failed'),
            trace,
          );
        }

        let state;
        try {
          state = await skill.recognize(snapshot, context);
        } catch (error) {
          return stopped('SKILL_STATE_RECOGNITION_FAILED', String(error?.message || error), trace);
        }

        let directive;
        try {
          directive = await skill.next({ state, snapshot, context, inputs });
        } catch (error) {
          return stopped('SKILL_PLANNER_FAILED', String(error?.message || error), trace, { state });
        }

        if (!directive || typeof directive.type !== 'string') {
          return stopped('SKILL_INVALID_DIRECTIVE', 'Skill returned no valid directive.', trace, { state });
        }
        if (directive.type === 'COMPLETE') {
          return {
            status: 'COMPLETED',
            skill_id: skill.id,
            output: directive.output ?? null,
            trace,
          };
        }
        if (directive.type === 'STOP') {
          return stopped(
            String(directive.error_code || 'SKILL_STOPPED'),
            String(directive.message || 'Skill stopped.'),
            trace,
            { state },
          );
        }
        if (directive.type === 'OBSERVE') {
          trace.push({ type: 'DIRECTIVE', state, directive: 'OBSERVE' });
          transitions += 1;
          continue;
        }
        if (directive.type === 'WAIT') {
          const durationMs = Number(directive.duration_ms);
          if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_WAIT_MS) {
            return stopped(
              'SKILL_INVALID_WAIT',
              `WAIT duration must be an integer between 1 and ${MAX_WAIT_MS} ms.`,
              trace,
              { state },
            );
          }
          if (panicSwitch()) {
            return stopped('PANIC_SWITCH_ACTIVE', 'Skills runtime panic switch is active.', trace, { state });
          }
          trace.push({ type: 'DIRECTIVE', state, directive: 'WAIT', duration_ms: durationMs });
          transitions += 1;
          await sleep(durationMs);
          if (panicSwitch()) {
            return stopped('PANIC_SWITCH_ACTIVE', 'Skills runtime panic switch is active.', trace, { state });
          }
          continue;
        }

        const validation = validationResult(
          typeof skill.validateDirective === 'function'
            ? await skill.validateDirective({ state, snapshot, directive, context, inputs })
            : true,
        );
        if (!validation.ok) {
          return stopped(
            String(validation.code || 'SKILL_ACTION_NOT_ALLOWED'),
            String(validation.message || 'Skill safety policy rejected the directive.'),
            trace,
            { state },
          );
        }
        if (panicSwitch()) {
          return stopped('PANIC_SWITCH_ACTIVE', 'Skills runtime panic switch is active.', trace, { state });
        }

        const contracted = hasDeclaredPostcondition(directive);
        const primitive = primitiveForDirective(directive, snapshot);
        if (!primitive) {
          return stopped(
            'SKILL_INVALID_DIRECTIVE',
            `Unsupported directive: ${directive.type}`,
            trace,
            { state },
          );
        }
        if (
          !contracted
          && primitive.name !== 'app.launch'
          && (!Number.isInteger(primitive.args.expected_revision) || primitive.args.expected_revision < 0)
        ) {
          return stopped('SKILL_INVALID_REVISION', 'Action requires a valid observed revision.', trace, { state });
        }

        let attempt = null;
        if (contracted) {
          const prepared = prepareContractedAttempt({
            directive,
            snapshot,
            primitive,
            startedAt,
            deadlineMs: effective.deadlineMs,
            now,
            createAttemptId,
            trace,
            state,
          });
          if (prepared.stopped) return prepared.stopped;
          if (prepared.preexisting) {
            if (!prepared.preexisting.allowed) {
              return semanticStopped({
                errorCode: 'POSTCONDITION_ALREADY_SATISFIED',
                message: 'Declared postcondition is already satisfied before dispatch.',
                trace,
                state,
                predicateReason: prepared.preexisting.predicateReason,
              });
            }
            const semanticResult = {
              result: 'POSTCONDITION_ALREADY_SATISFIED',
              attempt_id: null,
              dispatch_state: 'NOT_DISPATCHED',
              baseline_revision: snapshot.revision ?? null,
              proof_revisions: [],
            };
            trace.push({
              type: 'SEMANTIC_RESULT',
              attempt_id: null,
              result: semanticResult.result,
              dispatch_state: semanticResult.dispatch_state,
              baseline_revision: semanticResult.baseline_revision,
              proof_revisions: semanticResult.proof_revisions,
              predicate_reason: prepared.preexisting.predicateReason,
            });
            if (typeof skill.acceptResult === 'function') {
              const acceptance = await skill.acceptResult({
                state,
                snapshot,
                directive,
                primitiveResult: null,
                semanticResult,
                context,
                inputs,
              });
              if (acceptance?.stop) {
                return stopped(
                  String(acceptance.error_code || 'SKILL_STOPPED'),
                  String(acceptance.message || 'Skill stopped after semantic result.'),
                  trace,
                  { state },
                );
              }
            }
            transitions += 1;
            staleRecoveries = 0;
            continue;
          }
          attempt = prepared.attempt;
        }

        let primitiveResult = null;
        let primitiveTransportUnknown = false;
        try {
          primitiveResult = await invokePrimitive(
            primitive.name,
            primitive.args,
            { deviceId, pairId, skillId, state, attemptId: attempt?.id ?? null },
          );
        } catch (error) {
          if (contracted) {
            primitiveTransportUnknown = true;
          } else {
            const recoveryCode = readOnlyObserveRecoveryCode(error);
            if (
              skill?.safety?.effect === 'read_only'
              && recoveryCode != null
              && readOnlySessionRecoveries < effective.maxReadOnlySessionRecoveries
              && typeof skill.recoverPrimitiveError === 'function'
            ) {
              let recovery = null;
              try {
                recovery = await skill.recoverPrimitiveError({
                  state,
                  snapshot,
                  directive,
                  primitive,
                  error,
                  error_code: recoveryCode,
                  context,
                  inputs,
                });
              } catch {
                recovery = null;
              }
              if (recovery?.reobserve === true) {
                readOnlySessionRecoveries += 1;
                transitions += 1;
                trace.push({
                  type: 'RECOVERY',
                  recovery: recoveryCode,
                  operation: primitive.name,
                  directive: directive.type,
                  purpose: directive.purpose ?? null,
                  attempt: readOnlySessionRecoveries,
                  action_replayed: false,
                });
                await sleep(SESSION_RECOVERY_DELAY_MS);
                continue;
              }
            }
            return stopped(
              'SKILL_PRIMITIVE_FAILED',
              String(error?.message || error || `${primitive.name} failed`),
              trace,
              { state },
            );
          }
        }
        const primitiveBody = primitiveTransportUnknown ? {} : structured(primitiveResult);
        const dispatchState = contracted ? dispatchStateFor(primitiveResult) : null;
        trace.push({
          type: 'ACTION',
          state,
          primitive: primitive.name,
          result: primitiveTransportUnknown
            ? 'TRANSPORT_UNKNOWN'
            : (primitiveBody.error_code || primitiveBody.status || null),
          ...(contracted ? {
            attempt_id: attempt.id,
            dispatch_state: dispatchState,
          } : {}),
        });
        transitions += 1;

        if (contracted) {
          if (primitiveBody.error_code === 'USER_AUTH_REQUIRED') {
            return semanticStopped({
              errorCode: 'USER_AUTH_REQUIRED',
              message: 'User authorization is required.',
              trace,
              state,
              attempt,
              dispatchState,
            });
          }
          if (dispatchState === 'NOT_DISPATCHED') {
            if (primitiveBody.error_code === 'STALE_STATE') {
              staleRecoveries += 1;
              if (staleRecoveries > effective.maxStaleRecoveries) {
                return semanticStopped({
                  errorCode: 'STALE_STATE',
                  message: 'Contracted action was rejected as stale before dispatch.',
                  trace,
                  state,
                  attempt,
                  dispatchState,
                });
              }
              trace.push({
                type: 'SEMANTIC_RESULT',
                attempt_id: attempt.id,
                result: 'STALE_STATE',
                dispatch_state: dispatchState,
                baseline_revision: attempt.baselineRevision,
                proof_revisions: [],
                predicate_reason: 'NOT_DISPATCHED_STALE',
              });
              continue;
            }
            return stopped(
              String(primitiveBody.error_code || 'SKILL_PRIMITIVE_REJECTED'),
              String(primitiveBody.message || `${primitive.name} was not dispatched`),
              trace,
              {
                state,
                attempt_id: attempt.id,
                dispatch_state: dispatchState,
                baseline_revision: attempt.baselineRevision,
              },
            );
          }

          const semantic = await verifyContractedAttempt({
            attempt,
            invokePrimitive,
            deviceId,
            pairId,
            skillId,
            state,
            trace,
            now,
            sleep,
            panicSwitch,
          });
          if (semantic.result === 'PANIC_SWITCH_ACTIVE') {
            return stopped('PANIC_SWITCH_ACTIVE', 'Skills runtime panic switch is active.', trace, { state });
          }
          if (semantic.result !== 'VERIFIED') {
            return semanticStopped({
              errorCode: semantic.result,
              message: semantic.result === 'USER_AUTH_REQUIRED'
                ? 'User authorization is required.'
                : 'Contracted action could not be semantically verified.',
              trace,
              state,
              attempt,
              dispatchState,
              proofRevisions: semantic.proofRevisions,
              predicateReason: semantic.predicateReason,
            });
          }

          const semanticResult = {
            result: 'VERIFIED',
            attempt_id: attempt.id,
            dispatch_state: dispatchState,
            baseline_revision: attempt.baselineRevision,
            proof_revisions: semantic.proofRevisions,
          };
          trace.push({
            type: 'SEMANTIC_RESULT',
            attempt_id: semanticResult.attempt_id,
            result: semanticResult.result,
            dispatch_state: semanticResult.dispatch_state,
            baseline_revision: semanticResult.baseline_revision,
            proof_revisions: semanticResult.proof_revisions,
            predicate_reason: semantic.predicateReason,
          });
          if (typeof skill.acceptResult === 'function') {
            const acceptance = await skill.acceptResult({
              state,
              snapshot,
              directive,
              primitiveResult,
              semanticResult,
              context,
              inputs,
            });
            if (acceptance?.stop) {
              return stopped(
                String(acceptance.error_code || 'SKILL_STOPPED'),
                String(acceptance.message || 'Skill stopped after semantic result.'),
                trace,
                { state },
              );
            }
          }
          staleRecoveries = 0;
          continue;
        }

        if (primitiveBody.error_code === 'USER_AUTH_REQUIRED') {
          return stopped('USER_AUTH_REQUIRED', 'User authorization is required.', trace, { state });
        }
        if (primitiveBody.error_code === 'STALE_STATE') {
          staleRecoveries += 1;
          if (staleRecoveries > effective.maxStaleRecoveries) {
            return stopped('SKILL_STALE_RECOVERY_LIMIT', 'Too many stale-state recoveries.', trace, { state });
          }
          continue;
        }

        let handledError = false;
        if (typeof skill.acceptResult === 'function') {
          const acceptance = await skill.acceptResult({
            state,
            snapshot,
            directive,
            primitiveResult,
            context,
            inputs,
          });
          if (acceptance?.stop) {
            return stopped(
              String(acceptance.error_code || 'SKILL_STOPPED'),
              String(acceptance.message || 'Skill stopped after primitive result.'),
              trace,
              { state },
            );
          }
          handledError = acceptance?.handled_error === true;
        }

        if (isError(primitiveResult) && !handledError) {
          return stopped(
            String(primitiveBody.error_code || 'SKILL_PRIMITIVE_FAILED'),
            String(primitiveBody.message || `${primitive.name} failed`),
            trace,
            { state },
          );
        }

        staleRecoveries = 0;
      }
    },
  });
}
