import { AI_ASSISTANT_APPS, AI_ASSISTANT_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeExactPlanSkill } from '../native/exact-plan.js';

const FORBIDDEN_AI_ACTION_PATTERN = /(?:delete|remove|clear history|account|settings|subscription|upgrade|billing|payment|purchase|buy|sign out|log out|удал|очистить истор|аккаунт|настройк|подписк|тариф|оплат|купить|выйти из аккаунта)/iu;
const SEND_PATTERN = /^(?:send|отправить)$/iu;
const GEMINI_RUNTIME_PACKAGE = 'com.google.android.googlequicksearchbox';

function providerPackage(provider) {
  return AI_ASSISTANT_APPS[String(provider || '').trim().toLowerCase()] || '';
}

function runtimePackages(provider, targetPackage) {
  const values = new Set([String(targetPackage || '')].filter(Boolean));
  if (String(provider || '').trim().toLowerCase() === 'gemini') values.add(GEMINI_RUNTIME_PACKAGE);
  return values;
}

function nodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function selectorMatches(node, selector) {
  const kind = String(selector?.kind || '').toUpperCase();
  const value = String(selector?.value ?? '');
  switch (kind) {
    case 'HANDLE': return String(node?.handle ?? '') === value;
    case 'TEXT': return String(node?.text ?? '') === value;
    case 'CONTENT_DESCRIPTION': return String(node?.content_description ?? '') === value;
    case 'RESOURCE_ID': return String(node?.resource_id ?? '') === value;
    case 'CLASS_NAME': return String(node?.class_name ?? '') === value;
    default: return false;
  }
}

function findExactNode(snapshot, selector) {
  return nodes(snapshot).find((node) => selectorMatches(node, selector)) || null;
}

function nodeText(node) {
  return String(node?.text ?? node?.content_description ?? '').trim();
}

function exactTextVisible(snapshot, expected) {
  return nodes(snapshot).some((node) => (
    String(node?.text ?? '') === expected
    || String(node?.content_description ?? '') === expected
  ));
}

function primitiveBody(result) {
  if (!result || typeof result !== 'object') return {};
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : result;
}

function stop(error_code, message) {
  return { type: 'STOP', error_code, message };
}

