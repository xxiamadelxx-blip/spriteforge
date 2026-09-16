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
    async validateDirective(args) {
      const baseValidation = await base.validateDirective(args);
      if (!baseValidation?.ok) return baseValidation;
      const { directive, snapshot } = args;
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
