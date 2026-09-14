import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, toolByName } from '../src/tool-catalog.js';

const EXPECTED_NAMES = [
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

test('public MCP catalog exposes exactly the ten verified M2 tools', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), EXPECTED_NAMES);
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, 10);
});

test('observe tools are read-only and control tools require android.control', () => {
  for (const name of ['screen.observe', 'screen.screenshot', 'app.list']) {
    const tool = toolByName(name);
    assert.equal(tool.scope, 'android.observe');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }

  for (const name of ['ui.click', 'ui.set_text', 'touch.tap', 'touch.swipe', 'system.back', 'system.home', 'app.launch']) {
    const tool = toolByName(name);
    assert.equal(tool.scope, 'android.control');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test('ui.click schema preserves the M2 expected_revision and selector contract', () => {
  const click = toolByName('ui.click');
  assert.equal(click.inputSchema.safeParse({
    expected_revision: 311,
    selector_kind: 'TEXT',
    selector_value: 'M3 REMOTE TEST TARGET',
  }).success, true);
  assert.equal(click.inputSchema.safeParse({
    selector_kind: 'TEXT',
    selector_value: 'M3 REMOTE TEST TARGET',
  }).success, false);
  assert.equal(click.inputSchema.safeParse({
    expected_revision: 311,
    selector_kind: 'BOGUS',
    selector_value: 'target',
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
