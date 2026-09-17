export const YANDEX_PRO_PACKAGE = 'ru.yandex.taximeter';

export const YandexProState = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HOME: 'HOME',
  MONEY: 'MONEY',
  DAY_INCOME: 'DAY_INCOME',
  COMPLETED_PLANNED_SLOT: 'COMPLETED_PLANNED_SLOT',
  SLOT_ORDERS: 'SLOT_ORDERS',
  ORDER_DETAILS: 'ORDER_DETAILS',
  ACTIVE_OR_UNSAFE: 'ACTIVE_OR_UNSAFE',
});

const ACTIVE_WORK_PATTERNS = [
  /завершить\s+заказ/i,
  /принять\s+заказ/i,
  /отказаться\s+от\s+заказа/i,
  /в\s+путь/i,
  /на\s+месте/i,
  /забра(?:л|ть)\s+заказ/i,
  /достав(?:ить|ил)\s+заказ/i,
  /начать\s+выполнение/i,
];

function nodeText(node) {
  return String(node?.content_description ?? node?.text ?? '').trim();
}

function lines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function nodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function enabledClickable(node) {
  return node?.enabled !== false && node?.clickable === true && typeof node?.handle === 'string' && node.handle.length > 0;
}

function findNode(snapshot, predicate) {
  return nodes(snapshot).find((node) => predicate(node, nodeText(node))) || null;
}

function valueAfter(label, content) {
  const parts = lines(content);
  const index = parts.findIndex((part) => part.toLocaleLowerCase('ru-RU') === label.toLocaleLowerCase('ru-RU'));
  return index >= 0 ? parts[index + 1] ?? null : null;
}

