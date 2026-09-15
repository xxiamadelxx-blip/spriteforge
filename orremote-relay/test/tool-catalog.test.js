import test from 'node:test';
import assert from 'node:assert/strict';
import { ANDROID_TOOLS, TOOLS, toolByName } from '../src/tool-catalog.js';

const ANDROID_NAMES = [
  'screen.observe',
  'ui.click',
  'ui.set_text',
  'touch.tap',
  'touch.swipe',
  'system.back',
  'system.home',
  'screen.screenshot',
  'app.list',
  'app.launch',
];

test('Android primitive catalog remains exactly the ten accepted tools', () => {
  assert.deepEqual(ANDROID_TOOLS.map((tool) => tool.name), ANDROID_NAMES);
  assert.equal(new Set(ANDROID_TOOLS.map((tool) => tool.name)).size, 10);
});

test('public MCP catalog adds one relay-hosted skill.run capability', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [...ANDROID_NAMES, 'skill.run']);
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, 11);
  const skill = toolByName('skill.run');
  assert.equal(skill.scope, 'android.control');
  assert.equal(skill.annotations.readOnlyHint, false);
  assert.equal(skill.inputSchema.safeParse({
    skill_id: 'yandex_pro.planned_slot_orders.read',
    inputs: { date: '2026-09-15' },
  }).success, true);
  assert.equal(skill.inputSchema.safeParse({ inputs: {} }).success, false);
});

test('observe tools are read-only and control tools require android.control', () => {
  for (const name of ['screen.observe', 'screen.screenshot', 'app.list']) {
    const tool = toolByName(name);
    assert.equal(tool.scope, 'android.observe');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }

  for (const name of ['ui.click', 'ui.set_text', 'touch.tap', 'touch.swipe', 'system.back', 'system.home', 'app.launch', 'skill.run']) {
    const tool = toolByName(name);
    assert.equal(tool.scope, 'android.control');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test('ui.click schema preserves expected_revision and accepts HANDLE selector', () => {
  const click = toolByName('ui.click');
  assert.equal(click.inputSchema.safeParse({
    expected_revision: 311,
    selector_kind: 'TEXT',
    selector_value: 'M3 REMOTE TEST TARGET',
  }).success, true);
  assert.equal(click.inputSchema.safeParse({
    expected_revision: 311,
    selector_kind: 'HANDLE',
    selector_value: 'observed-node-handle',
  }).success, true);
  assert.equal(click.inputSchema.safeParse({
    selector_kind: 'HANDLE',
    selector_value: 'observed-node-handle',
  }).success, false);
  assert.equal(click.inputSchema.safeParse({
    expected_revision: 311,
    selector_kind: 'BOGUS',
    selector_value: 'target',
  }).success, false);
});

test('ui.set_text schema accepts HANDLE but still requires expected_revision', () => {
  const setText = toolByName('ui.set_text');
  assert.equal(setText.inputSchema.safeParse({
    expected_revision: 311,
    selector_kind: 'HANDLE',
    selector_value: 'observed-editable-handle',
    value: 'replacement',
  }).success, true);
  assert.equal(setText.inputSchema.safeParse({
    selector_kind: 'HANDLE',
    selector_value: 'observed-editable-handle',
    value: 'replacement',
  }).success, false);
});

test('state-changing schemas reject unknown fields and preserve M2 field names', () => {
  assert.equal(toolByName('touch.tap').inputSchema.safeParse({ expected_revision: 1, x: 100, y: 200 }).success, true);
  assert.equal(toolByName('touch.tap').inputSchema.safeParse({ expected_revision: 1, x: 100, y: 200, extra: true }).success, false);
  assert.equal(toolByName('touch.swipe').inputSchema.safeParse({
    expected_revision: 1,
    start_x: 10,
    start_y: 20,
    end_x: 30,
    end_y: 40,
    duration_ms: 250,
  }).success, true);
  assert.equal(toolByName('app.launch').inputSchema.safeParse({ package: 'com.android.settings' }).success, true);
});
