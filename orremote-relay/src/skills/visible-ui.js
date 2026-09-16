const SENSITIVE_LABEL_PATTERN = /(?:password|passcode|pin|otp|2fa|two[- ]?factor|verification code|security code|api[ _-]?token|access[ _-]?token|secret|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|токен|секрет)/iu;
const SECRET_VALUE_PATTERN = /(?:glpat-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|Bearer\s+[A-Za-z0-9._~-]{8,})/iu;
const MAX_VISIBLE_ITEMS = 200;
const MAX_TEXT_CHARS = 500;
const MAX_SERIALIZED_CHARS = 20_000;

function clean(value) {
  return String(value ?? '').trim().slice(0, MAX_TEXT_CHARS);
}

function descriptor(node) {
  return [node?.text, node?.content_description, node?.resource_id, node?.class_name]
    .filter(Boolean)
    .join(' ');
}

function isSensitive(node) {
  if (node?.sensitive === true) return true;
  const value = descriptor(node);
  return SENSITIVE_LABEL_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value);
}

function publicNode(node) {
  const editable = node?.editable === true;
  return {
    text: editable ? '' : clean(node?.text),
    content_description: clean(node?.content_description),
    resource_id: clean(node?.resource_id),
    class_name: clean(node?.class_name),
    clickable: node?.clickable === true,
    editable,
  };
}

export function sanitizeVisibleUi(snapshot) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const result = [];
  let serializedChars = 2;

  for (const node of nodes) {
    if (result.length >= MAX_VISIBLE_ITEMS) break;
    if (isSensitive(node)) continue;
    const item = publicNode(node);
    if (!item.text && !item.content_description && !item.resource_id && !item.class_name) continue;
    const encoded = JSON.stringify(item);
    if (serializedChars + encoded.length > MAX_SERIALIZED_CHARS) break;
    serializedChars += encoded.length + 1;
    result.push(item);
  }
  return result;
}