function parseNumber(value) {
  if (value == null) return null;
  const normalized = String(value)
    .replace(/[\u00a0\u202f\s]/g, '')
    .replace(',', '.')
    .replace(/[^0-9.+-]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const amount = parseNumber(value);
  return amount == null ? null : { amount, currency: 'RUB' };
}

function statusValue(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('ru-RU');
  if (normalized === 'завершён' || normalized === 'завершен') return 'completed';
  return normalized || null;
}

function slotTypeValue(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('ru-RU');
  if (normalized === 'плановый') return 'planned';
  return normalized || null;
}

function isPlannedSlotRow(node) {
  return enabledClickable(node) && /плановый\s+слот/i.test(nodeText(node));
}

function orderRows(snapshot) {
  return nodes(snapshot)
    .map((node) => ({ node, parsed: parseOrderRow(node) }))
    .filter(({ node, parsed }) => enabledClickable(node) && parsed != null);
}

function activeWorkDetected(snapshot) {
  return nodes(snapshot).some((node) => ACTIVE_WORK_PATTERNS.some((pattern) => pattern.test(nodeText(node))));
}

export function parseOrderRow(node) {
  const parts = lines(nodeText(node));
  if (parts.length < 4) return null;
  const time = parts[0];
  if (!/^\d{1,2}:\d{2}$/.test(time)) return null;
  const merchant = parts[1];
  const amount = money(parts[2]);
  const coefficientMatch = parts[3].match(/^коэф\s+([0-9]+(?:[.,][0-9]+)?)$/i);
  if (!merchant || !amount || !coefficientMatch) return null;
  const demandCoefficient = parseNumber(coefficientMatch[1]);
  if (demandCoefficient == null) return null;
  return {
    row_signature: `${time}|${merchant}|${amount.amount.toFixed(2)}|${demandCoefficient}`,
    time,
    merchant,
    amount,
    demand_coefficient: demandCoefficient,
  };
}

export function parseSlot(snapshot) {
  const detailsNode = findNode(snapshot, (_node, text) => /статус/i.test(text) && /тип\s+слота/i.test(text));
  const summaryNode = findNode(snapshot, (_node, text) => /заказ/i.test(text) && /км/i.test(text));
  const totalNode = findNode(snapshot, (_node, text) => /^итого(?:\n|$)/i.test(text));
  const tipsNode = findNode(snapshot, (_node, text) => /^чаевые(?:\n|$)/i.test(text));
  if (!detailsNode || !summaryNode) return null;

  const details = nodeText(detailsNode);
  const summary = nodeText(summaryNode);
  const countMatch = summary.match(/(\d+)\s+заказ/i);
  const distanceMatch = summary.match(/([0-9]+(?:[.,][0-9]+)?)\s*км/i);
  const declaredOrderCount = countMatch ? Number(countMatch[1]) : null;
  const distanceKm = distanceMatch ? parseNumber(distanceMatch[1]) : null;

  return {
    status: statusValue(valueAfter('Статус', details)),
    type: slotTypeValue(valueAfter('Тип слота', details)),
    start: valueAfter('Начало', details),
    end: valueAfter('Завершение', details),
    declared_order_count: Number.isInteger(declaredOrderCount) ? declaredOrderCount : null,
    distance_km: distanceKm,
    total: totalNode ? money(lines(nodeText(totalNode))[1]) : null,
    tips: tipsNode ? money(lines(nodeText(tipsNode))[1]) : null,
  };
}

export function parseOrderDetails(snapshot) {
  const originNode = findNode(snapshot, (_node, text) => /^откуда(?:\n|$)/i.test(text));
  const destinationNode = findNode(snapshot, (_node, text) => /^куда(?:\n|$)/i.test(text));
  const detailNode = findNode(snapshot, (_node, text) => /номер\s+заказа/i.test(text) && /коэффициент\s+спроса/i.test(text));
  if (!originNode || !destinationNode || !detailNode) return null;

  const totalValueNode = nodes(snapshot).find((node) => {
    const text = nodeText(node);
    return /^[-+]?\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?\s*₽$/.test(text);
  });
  const details = nodeText(detailNode);
  const amount = totalValueNode ? money(nodeText(totalValueNode)) : null;
  const coefficient = parseNumber(valueAfter('Коэффициент спроса', details));

  return {
    order_id: valueAfter('Номер заказа', details),
    origin: lines(nodeText(originNode))[1] ?? null,
    destination: lines(nodeText(destinationNode))[1] ?? null,
    amount,
    status: statusValue(valueAfter('Статус', details)),
    demand_coefficient: coefficient,
    start: valueAfter('Начало', details),
    end: valueAfter('Завершение', details),
  };
}

export function recognizeYandexProState(snapshot) {
  if (snapshot?.package !== YANDEX_PRO_PACKAGE) return YandexProState.UNKNOWN;
  if (activeWorkDetected(snapshot)) return YandexProState.ACTIVE_OR_UNSAFE;

  const texts = nodes(snapshot).map(nodeText);
  const has = (pattern) => texts.some((text) => pattern.test(text));

  if (
    has(/^заказ$/i)
    && has(/^откуда(?:\n|$)/i)
    && has(/^куда(?:\n|$)/i)
    && has(/номер\s+заказа/i)
  ) {
    return YandexProState.ORDER_DETAILS;
  }

  const slot = parseSlot(snapshot);
  if (slot) {
    if (slot.status !== 'completed' || slot.type !== 'planned') {
      return YandexProState.ACTIVE_OR_UNSAFE;
    }
    return orderRows(snapshot).length > 0
      ? YandexProState.SLOT_ORDERS
      : YandexProState.COMPLETED_PLANNED_SLOT;
  }

  if (has(/^день$/i) && has(/^неделя$/i) && has(/^месяц$/i)) {
    return YandexProState.DAY_INCOME;
  }

  if (has(/^сегодня(?:\n|$)/i) && has(/^деньги(?:\n|$)/i)) {
    return YandexProState.MONEY;
  }

  if (has(/^главная$/i) && (has(/^расписание$/i) || has(/^деньги$/i))) {
    return YandexProState.HOME;
  }

  return YandexProState.UNKNOWN;
}

function allowedClick(state, snapshot, directive) {
  const target = nodes(snapshot).find((node) => node.handle === directive.handle);
  if (!target || !enabledClickable(target)) return false;
  const text = nodeText(target);

  switch (state) {
    case YandexProState.HOME:
      return directive.purpose === 'OPEN_MONEY' && /^деньги$/i.test(text);
    case YandexProState.MONEY:
      return directive.purpose === 'OPEN_DAY' && /^сегодня(?:\n|$)/i.test(text);
    case YandexProState.DAY_INCOME:
      return directive.purpose === 'OPEN_COMPLETED_PLANNED_SLOT' && isPlannedSlotRow(target);
    case YandexProState.COMPLETED_PLANNED_SLOT: {
      const slot = parseSlot(snapshot);
      return directive.purpose === 'EXPAND_HISTORICAL_ORDERS'
        && slot?.status === 'completed'
        && slot?.type === 'planned'
        && /^заказы$/i.test(text);
    }
    case YandexProState.SLOT_ORDERS:
      return directive.purpose === 'OPEN_HISTORICAL_ORDER' && parseOrderRow(target) != null;
    default:
      return false;
  }
}

function safeSwipeDirective(purpose) {
  return {
    type: 'SWIPE',
    start_x: 540,
    start_y: 1900,
    end_x: 540,
    end_y: 700,
    duration_ms: 350,
    purpose,
  };
}

export function createYandexProPlannedSlotOrdersSkill({
  maxIncomeScrolls = 12,
  maxOrderScrolls = 30,
  maxNoProgress = 2,
} = {}) {
  return Object.freeze({
    id: 'yandex_pro.planned_slot_orders.read',
    version: 1,
    packages: [YANDEX_PRO_PACKAGE],
    safety: Object.freeze({
      effect: 'read_only',
      risk: 'R0',
    }),

    createContext({ inputs = {} } = {}) {
      return {
        requestedDate: String(inputs.date || 'today').trim().toLocaleLowerCase('en-US'),
        slot: null,
        expectedOrderCount: null,
        orders: [],
        visitedOrderIds: new Set(),
        completedRowSignatures: new Set(),
        pendingRowSignature: null,
        pendingRow: null,
        incomeScrolls: 0,
        orderScrolls: 0,
        lastOrderViewport: null,
        noProgressCount: 0,
      };
    },

    recognize(snapshot) {
      return recognizeYandexProState(snapshot);
    },

    async next({ state, snapshot, context }) {
      if (context.requestedDate !== 'today') {
        return {
          type: 'STOP',
          error_code: 'DATE_NOT_SUPPORTED',
          message: 'Yandex Pro M5 v1 currently supports today only.',
        };
      }

      switch (state) {
        case YandexProState.ACTIVE_OR_UNSAFE:
          return {
            type: 'STOP',
            error_code: 'ACTIVE_WORKFLOW_OR_UNSAFE_STATE',
            message: 'Yandex Pro is in an active or unsafe work state.',
          };

        case YandexProState.UNKNOWN:
          if (snapshot?.package !== YANDEX_PRO_PACKAGE) {
            return { type: 'LAUNCH', package: YANDEX_PRO_PACKAGE, purpose: 'OPEN_YANDEX_PRO' };
          }
          return {
            type: 'STOP',
            error_code: 'AMBIGUOUS_STATE',
            message: 'Yandex Pro screen is not recognized as a proven safe state.',
          };

        case YandexProState.HOME: {
          const target = findNode(snapshot, (node, text) => enabledClickable(node) && /^деньги$/i.test(text));
          if (!target) return { type: 'STOP', error_code: 'SAFE_TARGET_NOT_FOUND', message: 'Money entry was not found.' };
          return { type: 'CLICK_HANDLE', handle: target.handle, purpose: 'OPEN_MONEY' };
        }

        case YandexProState.MONEY: {
          const target = findNode(snapshot, (node, text) => enabledClickable(node) && /^сегодня(?:\n|$)/i.test(text));
          if (!target) return { type: 'STOP', error_code: 'SAFE_TARGET_NOT_FOUND', message: 'Today entry was not found.' };
          return { type: 'CLICK_HANDLE', handle: target.handle, purpose: 'OPEN_DAY' };
        }

        case YandexProState.DAY_INCOME: {
          const target = nodes(snapshot).find(isPlannedSlotRow);
          if (target) {
            return { type: 'CLICK_HANDLE', handle: target.handle, purpose: 'OPEN_COMPLETED_PLANNED_SLOT' };
          }
          if (context.incomeScrolls >= maxIncomeScrolls) {
            return {
              type: 'STOP',
              error_code: 'PLANNED_SLOT_NOT_FOUND',
              message: 'Planned slot row was not found within the bounded income search.',
            };
          }
          context.incomeScrolls += 1;
          return safeSwipeDirective('SEARCH_PLANNED_SLOT');
        }

        case YandexProState.COMPLETED_PLANNED_SLOT: {
          const slot = parseSlot(snapshot);
          if (!slot || slot.status !== 'completed' || slot.type !== 'planned') {
            return {
              type: 'STOP',
              error_code: 'ACTIVE_WORKFLOW_OR_UNSAFE_STATE',
              message: 'Slot is not semantically proven completed and planned.',
            };
          }
          if (!Number.isInteger(slot.declared_order_count) || slot.declared_order_count < 0) {
            return { type: 'STOP', error_code: 'SLOT_PARSE_FAILED', message: 'Slot order count is missing.' };
          }
          context.slot = slot;
          context.expectedOrderCount = slot.declared_order_count;
          const target = findNode(snapshot, (node, text) => enabledClickable(node) && /^заказы$/i.test(text));
          if (!target) return { type: 'STOP', error_code: 'SAFE_TARGET_NOT_FOUND', message: 'Historical Orders tray was not found.' };
          return { type: 'CLICK_HANDLE', handle: target.handle, purpose: 'EXPAND_HISTORICAL_ORDERS' };
        }

        case YandexProState.SLOT_ORDERS: {
          if (context.slot == null || context.expectedOrderCount == null) {
            const slot = parseSlot(snapshot);
            if (!slot || slot.status !== 'completed' || slot.type !== 'planned') {
              return { type: 'STOP', error_code: 'ACTIVE_WORKFLOW_OR_UNSAFE_STATE', message: 'Historical slot proof was lost.' };
            }
            context.slot = slot;
            context.expectedOrderCount = slot.declared_order_count;
          }

          if (context.visitedOrderIds.size === context.expectedOrderCount) {
            return {
              type: 'COMPLETE',
              output: {
                slot: context.slot,
                orders: [...context.orders],
              },
            };
          }

          const visible = orderRows(snapshot);
          const nextRow = visible.find(({ parsed }) => !context.completedRowSignatures.has(parsed.row_signature));
          if (nextRow) {
            context.pendingRowSignature = nextRow.parsed.row_signature;
            context.pendingRow = nextRow.parsed;
            return {
              type: 'CLICK_HANDLE',
              handle: nextRow.node.handle,
              purpose: 'OPEN_HISTORICAL_ORDER',
            };
          }

          const viewport = visible.map(({ parsed }) => parsed.row_signature).join('||');
          if (viewport && viewport === context.lastOrderViewport) context.noProgressCount += 1;
          else context.noProgressCount = 0;
          context.lastOrderViewport = viewport;

          if (context.noProgressCount >= maxNoProgress) {
            return {
              type: 'STOP',
              error_code: 'SCROLL_NO_PROGRESS',
              message: 'Historical order list stopped making progress.',
            };
          }
          if (context.orderScrolls >= maxOrderScrolls) {
            return {
              type: 'STOP',
              error_code: 'INCOMPLETE_ORDER_ENUMERATION',
              message: `Collected ${context.visitedOrderIds.size} of ${context.expectedOrderCount} declared orders.`,
            };
          }
          context.orderScrolls += 1;
          return safeSwipeDirective('SEARCH_MORE_ORDERS');
        }

        case YandexProState.ORDER_DETAILS: {
          const details = parseOrderDetails(snapshot);
          if (!details || details.status !== 'completed' || !details.order_id) {
            return {
              type: 'STOP',
              error_code: 'ACTIVE_WORKFLOW_OR_UNSAFE_STATE',
              message: 'Order is not semantically proven historical and completed.',
            };
          }

          if (!context.visitedOrderIds.has(details.order_id)) {
            context.visitedOrderIds.add(details.order_id);
            context.orders.push({
              ...details,
              merchant: context.pendingRow?.merchant ?? null,
              completed_at_time: context.pendingRow?.time ?? null,
            });
          }
          if (context.pendingRowSignature) context.completedRowSignatures.add(context.pendingRowSignature);
          context.pendingRowSignature = null;
          context.pendingRow = null;
          return { type: 'BACK', purpose: 'RETURN_TO_ORDER_LIST' };
        }

        default:
          return { type: 'STOP', error_code: 'AMBIGUOUS_STATE', message: 'Unsupported Yandex Pro state.' };
      }
    },

    async validateDirective({ state, snapshot, directive }) {
      if (directive.type === 'LAUNCH') {
        return state === YandexProState.UNKNOWN && directive.package === YANDEX_PRO_PACKAGE
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'CLICK_HANDLE') {
        return allowedClick(state, snapshot, directive)
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'BACK') {
        return state === YandexProState.ORDER_DETAILS && directive.purpose === 'RETURN_TO_ORDER_LIST'
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'SWIPE') {
        const safePurpose = (
          state === YandexProState.DAY_INCOME && directive.purpose === 'SEARCH_PLANNED_SLOT'
        ) || (
          state === YandexProState.SLOT_ORDERS && directive.purpose === 'SEARCH_MORE_ORDERS'
        );
        return safePurpose
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      return { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
    },

    acceptResult() {
      return null;
    },
  });
}