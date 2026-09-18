import { MEDIA_DISCOVERY_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeDiscoverablePlanSkill } from '../native/augmented-exact-plan.js';
import { mediaProfileById } from './app-profiles.js';

const MEDIA_PERSISTENT_ACTION_PATTERN = /(?:like|favorite|favourite|subscribe|download|buy|rent|purchase|remove|delete|sign in|log in|login|account|мне нравится|лайк|избран|подпис|скачать|купить|аренд|удал|войти|аккаунт|авторизац)/iu;

export function createMediaDiscoveryPlanSkill() {
  const base = createNativeDiscoverablePlanSkill({
    id: 'media.discovery.run_plan',
    packages: MEDIA_DISCOVERY_PACKAGES,
    effect: 'read_only',
    risk: 'R1',
    forbiddenClickPattern: MEDIA_PERSISTENT_ACTION_PATTERN,
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
  });
}
