import { MEDIA_DISCOVERY_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeExactPlanSkill } from '../native/exact-plan.js';

const MEDIA_PERSISTENT_ACTION_PATTERN = /(?:like|favorite|favourite|subscribe|download|buy|rent|purchase|remove|delete|мне нравится|лайк|избран|подпис|скачать|купить|аренд|удал)/iu;

export function createMediaDiscoveryPlanSkill() {
  return createNativeExactPlanSkill({
    id: 'media.discovery.run_plan',
    packages: MEDIA_DISCOVERY_PACKAGES,
    effect: 'read_only',
    risk: 'R1',
    forbiddenClickPattern: MEDIA_PERSISTENT_ACTION_PATTERN,
  });
}
