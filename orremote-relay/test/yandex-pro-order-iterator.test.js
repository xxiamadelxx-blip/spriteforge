import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  YandexProState,
  createYandexProPlannedSlotOrdersSkill,
  parseOrderDetails,
  parseOrderRow,
  parseSlot,
} from '../src/skills/yandex-pro/planned-slot-orders.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'yandex-pro');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const slotOrders = load('slot-orders.json');
const completedSlot = load('completed-slot.json');
const orderDetail = load('order-detail.json');

function preparedContext(skill) {
  const context = skill.createContext({ inputs: { date: 'today' } });
  context.slot = parseSlot(completedSlot);
  context.expectedOrderCount = 3;
  return context;
}

test('same order ID is stored once even if reached from another row signature', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  const context = preparedContext(skill);

  for (const handle of ['order-row-a', 'order-row-b']) {
    const row = parseOrderRow(slotOrders.nodes.find((node) => node.handle === handle));
    context.pendingRow = row;
    context.pendingRowSignature = row.row_signature;
    const directive = await skill.next({
      state: YandexProState.ORDER_DETAILS,
      snapshot: orderDetail,
      context,
    });
    assert.equal(directive.type, 'BACK');
  }

  assert.equal(context.orders.length, 1);
  assert.equal(context.visitedOrderIds.size, 1);
  assert.equal(context.completedRowSignatures.size, 2);
});

test('completed enumeration requires unique order IDs to equal declared count', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  const context = preparedContext(skill);
  context.visitedOrderIds = new Set(['ORDER-A', 'ORDER-B', 'ORDER-C']);
  context.orders = [{ order_id: 'ORDER-A' }, { order_id: 'ORDER-B' }, { order_id: 'ORDER-C' }];

  const directive = await skill.next({
    state: YandexProState.SLOT_ORDERS,
    snapshot: slotOrders,
    context,
  });

  assert.equal(directive.type, 'COMPLETE');
  assert.equal(directive.output.orders.length, 3);
});

test('cannot claim completion when declared order count is still missing', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill({ maxOrderScrolls: 0 });
  const context = preparedContext(skill);
  const visibleRows = slotOrders.nodes.map(parseOrderRow).filter(Boolean);
  for (const row of visibleRows) context.completedRowSignatures.add(row.row_signature);
  context.visitedOrderIds = new Set(['ORDER-A', 'ORDER-B']);

  const directive = await skill.next({
    state: YandexProState.SLOT_ORDERS,
    snapshot: slotOrders,
    context,
  });

  assert.equal(directive.type, 'STOP');
  assert.equal(directive.error_code, 'INCOMPLETE_ORDER_ENUMERATION');
});

test('identical exhausted viewport eventually stops with SCROLL_NO_PROGRESS', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill({ maxOrderScrolls: 10, maxNoProgress: 2 });
  const context = preparedContext(skill);
  const visibleRows = slotOrders.nodes.map(parseOrderRow).filter(Boolean);
  for (const row of visibleRows) context.completedRowSignatures.add(row.row_signature);
  context.visitedOrderIds = new Set(['ORDER-A', 'ORDER-B']);

  const first = await skill.next({ state: YandexProState.SLOT_ORDERS, snapshot: slotOrders, context });
  const second = await skill.next({ state: YandexProState.SLOT_ORDERS, snapshot: slotOrders, context });
  const third = await skill.next({ state: YandexProState.SLOT_ORDERS, snapshot: slotOrders, context });

  assert.equal(first.type, 'SWIPE');
  assert.equal(second.type, 'SWIPE');
  assert.equal(third.type, 'STOP');
  assert.equal(third.error_code, 'SCROLL_NO_PROGRESS');
});

test('ORDER_DETAILS result is never allowed to click feedback or report-problem UI', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  const context = preparedContext(skill);
  const parsed = parseOrderDetails(orderDetail);
  assert.equal(parsed.status, 'completed');

  for (const handle of ['order-feedback', 'order-problem']) {
    const verdict = await skill.validateDirective({
      state: YandexProState.ORDER_DETAILS,
      snapshot: orderDetail,
      directive: { type: 'CLICK_HANDLE', handle, purpose: 'ANYTHING' },
      context,
    });
    assert.equal(verdict.ok, false);
  }
});
