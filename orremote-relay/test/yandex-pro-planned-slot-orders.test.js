import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDefaultSkillSafetyPolicy } from '../src/skills/safety-policy.js';
import {
  YandexProState,
  createYandexProPlannedSlotOrdersSkill,
  parseOrderDetails,
  parseOrderRow,
  parseSlot,
  recognizeYandexProState,
} from '../src/skills/yandex-pro/planned-slot-orders.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'yandex-pro');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const home = load('home.json');
const money = load('money.json');
const dayIncome = load('day-income.json');
const completedSlot = load('completed-slot.json');
const slotOrders = load('slot-orders.json');
const orderDetail = load('order-detail.json');
const todayContext = (skill) => skill.createContext({ inputs: { date: 'today' } });

test('declares the exact approved read-only safety contract', () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  assert.deepEqual(skill.safety, { effect: 'read_only', risk: 'R0' });
  assert.deepEqual(
    createDefaultSkillSafetyPolicy().authorizeSkill(skill, { inputs: { date: 'today' } }),
    { ok: true },
  );
});

test('recognizes the physical Yandex Pro state-machine fixtures', () => {
  assert.equal(recognizeYandexProState(home), YandexProState.HOME);
  assert.equal(recognizeYandexProState(money), YandexProState.MONEY);
  assert.equal(recognizeYandexProState(dayIncome), YandexProState.DAY_INCOME);
  assert.equal(recognizeYandexProState(completedSlot), YandexProState.COMPLETED_PLANNED_SLOT);
  assert.equal(recognizeYandexProState(slotOrders), YandexProState.SLOT_ORDERS);
  assert.equal(recognizeYandexProState(orderDetail), YandexProState.ORDER_DETAILS);
});

test('active work controls fail closed instead of entering discovery mode', () => {
  const active = {
    ...home,
    fingerprint: 'active-work',
    nodes: [
      { handle: 'live-order', clickable: true, enabled: true, content_description: 'Завершить заказ' },
      { handle: 'route', clickable: true, enabled: true, content_description: 'В путь' },
    ],
  };
  assert.equal(recognizeYandexProState(active), YandexProState.ACTIVE_OR_UNSAFE);
});

test('parses completed planned-slot summary into structured values', () => {
  const parsed = parseSlot(completedSlot);
  assert.deepEqual(parsed, {
    status: 'completed',
    type: 'planned',
    start: '2026.09.15 07:31',
    end: '2026.09.15 22:06',
    declared_order_count: 3,
    distance_km: 12.34,
    total: { amount: 3750, currency: 'RUB' },
    tips: { amount: 450, currency: 'RUB' },
  });
});

test('parses historical order row and completed order details', () => {
  const row = slotOrders.nodes.find((node) => node.handle === 'order-row-a');
  assert.deepEqual(parseOrderRow(row), {
    row_signature: '10:21|Магазин A|100.00|1',
    time: '10:21',
    merchant: 'Магазин A',
    amount: { amount: 100, currency: 'RUB' },
    demand_coefficient: 1,
  });

  assert.deepEqual(parseOrderDetails(orderDetail), {
    order_id: 'TEST-ORDER-001',
    origin: 'Тестовый адрес отправления',
    destination: 'Тестовый адрес доставки',
    amount: { amount: 100, currency: 'RUB' },
    status: 'completed',
    demand_coefficient: 1,
    start: '2026.09.15 10:05',
    end: '2026.09.15 10:21',
  });
});

test('v1 accepts only today and stops before navigation for an explicit date', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  assert.equal(skill.createContext({ inputs: {} }).requestedDate, 'today');
  assert.equal(skill.createContext({ inputs: { date: 'today' } }).requestedDate, 'today');

  const context = skill.createContext({ inputs: { date: '2026-09-15' } });
  const directive = await skill.next({
    state: YandexProState.HOME,
    snapshot: home,
    context,
  });
  assert.deepEqual(directive, {
    type: 'STOP',
    error_code: 'DATE_NOT_SUPPORTED',
    message: 'Yandex Pro M5 v1 currently supports today only.',
  });
});

