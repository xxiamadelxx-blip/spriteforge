import { AI_ASSISTANT_APPS, AI_ASSISTANT_PACKAGES } from '../catalogs/device-apps.js';

const AUTH_FIELD_PATTERN = /(?:password|passcode|pin|otp|2fa|two[- ]?factor|verification code|security code|api[ _-]?token|access[ _-]?token|secret|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|токен|секрет)/iu;
const FORBIDDEN_AI_CLICK_PATTERN = /(?:delete|remove|clear history|account|settings|subscription|upgrade|billing|payment|purchase|buy|sign out|log out|удал|очистить истор|аккаунт|настройк|подписк|тариф|оплат|купить|выйти из аккаунта)/iu;
const ALLOWED_STEP_TYPES = new Set([
  'CLICK_EXACT_TEXT',
  'CLICK_EXACT_SELECTOR',
  'SET_TEXT_EXACT_SELECTOR',
  'ASSERT_EXACT_TEXT',
  'SCROLL_DOWN',
]);

function stepLabel(step) {
  return String(step?.label ?? step?.text ?? step?.selector?.value ?? '');
}

function providerPackage(provider) {
  return AI_ASSISTANT_APPS[String(provider || '').trim().toLowerCase()] || '';
}

export function authorizeAiAssistantSkill(skill, { inputs = {} } = {}) {
  if (skill?.id !== 'ai.assistant.run_plan') return null;
  if (skill?.safety?.effect !== 'conversation_write') {
    return { ok: false, code: 'SKILL_EFFECT_NOT_ALLOWED', message: 'AI assistant skill effect mismatch.' };
  }

  const declaredPackages = Array.isArray(skill?.packages) ? skill.packages.map(String) : [];
  const approved = new Set(AI_ASSISTANT_PACKAGES);
  if (
    declaredPackages.length !== approved.size
    || declaredPackages.some((pkg) => !approved.has(pkg))
  ) {
    return { ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'AI assistant package manifest mismatch.' };
  }

  const resolvedProviderPackage = providerPackage(inputs.provider);
  const declaredPackage = String(inputs.package || '');
  const targetPackage = resolvedProviderPackage || declaredPackage;
  if (!approved.has(targetPackage)) {
    return { ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'Requested AI assistant is outside the approved provider set.' };
  }
  if (resolvedProviderPackage && declaredPackage && declaredPackage !== resolvedProviderPackage) {
    return { ok: false, code: 'SKILL_PACKAGE_NOT_ALLOWED', message: 'Declared package does not match the selected AI provider.' };
  }

  const delegationDepth = Number(inputs.delegation_depth ?? 0);
  if (!Number.isInteger(delegationDepth) || delegationDepth < 0 || delegationDepth > 1) {
    return { ok: false, code: 'AI_DELEGATION_DEPTH_EXCEEDED', message: 'AI-to-AI delegation is limited to one nested hop.' };
  }

  const steps = Array.isArray(inputs.steps) ? inputs.steps : [];
  if (steps.length > 40) {
    return { ok: false, code: 'SKILL_PLAN_TOO_LARGE', message: 'AI assistant plan exceeds the bounded 40-step limit.' };
  }

  for (const step of steps) {
    const type = String(step?.type || '');
    if (!ALLOWED_STEP_TYPES.has(type)) {
      return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'AI assistant plan contains an unsupported action type.' };
    }
    const label = stepLabel(step);
    if (
      step?.sensitive === true
      || (type.startsWith('SET_TEXT') && AUTH_FIELD_PATTERN.test(label))
    ) {
      return { ok: false, code: 'USER_AUTH_REQUIRED', message: 'Passwords, OTPs, API tokens and authorization secrets are user-only.' };
    }
    if (type.startsWith('CLICK') && FORBIDDEN_AI_CLICK_PATTERN.test(label)) {
      return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED', message: 'Account, settings, subscription, payment and destructive AI actions are blocked.' };
    }
  }

  return { ok: true };
}