export function createAiAssistantPlanSkill() {
  const base = createNativeExactPlanSkill({
    id: 'ai.assistant.run_plan',
    packages: AI_ASSISTANT_PACKAGES,
    effect: 'conversation_write',
    risk: 'R2',
    forbiddenClickPattern: FORBIDDEN_AI_ACTION_PATTERN,
  });

  return Object.freeze({
    ...base,
    createContext({ inputs = {} } = {}) {
      const provider = String(inputs.provider || '').trim().toLowerCase();
      const resolvedPackage = providerPackage(provider) || String(inputs.package || '');
      const context = base.createContext({
        inputs: {
          ...inputs,
          package: resolvedPackage,
        },
      });
      return {
        ...context,
        ai_provider: provider,
        ai_runtime_packages: runtimePackages(provider, resolvedPackage),
        ai_pending_launch_proof: false,
        ai_last_prompt: null,
        ai_composer_selector: null,
      };
    },
    recognize(snapshot, context) {
      return context?.ai_runtime_packages?.has(String(snapshot?.package || ''))
        ? 'TARGET_APP'
        : 'OTHER_APP';
    },
    async next(args) {
      const { snapshot, context } = args;

      if (context?.ai_pending_launch_proof) {
        if (!context.ai_runtime_packages?.has(String(snapshot?.package || ''))) {
          return stop(
            'AI_LAUNCH_NOT_VERIFIED',
            'AI launch was dispatched but the expected provider surface was not proven by a fresh observation.',
          );
        }
        context.ai_pending_launch_proof = false;
      }

      const step = context?.steps?.[context?.index] || null;
      const directive = await base.next(args);

      if (
        directive?.type === 'SET_TEXT_HANDLE'
        && step?.type === 'SET_TEXT_EXACT_SELECTOR'
        && step?.selector
      ) {
        const selectorKind = String(step.selector.kind || '').toUpperCase();
        if (!['TEXT', 'CONTENT_DESCRIPTION', 'RESOURCE_ID', 'CLASS_NAME'].includes(selectorKind)) {
          return stop(
            'ACTION_NOT_VERIFIED',
            'AI composer set-text requires a cross-revision exact semantic selector.',
          );
        }
        const target = findExactNode(snapshot, { kind: 'HANDLE', value: directive.handle });
        const targetPackage = String(target?.window_package || '');
        if (
          !target
          || target?.window_type !== 'APPLICATION'
          || !targetPackage
          || !context?.ai_runtime_packages?.has(targetPackage)
        ) {
          return stop(
            'ACTION_NOT_VERIFIED',
            'AI composer target is not bound to an allowed application window.',
          );
        }
        return {
          ...directive,
          postcondition: {
            mode: 'transition',
            expr: {
              kind: 'node_field',
              selector: { kind: selectorKind, value: String(step.selector.value ?? '') },
              scope: {
                window_type: 'APPLICATION',
                package: targetPackage,
              },
              field: 'text',
              op: 'eq',
              value: String(directive.value ?? ''),
            },
          },
        };
      }

      if (
        directive?.type === 'CLICK_HANDLE'
        && step?.type === 'CLICK_EXACT_TEXT'
        && SEND_PATTERN.test(String(step.text || '').trim())
      ) {
        const prompt = String(context?.ai_last_prompt ?? '');
        const composerSelector = context?.ai_composer_selector;
        const composer = composerSelector ? findExactNode(snapshot, composerSelector) : null;
        const sendTarget = findExactNode(snapshot, { kind: 'HANDLE', value: directive.handle });
        const packageName = String(composer?.window_package || '');
        if (
          !prompt
          || !composerSelector
          || !composer
          || composer?.editable !== true
          || composer?.sensitive === true
          || composer?.window_type !== 'APPLICATION'
          || !packageName
          || !context?.ai_runtime_packages?.has(packageName)
          || nodeText(composer) !== prompt
          || !sendTarget
          || sendTarget?.window_type !== 'APPLICATION'
          || String(sendTarget?.window_package || '') !== packageName
        ) {
          return stop(
            'ACTION_NOT_VERIFIED',
            'AI Send requires composer and action targets bound to the same allowed application window.',
          );
        }
        const priorSentMatches = nodes(snapshot).filter((node) => (
          node !== composer
          && node?.window_type === 'APPLICATION'
          && node?.window_package === packageName
          && node?.visible_to_user === true
          && node?.sensitive !== true
          && node?.editable !== true
          && (
            String(node?.text ?? '') === prompt
            || String(node?.content_description ?? '') === prompt
          )
        ));
        if (priorSentMatches.length > 0) {
          return stop(
            'POSTCONDITION_ALREADY_SATISFIED',
            'The exact AI prompt is already present as a sent message; Send will not be replayed.',
          );
        }
        if (snapshot?.semantic_tree_complete !== true || snapshot?.truncated === true) {
          return stop(
            'ACTION_NOT_VERIFIED',
            'AI Send requires complete scoped semantic coverage to prove the prompt was not already sent.',
          );
        }
        const selectorKind = String(composerSelector.kind || '').toUpperCase();
        if (!['TEXT', 'CONTENT_DESCRIPTION', 'RESOURCE_ID', 'CLASS_NAME'].includes(selectorKind)) {
          return stop(
            'ACTION_NOT_VERIFIED',
            'AI Send requires a cross-revision composer selector.',
          );
        }
        return {
          ...directive,
          postcondition: {
            mode: 'transition',
            expr: {
              kind: 'all',
              children: [
                {
                  kind: 'node_field_transition',
                  selector: { kind: selectorKind, value: String(composerSelector.value ?? '') },
                  scope: { window_type: 'APPLICATION', package: packageName },
                  field: 'text',
                  from: prompt,
                  to: '',
                },
                {
                  kind: 'node_field',
                  selector: { kind: 'TEXT', value: prompt },
                  scope: { window_type: 'APPLICATION', package: packageName },
                  field: 'editable',
                  op: 'eq',
                  value: false,
                },
              ],
            },
          },
        };
      }

      return directive;
    },
    async acceptResult(args) {
      const { directive, primitiveResult, semanticResult, context } = args;
      const body = primitiveBody(primitiveResult);
      const step = context?.steps?.[context?.index];

      if (directive?.type === 'LAUNCH' && body?.error_code === 'APP_LAUNCH_NOT_VERIFIED') {
        context.ai_pending_launch_proof = true;
        return { handled_error: true };
      }

      if (
        directive?.type === 'SET_TEXT_HANDLE'
        && Object.prototype.hasOwnProperty.call(directive || {}, 'postcondition')
        && semanticResult?.result === 'VERIFIED'
        && step?.type === 'SET_TEXT_EXACT_SELECTOR'
      ) {
        context.ai_last_prompt = String(directive.value ?? '');
        context.ai_composer_selector = step.selector;
      }

      if (
        directive?.type === 'CLICK_HANDLE'
        && Object.prototype.hasOwnProperty.call(directive || {}, 'postcondition')
        && semanticResult?.result === 'VERIFIED'
        && step?.type === 'CLICK_EXACT_TEXT'
        && SEND_PATTERN.test(String(step.text || '').trim())
      ) {
        context.ai_last_prompt = null;
        context.ai_composer_selector = null;
      }

      return base.acceptResult(args);
    }
  });
}