test('positive allowlist permits only the state-specific safe target', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  const context = todayContext(skill);
  const moneyDirective = { type: 'CLICK_HANDLE', handle: 'home-money', purpose: 'OPEN_MONEY' };
  assert.deepEqual(
    await skill.validateDirective({
      state: YandexProState.HOME,
      snapshot: home,
      directive: moneyDirective,
      context,
    }),
    { ok: true },
  );

  for (const [index, label] of [
    'Добавить слот',
    'Начать слот',
    'Фотоконтроль',
    'Настройки',
    'Способ передвижения',
    'Формат дохода',
  ].entries()) {
    const unsafeSnapshot = {
      ...home,
      nodes: [...home.nodes, {
        handle: `unsafe-${index}`,
        clickable: true,
        enabled: true,
        content_description: label,
      }],
    };
    const verdict = await skill.validateDirective({
      state: YandexProState.HOME,
      snapshot: unsafeSnapshot,
      directive: { type: 'CLICK_HANDLE', handle: `unsafe-${index}`, purpose: 'OPEN_MONEY' },
      context,
    });
    assert.equal(verdict.ok, false, label);
  }

  const unknown = await skill.validateDirective({
    state: YandexProState.HOME,
    snapshot: {
      ...home,
      nodes: [...home.nodes, {
        handle: 'mystery',
        clickable: true,
        enabled: true,
        content_description: 'Неизвестное действие',
      }],
    },
    directive: { type: 'CLICK_HANDLE', handle: 'mystery', purpose: 'OPEN_MONEY' },
    context,
  });
  assert.equal(unknown.ok, false);
});

test('planner requires semantic proof of completed planned slot before opening orders', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  const context = todayContext(skill);

  const directive = await skill.next({
    state: YandexProState.COMPLETED_PLANNED_SLOT,
    snapshot: completedSlot,
    context,
  });
  assert.deepEqual(directive, {
    type: 'CLICK_HANDLE',
    handle: 'slot-orders',
    purpose: 'EXPAND_HISTORICAL_ORDERS',
  });
  assert.equal(context.expectedOrderCount, 3);
  assert.equal(context.slot.status, 'completed');
  assert.equal(context.slot.type, 'planned');

  const notCompleted = structuredClone(completedSlot);
  notCompleted.nodes.find((node) => node.handle === 'slot-details').content_description =
    'Детали\nСтатус\nАктивен\nТип слота\nПлановый\nНачало\n2026.09.15 07:31';
  const unsafeContext = todayContext(skill);
  const unsafeDirective = await skill.next({
    state: YandexProState.COMPLETED_PLANNED_SLOT,
    snapshot: notCompleted,
    context: unsafeContext,
  });
  assert.equal(unsafeDirective.type, 'STOP');
  assert.equal(unsafeDirective.error_code, 'ACTIVE_WORKFLOW_OR_UNSAFE_STATE');
});

test('order detail is captured once and returns only by Back', async () => {
  const skill = createYandexProPlannedSlotOrdersSkill();
  const context = todayContext(skill);
  context.expectedOrderCount = 3;
  context.slot = parseSlot(completedSlot);
  context.pendingRowSignature = '10:21|Магазин A|100.00|1';
  context.pendingRow = parseOrderRow(slotOrders.nodes.find((node) => node.handle === 'order-row-a'));

  const directive = await skill.next({
    state: YandexProState.ORDER_DETAILS,
    snapshot: orderDetail,
    context,
  });

  assert.deepEqual(directive, { type: 'BACK', purpose: 'RETURN_TO_ORDER_LIST' });
  assert.equal(context.orders.length, 1);
  assert.equal(context.orders[0].order_id, 'TEST-ORDER-001');
  assert.equal(context.visitedOrderIds.has('TEST-ORDER-001'), true);
  assert.equal(context.completedRowSignatures.has('10:21|Магазин A|100.00|1'), true);
});
