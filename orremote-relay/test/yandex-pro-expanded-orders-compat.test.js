import assert from 'node:assert/strict';
import test from 'node:test';
import {
  YandexProState,
} from '../src/skills/yandex-pro/planned-slot-orders.js';
import {
  createCurrentYandexProPlannedSlotOrdersSkill,
  recognizeCurrentYandexProState,
} from '../src/skills/yandex-pro/planned-slot-orders-compat.js';

function expandedOrders(extraNodes = []) {
  return {
    package: 'ru.yandex.taximeter',
    revision: 50,
    nodes: [
      { handle: 'slot-title', enabled: true, clickable: false, content_description: 'Слот: 1500,00₽\nSLOT-TEST' },
      { handle: 'slot-summary', enabled: true, clickable: false, content_description: '10:00 — 15:10\n15 заказов • 20,21 км' },
      { handle: 'orders-header', enabled: true, clickable: true, content_description: 'Заказы' },
      { handle: 'row-a', enabled: true, clickable: true, content_description: '10:22\nТеремок\n100,00 ₽\nкоэф 1.0' },
      { handle: 'row-b', enabled: true, clickable: true, content_description: '11:27\nBurger King\n100,00 ₽\nкоэф 1.0' },
      ...extraNodes,
    ],
  };
}

test('recognizes current expanded historical order list without legacy status/type block', () => {
  assert.equal(
    recognizeCurrentYandexProState(expandedOrders()),
    YandexProState.SLOT_ORDERS,
  );
});

test('current expanded-list compatibility remains fail-closed when active work controls appear', () => {
  assert.equal(
    recognizeCurrentYandexProState(expandedOrders([
      { handle: 'active-order', enabled: true, clickable: true, content_description: 'Завершить заказ' },
    ])),
    YandexProState.ACTIVE_OR_UNSAFE,
  );
});

test('current compatibility skill preserves the approved read-only identity', () => {
  const skill = createCurrentYandexProPlannedSlotOrdersSkill();
  assert.equal(skill.id, 'yandex_pro.planned_slot_orders.read');
  assert.deepEqual(skill.safety, { effect: 'read_only', risk: 'R0' });
  assert.deepEqual(skill.packages, ['ru.yandex.taximeter']);
  assert.equal(skill.version, 2);
});

test('fresh run inside expanded order list backs out once to restore completed-slot proof', async () => {
  const skill = createCurrentYandexProPlannedSlotOrdersSkill();
  const context = skill.createContext({ inputs: { date: 'today' } });
  const snapshot = expandedOrders();

  const first = await skill.next({
    state: YandexProState.SLOT_ORDERS,
    snapshot,
    context,
    inputs: { date: 'today' },
  });
  assert.deepEqual(first, {
    type: 'BACK',
    purpose: 'RESTORE_HISTORICAL_SLOT_PROOF',
  });
  assert.deepEqual(
    await skill.validateDirective({
      state: YandexProState.SLOT_ORDERS,
      snapshot,
      directive: first,
      context,
      inputs: { date: 'today' },
    }),
    { ok: true },
  );

  const second = await skill.next({
    state: YandexProState.SLOT_ORDERS,
    snapshot,
    context,
    inputs: { date: 'today' },
  });
  assert.equal(second.type, 'STOP');
  assert.equal(second.error_code, 'HISTORICAL_SLOT_PROOF_RECOVERY_FAILED');
});
