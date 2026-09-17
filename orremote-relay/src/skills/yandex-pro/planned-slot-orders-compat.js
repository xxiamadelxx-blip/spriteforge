import {
  YANDEX_PRO_PACKAGE,
  YandexProState,
  createYandexProPlannedSlotOrdersSkill,
  parseOrderRow,
  recognizeYandexProState,
} from './planned-slot-orders.js';

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

const PROOF_RECOVERY_PURPOSE = 'RESTORE_HISTORICAL_SLOT_PROOF';
const REOBSERVABLE_READ_ONLY_PURPOSES = new Set([
  'OPEN_YANDEX_PRO',
  'OPEN_MONEY',
  'OPEN_DAY',
  'OPEN_COMPLETED_PLANNED_SLOT',
  'EXPAND_HISTORICAL_ORDERS',
  'OPEN_HISTORICAL_ORDER',
  'RETURN_TO_ORDER_LIST',
  'SEARCH_PLANNED_SLOT',
  'SEARCH_MORE_ORDERS',
  PROOF_RECOVERY_PURPOSE,
]);

function nodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function text(node) {
  return String(node?.content_description ?? node?.text ?? '').trim();
}

function normalizedText(node) {
  return text(node).replace(/\s+/g, ' ').trim();
}

function activeWorkDetected(snapshot) {
  return nodes(snapshot).some((node) => ACTIVE_WORK_PATTERNS.some((pattern) => pattern.test(text(node))));
}

function hasCompletedPlannedSlotProof(snapshot) {
  return nodes(snapshot).some((node) => {
    const value = normalizedText(node);
    return /статус\s+завершён/i.test(value)
      && /тип\s+слота\s+плановый/i.test(value);
  });
}

function hasPersistedCompletedPlannedProof(context) {
  return context?.slot?.status === 'completed'
    && context?.slot?.type === 'planned'
    && Number.isInteger(context?.expectedOrderCount)
    && context.expectedOrderCount >= 0;
}

function parsedOrderRows(snapshot) {
  return nodes(snapshot).filter((node) => node?.clickable === true && parseOrderRow(node) != null);
}

function looksLikeExpandedHistoricalSlot(snapshot) {
  if (snapshot?.package !== YANDEX_PRO_PACKAGE || activeWorkDetected(snapshot)) return false;

  const list = nodes(snapshot);
  const hasSlotHeader = list.some((node) => /^слот:\s*[^\n]+(?:\n|$)/i.test(text(node)));
  const hasSummary = list.some((node) => /\d+\s+заказ/i.test(text(node)) && /\d+(?:[.,]\d+)?\s*км/i.test(text(node)));
  const hasOrdersHeader = list.some((node) => node?.clickable === true && /^заказы$/i.test(text(node)));
  const parsedRows = parsedOrderRows(snapshot);
  const topOfListProof = hasSummary && hasOrdersHeader;
  const scrolledCompletedProof = hasCompletedPlannedSlotProof(snapshot);

  return hasSlotHeader
    && parsedRows.length > 0
    && (topOfListProof || scrolledCompletedProof);
}

function looksLikePersistedHistoricalViewport(snapshot, context) {
  if (snapshot?.package !== YANDEX_PRO_PACKAGE || activeWorkDetected(snapshot)) return false;
  if (!hasPersistedCompletedPlannedProof(context)) return false;
  return parsedOrderRows(snapshot).length > 0;
}

export function recognizeCurrentYandexProState(snapshot, context = null) {
  const base = recognizeYandexProState(snapshot);
  if (base !== YandexProState.UNKNOWN) return base;
  if (looksLikeExpandedHistoricalSlot(snapshot)) return YandexProState.SLOT_ORDERS;
  return looksLikePersistedHistoricalViewport(snapshot, context)
    ? YandexProState.SLOT_ORDERS
    : YandexProState.UNKNOWN;
}

export function createCurrentYandexProPlannedSlotOrdersSkill(options) {
  const base = createYandexProPlannedSlotOrdersSkill(options);
  return Object.freeze({
    ...base,
    version: 2,
    recognize(snapshot, context) {
      return recognizeCurrentYandexProState(snapshot, context);
    },
    async next(args) {
      const { state, context } = args;
      if (
        state === YandexProState.SLOT_ORDERS
        && (context?.slot == null || context?.expectedOrderCount == null)
      ) {
        const attempts = Number(context?.compatProofRecoveryAttempts || 0);
        if (attempts >= 1) {
          return {
            type: 'STOP',
            error_code: 'HISTORICAL_SLOT_PROOF_RECOVERY_FAILED',
            message: 'Historical slot proof could not be restored from the already-open order list.',
          };
        }
        context.compatProofRecoveryAttempts = attempts + 1;
        return { type: 'BACK', purpose: PROOF_RECOVERY_PURPOSE };
      }
      return base.next(args);
    },
    async validateDirective(args) {
      const { state, directive } = args;
      if (
        state === YandexProState.SLOT_ORDERS
        && directive?.type === 'BACK'
        && directive?.purpose === PROOF_RECOVERY_PURPOSE
      ) {
        return { ok: true };
      }
      return base.validateDirective(args);
    },
    async recoverPrimitiveError({ directive, error_code }) {
      const transientSessionChange = error_code === 'SESSION_SUPERSEDED' || error_code === 'DEVICE_OFFLINE';
      const approvedPurpose = REOBSERVABLE_READ_ONLY_PURPOSES.has(String(directive?.purpose || ''));
      return {
        reobserve: transientSessionChange && approvedPurpose,
      };
    },
  });
}
