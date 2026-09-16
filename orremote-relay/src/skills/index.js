import { createDevicePrimitiveInvoker } from './device-invoker.js';
import { createSkillRegistry } from './registry.js';
import { createSkillRuntime } from './runtime.js';
import { createDefaultSkillSafetyPolicy } from './safety-policy.js';
import { createFilesDownloadsApksSkill } from './files/downloads-apks.js';
import { createSettingsDeviceInfoSkill } from './settings/device-info.js';
import { createYandexProPlannedSlotOrdersSkill } from './yandex-pro/planned-slot-orders.js';

const RUNTIMES = new WeakMap();

export function createDefaultSkillRegistry() {
  return createSkillRegistry([
    createYandexProPlannedSlotOrdersSkill(),
    createSettingsDeviceInfoSkill(),
    createFilesDownloadsApksSkill(),
  ]);
}

export function createRelaySkillsRuntime({ deviceRelay, now = () => Date.now() }) {
  const safety = createDefaultSkillSafetyPolicy();
  return createSkillRuntime({
    invokePrimitive: createDevicePrimitiveInvoker(deviceRelay),
    registry: createDefaultSkillRegistry(),
    now,
    authorizeSkill: safety.authorizeSkill,
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
