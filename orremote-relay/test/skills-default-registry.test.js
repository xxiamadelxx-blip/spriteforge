import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSkillRegistry, getRelaySkillsRuntime } from '../src/skills/index.js';

test('default registry exposes only explicitly approved M5 skills', () => {
  const registry = createDefaultSkillRegistry();
  assert.deepEqual(
    registry.list().map((skill) => skill.id),
    [
      'yandex_pro.planned_slot_orders.read',
      'settings.device_info.read',
      'files.downloads.apks.read',
      'browser.admin.run_plan',
      'media.discovery.run_plan',
      'delivery.consumer.build_cart',
      'ai.assistant.run_plan',
    ],
  );
});

test('MCP and Supabase can share one runtime instance for the same device relay', () => {
  const deviceRelay = {
    async forwardMcp() { throw new Error('not called by construction'); },
  };
  assert.equal(getRelaySkillsRuntime(deviceRelay), getRelaySkillsRuntime(deviceRelay));
  assert.notEqual(
    getRelaySkillsRuntime(deviceRelay),
    getRelaySkillsRuntime({ async forwardMcp() { throw new Error('other relay'); } }),
  );
});
