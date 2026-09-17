const DEFAULT_LIMITS = Object.freeze({
  maxTransitions: 80,
  maxStaleRecoveries: 6,
  maxReadOnlySessionRecoveries: 2,
  deadlineMs: 120_000,
});
const MAX_WAIT_MS = 2_000;
const SESSION_RECOVERY_DELAY_MS = 100;

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

export function createSkillRuntime({
  invokePrimitive,
  registry,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  authorizeSkill = null,
  panicSwitch = () => false,
}) {
  if (typeof invokePrimitive !== 'function') throw new Error('invokePrimitive is required');
  if (!registry || typeof registry.get !== 'function') throw new Error('registry is required');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');
  if (authorizeSkill != null && typeof authorizeSkill !== 'function') throw new Error('authorizeSkill must be a function');
  if (typeof panicSwitch !== 'function') throw new Error('panicSwitch must be a function');

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

        if (snapshot.authorization_required === true || snapshot.error_code === 'USER_AUTH_REQUIRED') {
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
          primitive.name !== 'app.launch'
          && (!Number.isInteger(primitive.args.expected_revision) || primitive.args.expected_revision < 0)
        ) {
          return stopped('SKILL_INVALID_REVISION', 'Action requires a valid observed revision.', trace, { state });
        }

        let primitiveResult;
        try {
          primitiveResult = await invokePrimitive(
            primitive.name,
            primitive.args,
            { deviceId, pairId, skillId, state },
          );
        } catch (error) {
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
        const primitiveBody = structured(primitiveResult);
        trace.push({
          type: 'ACTION',
          state,
          primitive: primitive.name,
          result: primitiveBody.error_code || primitiveBody.status || null,
        });
        transitions += 1;

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
