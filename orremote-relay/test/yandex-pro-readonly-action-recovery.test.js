import assert from 'node:assert/strict';
import test from 'node:test';
import { createCurrentYandexProPlannedSlotOrdersSkill } from '../src/skills/yandex-pro/planned-slot-orders-compat.js';

const allowed = [
  'OPEN_MONEY',
  'OPEN_DAY',
  'OPEN_COMPLETED_PLANNED_SLOT',
  'EXPAND_HISTORICAL_ORDERS',
  'OPEN_HISTORICAL_ORDER',
  'RETURN_TO_ORDER_LIST',
  'SEARCH_PLANNED_SLOT',
  'SEARCH_MORE_ORDERS',
  'RESTORE_HISTORICAL_SLOT_PROOF',
];

test('Yandex read-only navigation may reobserve after transient session ambiguity', async () => {
  const skill = createCurrentYandexProPlannedSlotOrdersSkill();
  for (const purpose of allowed) {
    assert.deepEqual(
      await skill.recoverPrimitiveError({
        directive: { type: 'CLICK_HANDLE', purpose },
        error_code: 'SESSION_SUPERSEDED',
      }),
      { reobserve: true },
    );
    assert.deepEqual(
      await skill.recoverPrimitiveError({
        directive: { type: 'CLICK_HANDLE', purpose },
        error_code: 'DEVICE_OFFLINE',
      }),
      { reobserve: true },
    );
  }
});

test('Yandex ambiguous action recovery rejects unknown purposes and non-transient errors', async () => {
  const skill = createCurrentYandexProPlannedSlotOrdersSkill();
  assert.deepEqual(
    await skill.recoverPrimitiveError({
      directive: { type: 'CLICK_HANDLE', purpose: 'REPORT_PROBLEM' },
      error_code: 'SESSION_SUPERSEDED',
    }),
    { reobserve: false },
  );
  assert.deepEqual(
    await skill.recoverPrimitiveError({
      directive: { type: 'CLICK_HANDLE', purpose: 'OPEN_HISTORICAL_ORDER' },
      error_code: 'USER_AUTH_REQUIRED',
    }),
    { reobserve: false },
  );
});
