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

function nodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function text(node) {
  return String(node?.content_description ?? node?.text ?? '').trim();
}

function activeWorkDetected(snapshot) {
  return nodes(snapshot).some((node) => ACTIVE_WORK_PATTERNS.some((pattern) => pattern.test(text(node))));
}

function looksLikeExpandedHistoricalSlot(snapshot) {
  if (snapshot?.package !== YANDEX_PRO_PACKAGE || activeWorkDetected(snapshot)) return false;

  const list = nodes(snapshot);
  const hasSlotHeader = list.some((node) => /^слот:\s*[^\n]+(?:\n|$)/i.test(text(node)));
  const hasSummary = list.some((node) => /\d+\s+заказ/i.test(text(node)) && /\d+(?:[.,]\d+)?\s*км/i.test(text(node)));
  const hasOrdersHeader = list.some((node) => node?.clickable === true && /^заказы$/i.test(text(node)));
  const parsedRows = list.filter((node) => node?.clickable === true && parseOrderRow(node) != null);

  return hasSlotHeader && hasSummary && hasOrdersHeader && parsedRows.length > 0;
}

export function recognizeCurrentYandexProState(snapshot) {
  const base = recognizeYandexProState(snapshot);
  if (base !== YandexProState.UNKNOWN) return base;
  return looksLikeExpandedHistoricalSlot(snapshot)
    ? YandexProState.SLOT_ORDERS
    : YandexProState.UNKNOWN;
}

export function createCurrentYandexProPlannedSlotOrdersSkill(options) {
  const base = createYandexProPlannedSlotOrdersSkill(options);
  return Object.freeze({
    ...base,
    version: 2,
    recognize(snapshot) {
      return recognizeCurrentYandexProState(snapshot);
    },
  });
}
