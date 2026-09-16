import { AI_ASSISTANT_APPS, AI_ASSISTANT_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeExactPlanSkill } from '../native/exact-plan.js';

const FORBIDDEN_AI_ACTION_PATTERN = /(?:delete|remove|clear history|account|settings|subscription|upgrade|billing|payment|purchase|buy|sign out|log out|удал|очистить истор|аккаунт|настройк|подписк|тариф|оплат|купить|выйти из аккаунта)/iu;

function providerPackage(provider) {
  return AI_ASSISTANT_APPS[String(provider || '').trim().toLowerCase()] || '';
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
      return base.createContext({
        inputs: {
          ...inputs,
          package: resolvedPackage,
        },
      });
    },
  });
}
