import { createDevicePrimitiveInvoker } from './device-invoker.js';
import { createSkillRegistry } from './registry.js';
import { createSkillRuntime } from './runtime.js';
import { createDefaultSkillSafetyPolicy } from './safety-policy.js';
import { createAiAssistantPlanSkill } from './ai/assistant-plan.js';
import { authorizeAiAssistantSkill } from './ai/safety.js';
import { createBrowserAdminSkill } from './browser/augmented-skill.js';
import { normalizeBrowserAdminPolicyInputs } from './browser/policy-inputs.js';
import { createDeliveryCartPlanSkill } from './delivery/cart-plan.js';
import { createFilesDownloadsApksSkill } from './files/downloads-apks.js';
import { createMediaDiscoveryPlanSkill } from './media/discovery-plan.js';
import { createSettingsDeviceInfoSkill } from './settings/device-info.js';
import { createYandexProPlannedSlotOrdersSkill } from './yandex-pro/planned-slot-orders.js';

const RUNTIMES = new WeakMap();

export function createDefaultSkillRegistry() {
  return createSkillRegistry([
    createYandexProPlannedSlotOrdersSkill(),
    createSettingsDeviceInfoSkill(),
    createFilesDownloadsApksSkill(),
    createBrowserAdminSkill(),
    createMediaDiscoveryPlanSkill(),
    createDeliveryCartPlanSkill(),
    createAiAssistantPlanSkill(),
  ]);
}

export function createRelaySkillsRuntime({ deviceRelay, now = () => Date.now() }) {
  const safety = createDefaultSkillSafetyPolicy();
  const authorizeSkill = async (skill, context) => {
    const aiAuthorization = authorizeAiAssistantSkill(skill, context);
    if (aiAuthorization != null) return aiAuthorization;
    if (skill?.id === 'browser.admin.run_plan') {
      return safety.authorizeSkill(skill, {
        ...context,
        inputs: normalizeBrowserAdminPolicyInputs(context?.inputs || {}),
      });
    }
    return safety.authorizeSkill(skill, context);
  };
  return createSkillRuntime({
    invokePrimitive: createDevicePrimitiveInvoker(deviceRelay),
    registry: createDefaultSkillRegistry(),
    now,
    authorizeSkill,
    panicSwitch: safety.isPanicked,
  });
}

export function getRelaySkillsRuntime(deviceRelay) {
  if (!deviceRelay || (typeof deviceRelay !== 'object' && typeof deviceRelay !== 'function')) {
    throw new Error('deviceRelay is required');
  }
  let runtime = RUNTIMES.get(deviceRelay);
  if (!runtime) {
    runtime = createRelaySkillsRuntime({ deviceRelay });
    RUNTIMES.set(deviceRelay, runtime);
  }
  return runtime;
}
