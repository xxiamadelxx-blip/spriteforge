import { createNativeDiscoverablePlanSkill } from '../native/augmented-exact-plan.js';
import { mediaProfileById } from './app-profiles.js';

export const MEDIA_PLAYBACK_PACKAGES = Object.freeze([
  'ru.yandex.music',
  'ru.kinopoisk',
]);

const PERSISTENT_OR_COMMERCIAL_PATTERN = /(?:like|favorite|favourite|subscribe|download|buy|rent|purchase|remove|delete|account|billing|payment|мне нравится|лайк|избран|подпис|скачать|купить|аренд|удал|аккаунт|оплат)/iu;
const PLAYBACK_ACTION_PATTERN = /(?:\bplay\b|\bpause\b|\bresume\b|continue watching|watch now|\blisten\b|\bnext\b|\bprevious\b|\breplay\b|воспроизвести|пауза|продолжить просмотр|продолжить слушать|смотреть|слушать|следующ|предыдущ|повторить)/iu;

function containsBounds(parent, child) {
  const p = parent?.bounds;
  const c = child?.bounds;
  return Boolean(
    p && c
    && p.left <= c.left
    && p.top <= c.top
    && p.right >= c.right
    && p.bottom >= c.bottom,
  );
}

function semanticDescriptor(snapshot, root) {
  const rootDepth = Number(root?.depth ?? 0);
  const parts = [root?.text, root?.content_description, root?.resource_id, root?.class_name];
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  for (const node of nodes) {
    if (node === root || Number(node?.depth ?? 0) <= rootDepth || !containsBounds(root, node)) continue;
    parts.push(node?.text, node?.content_description, node?.resource_id, node?.class_name);
  }
  return parts.filter(Boolean).join(' ');
}

function nodeForHandle(snapshot, handle) {
  return (Array.isArray(snapshot?.nodes) ? snapshot.nodes : [])
    .find((node) => String(node?.handle || '') === String(handle || '')) || null;
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

function nodeForSelector(snapshot, selector) {
  return (Array.isArray(snapshot?.nodes) ? snapshot.nodes : [])
    .find((node) => selectorMatches(node, selector)) || null;
}

function seekPoint(node, fraction) {
  const bounds = node?.bounds;
  const left = Number(bounds?.left);
  const top = Number(bounds?.top);
  const right = Number(bounds?.right);
  const bottom = Number(bounds?.bottom);
  const f = Number(fraction);
  if (![left, top, right, bottom, f].every(Number.isFinite)) return null;
  if (right <= left || bottom <= top || f < 0 || f > 1) return null;
  const usableWidth = Math.max(1, right - left - 1);
  return {
    x: Math.round(left + (usableWidth * f)),
    y: Math.round((top + bottom) / 2),
  };
}

function isAllowedSeekTarget(snapshot, node) {
  if (!node || node?.enabled === false || node?.sensitive === true) return false;
  const descriptor = semanticDescriptor(snapshot, node);
  if (PERSISTENT_OR_COMMERCIAL_PATTERN.test(descriptor)) return false;
  return SEEK_TARGET_PATTERN.test(descriptor)
    || /(?:seekbar|slider)/iu.test(String(node?.class_name || ''));
}

export function createMediaPlaybackPlanSkill() {
  const base = createNativeDiscoverablePlanSkill({
    id: 'media.playback.run_plan',
    packages: MEDIA_PLAYBACK_PACKAGES,
    effect: 'playback_control',
    risk: 'R1',
    forbiddenClickPattern: PERSISTENT_OR_COMMERCIAL_PATTERN,
  });

  return Object.freeze({
    ...base,
    createContext({ inputs = {}, deviceId = null, pairId = null } = {}) {
      const profile = mediaProfileById(inputs.provider);
      const resolvedInputs = profile
        ? { ...inputs, package: profile.package }
        : inputs;
      return base.createContext({ inputs: resolvedInputs, deviceId, pairId });
    },
    async next(args) {
      const { state, snapshot, context } = args;
      const step = context?.steps?.[context?.index];
      if (state === 'TARGET_APP' && step?.type === 'SEEK_EXACT_SELECTOR_FRACTION') {
        const target = nodeForSelector(snapshot, step.selector);
        if (!target) {
          return {
            type: 'STOP',
            error_code: 'MEDIA_SEEK_TARGET_NOT_FOUND',
            message: 'Exact semantic media seek target was not found.',
          };
        }
        if (!isAllowedSeekTarget(snapshot, target)) {
          return {
            type: 'STOP',
            error_code: 'MEDIA_SEEK_TARGET_NOT_ALLOWED',
            message: 'Matched semantic target is not a proven playback seek control.',
          };
        }
        const point = seekPoint(target, step.fraction);
        if (!point) {
          return {
            type: 'STOP',
            error_code: 'SKILL_ACTION_NOT_ALLOWED',
            message: 'Media seek fraction or target bounds are invalid.',
          };
        }
        return {
          type: 'TAP_POINT',
          x: point.x,
          y: point.y,
          selector: { ...step.selector },
          fraction: Number(step.fraction),
          playback_seek: true,
          step_index: context.index,
        };
      }
      return base.next(args);
    },
    async validateDirective(args) {
      const { directive, snapshot } = args;
      if (directive.type === 'TAP_POINT' && directive.playback_seek === true) {
        const target = nodeForSelector(snapshot, directive.selector);
        if (!isAllowedSeekTarget(snapshot, target)) {
          return {
            ok: false,
            code: 'MEDIA_SEEK_TARGET_NOT_ALLOWED',
            message: 'Semantic seek target changed or is no longer a playback seek control.',
          };
        }
        const point = seekPoint(target, directive.fraction);
        if (!point || point.x !== Number(directive.x) || point.y !== Number(directive.y)) {
          return {
            ok: false,
            code: 'MEDIA_SEEK_TARGET_CHANGED',
            message: 'Semantic seek target moved before execution.',
          };
        }
        return { ok: true };
      }
      const baseValidation = await base.validateDirective(args);
      if (!baseValidation?.ok) return baseValidation;
      if (directive.type === 'SET_TEXT_HANDLE') {
        return {
          ok: false,
          code: 'SKILL_ACTION_NOT_ALLOWED',
          message: 'Playback skill cannot enter text.',
        };
      }
      if (directive.type === 'CLICK_HANDLE') {
        const node = nodeForHandle(snapshot, directive.handle);
        const descriptor = semanticDescriptor(snapshot, node);
        if (!node || PERSISTENT_OR_COMMERCIAL_PATTERN.test(descriptor) || !PLAYBACK_ACTION_PATTERN.test(descriptor)) {
          return {
            ok: false,
            code: 'SKILL_ACTION_NOT_ALLOWED',
            message: 'Playback skill may click only playback controls.',
          };
        }
      }
      return { ok: true };
    },
  });
}
