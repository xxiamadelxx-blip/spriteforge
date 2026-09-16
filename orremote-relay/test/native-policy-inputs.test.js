import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNativePolicyInputs } from '../src/skills/native/policy-inputs.js';

test('native policy normalizer represents visible UI capture as a non-action assertion', () => {
  const normalized = normalizeNativePolicyInputs({
    provider: 'yandex_music',
    steps: [
      { type: 'CAPTURE_VISIBLE_UI', key: 'page' },
      { type: 'CLICK_EXACT_TEXT', text: 'Search' },
    ],
  });
  assert.deepEqual(normalized.steps, [
    { type: 'ASSERT_EXACT_TEXT', text: '__orremote_safe_visible_ui_capture__' },
    { type: 'CLICK_EXACT_TEXT', text: 'Search' },
  ]);
});
