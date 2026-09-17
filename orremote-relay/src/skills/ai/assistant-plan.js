import { AI_ASSISTANT_APPS, AI_ASSISTANT_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeExactPlanSkill } from '../native/exact-plan.js';

const FORBIDDEN_AI_ACTION_PATTERN = /(?:delete|remove|clear history|account|settings|subscription|upgrade|billing|payment|purchase|buy|sign out|log out|удал|очистить истор|аккаунт|настройк|подписк|тариф|оплат|купить|выйти из аккаунта)/iu;
const SEND_PATTERN = /^(?:send|отправить)$/iu;

function providerPackage(provider) {
  return AI_ASSISTANT_APPS[String(provider || '').trim().toLowerCase()] || '';
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
      const resolvedPackage = providerPackage(inputs.provider) || String(inputs.package || '');
      const context = base.createContext({
        inputs: {
          ...inputs,
          package: resolvedPackage,
        },
      });
      return {
        ...context,
        ai_pending_text_proof: null,
        ai_pending_send_proof: null,
        ai_last_prompt: null,
        ai_composer_selector: null,
      };
    },
    async next(args) {
      const { snapshot, context } = args;

      if (context?.ai_pending_text_proof) {
        const pending = context.ai_pending_text_proof;
        const field = findExactNode(snapshot, pending.selector);
        if (!field || field?.editable !== true || field?.sensitive === true || nodeText(field) !== pending.value) {
          return stop(
            'AI_TEXT_NOT_VERIFIED',
            'AI composer text was not semantically proven after the delayed set-text result.',
          );
        }
        context.ai_last_prompt = pending.value;
        context.ai_composer_selector = pending.selector;
        context.ai_pending_text_proof = null;
        context.index += 1;
        return { type: 'OBSERVE' };
      }

      if (context?.ai_pending_send_proof) {
        const pending = context.ai_pending_send_proof;
        const composer = findExactNode(snapshot, pending.composer_selector);
        const promptVisible = exactTextVisible(snapshot, pending.prompt);
        const composerCleared = composer && composer?.editable === true && nodeText(composer) === '';
        if (!promptVisible || !composerCleared) {
          return stop(
            'AI_SEND_NOT_VERIFIED',
            'AI send action was not semantically proven after the delayed click result.',
          );
        }
        context.ai_pending_send_proof = null;
        context.index += 1;
        return { type: 'OBSERVE' };
      }

      return base.next(args);
    },
    async acceptResult(args) {
      const { directive, primitiveResult, context } = args;
      const body = primitiveBody(primitiveResult);
      const step = context?.steps?.[context?.index];

      if (directive?.type === 'SET_TEXT_HANDLE') {
        const selector = step?.type === 'SET_TEXT_EXACT_SELECTOR' ? step.selector : null;
        const value = String(directive.value ?? '');
        if (body?.error_code === 'ACTION_NOT_VERIFIED' && selector) {
          context.ai_pending_text_proof = { selector, value };
          return { handled_error: true };
        }
        if (!body?.error_code && selector) {
          context.ai_last_prompt = value;
          context.ai_composer_selector = selector;
        }
      }

      if (
        directive?.type === 'CLICK_HANDLE'
        && step?.type === 'CLICK_EXACT_TEXT'
        && SEND_PATTERN.test(String(step.text || '').trim())
        && body?.error_code === 'ACTION_NOT_VERIFIED'
        && context?.ai_last_prompt
        && context?.ai_composer_selector
      ) {
        context.ai_pending_send_proof = {
          prompt: context.ai_last_prompt,
          composer_selector: context.ai_composer_selector,
        };
        return { handled_error: true };
      }

      return base.acceptResult(args);
    },
  });
}
