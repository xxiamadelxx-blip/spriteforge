import { mediaProfileById } from './app-profiles.js';
import { MEDIA_PLAYBACK_PACKAGES } from './playback-plan.js';

const PLAYBACK_ACTION_PATTERN = /(?:\bplay\b|\bpause\b|\bresume\b|play[_\s-]?pause|continue watching|watch now|\blisten\b|\bnext\b|\bprevious\b|\breplay\b|\brewind\b|\bforward\b|воспроизвести|пауз\p{L}*|продолжить просмотр|продолжить слушать|смотреть|слушать|следующ|предыдущ|повторить|перемот)/iu;
const PERSISTENT_OR_COMMERCIAL_PATTERN = /(?:like|favorite|favourite|subscribe|download|buy|rent|purchase|remove|delete|collection|account|billing|payment|мне нравится|лайк|избран|коллекц|подпис|скачать|купить|аренд|удал|аккаунт|оплат)/iu;
const AUTH_FIELD_PATTERN = /(?:password|passcode|pin|otp|2fa|verification code|security code|api[ _-]?token|access[ _-]?token|secret|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|токен|секрет)/iu;
const ALLOWED_STEP_TYPES = new Set([
  'CLICK_EXACT_TEXT',
  'CLICK_EXACT_SELECTOR',
  'ASSERT_EXACT_TEXT',
  'SCROLL_DOWN',
  'WAIT_FOR_EXACT_SELECTOR',
  'CAPTURE_EXACT_SELECTOR_TEXT',
  'CAPTURE_VISIBLE_UI',
  'SEEK_EXACT_SELECTOR_FRACTION',
]);

function denied(code, message) {
  return { ok: false, code, message };
}

export function authorizeMediaPlaybackSkill(skill, { inputs = {} } = {}) {
  if (skill?.id !== 'media.playback.run_plan') return null;
  if (skill?.safety?.effect !== 'playback_control') {
    return denied('SKILL_EFFECT_NOT_ALLOWED', 'Playback skill must declare playback_control effect.');
  }

  const declaredPackages = Array.isArray(skill?.packages) ? skill.packages.map(String) : [];
  const approved = new Set(MEDIA_PLAYBACK_PACKAGES);
  if (declaredPackages.length !== approved.size || declaredPackages.some((pkg) => !approved.has(pkg))) {
    return denied('SKILL_PACKAGE_NOT_ALLOWED', 'Playback packages do not match the approved media playback manifest.');
  }

  const provider = String(inputs.provider || '').trim().toLowerCase();
  const profile = provider ? mediaProfileById(provider) : null;
  const declaredPackage = String(inputs.package || '');
  const targetPackage = profile?.package || declaredPackage;
  if (provider && !profile) {
    return denied('SKILL_PROVIDER_NOT_ALLOWED', 'Unknown media playback provider.');
  }
  if (declaredPackage && profile && declaredPackage !== profile.package) {
    return denied('SKILL_PACKAGE_NOT_ALLOWED', 'Declared package does not match the selected media provider.');
  }
  if (!approved.has(targetPackage)) {
    return denied('SKILL_PACKAGE_NOT_ALLOWED', 'Requested provider does not support playback control.');
  }

  const steps = Array.isArray(inputs.steps) ? inputs.steps : [];
  if (steps.length > 40) {
    return denied('SKILL_PLAN_TOO_LARGE', 'Playback plan exceeds the bounded step limit.');
  }
  for (const step of steps) {
    const type = String(step?.type || '');
    if (!ALLOWED_STEP_TYPES.has(type)) {
      return denied('SKILL_ACTION_NOT_ALLOWED', 'Playback plan contains an unsupported action type.');
    }
    if (step?.sensitive === true) {
      return denied('USER_AUTH_REQUIRED', 'Sensitive media fields are user-only.');
    }
    const label = String(step?.text ?? step?.selector?.value ?? '');
    if (type === 'CLICK_EXACT_TEXT') {
      if (PERSISTENT_OR_COMMERCIAL_PATTERN.test(label) || !PLAYBACK_ACTION_PATTERN.test(label)) {
        return denied('SKILL_ACTION_NOT_ALLOWED', 'Playback plan may click only playback controls.');
      }
    }
    if (type === 'CAPTURE_EXACT_SELECTOR_TEXT' && AUTH_FIELD_PATTERN.test(label)) {
      return denied('USER_AUTH_REQUIRED', 'Sensitive media content cannot be captured.');
    }
    if (type === 'SEEK_EXACT_SELECTOR_FRACTION') {
      const fraction = Number(step?.fraction);
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        return denied('SKILL_ACTION_NOT_ALLOWED', 'Playback seek fraction must be between 0 and 1.');
      }
      if (!step?.selector || AUTH_FIELD_PATTERN.test(label) || PERSISTENT_OR_COMMERCIAL_PATTERN.test(label)) {
        return denied('SKILL_ACTION_NOT_ALLOWED', 'Playback seek requires a bounded non-sensitive semantic selector.');
      }
    }
  }
  return { ok: true };
}
