import crypto from 'node:crypto';
import { createCredential, verifyCredential } from './credentials.js';

const COOKIE_NAME = 'orremote_work';
const MCP_PROTOCOL_VERSION = '2026-07-28';
const SELECTOR_KINDS = new Set(['TEXT', 'CONTENT_DESCRIPTION', 'RESOURCE_ID', 'CLASS_NAME']);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseCookies(header) {
  const result = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result.set(key, value);
  }
  return result;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#f5f7fa}main{border:1px solid #343943;border-radius:16px;padding:1.25rem;background:#171a21}h1{font-size:1.35rem;margin:.1rem 0 1rem}p{line-height:1.45;color:#c7cbd2}.meta{font-family:ui-monospace,monospace;font-size:.9rem;color:#aeb5c0}.node{border:1px solid #343943;border-radius:12px;padding:.85rem;margin:.75rem 0;background:#11141a}.node strong{display:block;margin-bottom:.25rem}.fine{font-size:.85rem;color:#8d95a3}input,button{box-sizing:border-box;font:inherit}input[type=password]{width:100%;font-size:1.25rem;letter-spacing:.12em;padding:.75rem;border-radius:10px;border:1px solid #555d69;background:#0b0d11;color:#fff}button{padding:.65rem .9rem;border:0;border-radius:9px;font-weight:700;cursor:pointer}form{margin:.5rem 0}.danger{border-color:#6d4a23;background:#21180f}a{color:#9ec5ff}</style>
</head>
<body><main>${body}</main></body></html>`;
}

function selectorForNode(node) {
  if (node?.resource_id) return { kind: 'RESOURCE_ID', value: String(node.resource_id) };
  if (node?.text) return { kind: 'TEXT', value: String(node.text) };
  if (node?.content_description) return { kind: 'CONTENT_DESCRIPTION', value: String(node.content_description) };
  if (node?.class_name) return { kind: 'CLASS_NAME', value: String(node.class_name) };
  return null;
}

function displayName(node) {
  return node?.text || node?.content_description || node?.resource_id || node?.class_name || 'Unnamed control';
}

function workAudience(config) {
  return `${config.publicOrigin}/work`;
}

export function createWorkConsole({ config, deviceRelay }) {
  function createSession(pairClaim) {
    const csrf = crypto.randomBytes(24).toString('base64url');
    const token = createCredential(config, {
      kind: 'work_session',
      iss: config.publicOrigin,
      aud: workAudience(config),
      device_id: pairClaim.deviceId,
      pair_id: pairClaim.pairId,
      scopes: ['work'],
      csrf,
      ttlMs: config.workSessionTtlMs,
    });
    return { token, csrf };
  }

  function sessionFromCookie(cookieHeader) {
    const token = parseCookies(cookieHeader).get(COOKIE_NAME) || '';
    const session = verifyCredential(config, token, {
      kind: 'work_session',
      issuer: config.publicOrigin,
      audience: workAudience(config),
      requiredScope: 'work',
    });
    if (!session) return null;
    if (!/^[a-f0-9]{24}$/.test(String(session.device_id || ''))) return null;
    if (typeof session.pair_id !== 'string' || session.pair_id.length < 16) return null;
    if (typeof session.csrf !== 'string' || session.csrf.length < 16) return null;
    return session;
  }

  function sessionCookie(token) {
    const maxAge = Math.max(1, Math.floor(config.workSessionTtlMs / 1000));
    return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; Path=/work; HttpOnly; Secure; SameSite=Strict`;
  }

  function renderPairing(errorMessage = '') {
    const error = errorMessage ? `<p class="fine">${escapeHtml(errorMessage)}</p>` : '';
    return pageShell('Ø Remote Work Console', `
<h1>Pair this browser with Ø Remote</h1>
<p>Enter the current 8-digit pairing code shown on your Android phone. Pairing is a user-only authorization step: the agent must not type, read back, screenshot, or log the value.</p>
${error}
<form method="post" action="/work/pair" autocomplete="off">
<label for="pairing_code">Pairing code</label>
<input id="pairing_code" name="pairing_code" type="password" inputmode="numeric" pattern="[0-9]{8}" minlength="8" maxlength="8" autocomplete="off" required autofocus>
<button type="submit">Pair this browser</button>
</form>
<p class="fine">The code is submitted directly to Ø Remote relay over HTTPS and is never echoed into the page or URL.</p>`);
  }

  async function callTool(session, name, argumentsObject = {}) {
    const id = crypto.randomInt(1, 2_000_000_000);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: argumentsObject },
    });
    const response = await deviceRelay.forwardMcp({
      deviceId: session.device_id,
      pairId: session.pair_id,
      headers: {
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': name,
        'content-type': 'application/json',
      },
      body,
    });
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error('INVALID_DEVICE_RESPONSE');
    }
    return { status: response.status, rpc: parsed };
  }

  async function observe(session) {
    return callTool(session, 'screen.observe', {});
  }

  function renderAuthorizationTakeover(snapshot) {
    const packageName = snapshot?.package ? `<p class="meta">package: ${escapeHtml(snapshot.package)}</p>` : '';
    return pageShell('Ø Remote authorization handoff', `
<h1>User authorization required on phone</h1>
${packageName}
<p>Ø Remote detected a login, credential, permission, identity, CAPTCHA, biometric or equivalent authorization surface.</p>
<p><strong>Complete it manually on the phone.</strong> This console intentionally hides protected screen content and exposes no control actions until the authorization surface disappears.</p>
<p><a href="/work">Refresh after finishing on the phone</a></p>`);
  }

  function renderDevicePage(session, snapshot) {
    const revision = Number(snapshot?.revision);
    const safeRevision = Number.isSafeInteger(revision) ? revision : 0;
    const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const renderedNodes = nodes
      .filter((node) => node && node.sensitive !== true)
      .map((node) => {
        const selector = selectorForNode(node);
        const name = escapeHtml(displayName(node));
        const meta = [node.resource_id, node.class_name].filter(Boolean).map(escapeHtml).join(' · ');
        let action = '';
        if (node.clickable && node.enabled && selector) {
          action = `<form method="post" action="/work/click">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<input type="hidden" name="expected_revision" value="${safeRevision}">
<input type="hidden" name="selector_kind" value="${escapeHtml(selector.kind)}">
<input type="hidden" name="selector_value" value="${escapeHtml(selector.value)}">
<input type="hidden" name="exact" value="true">
<button type="submit">Click</button>
</form>`;
        }
        return `<section class="node"><strong>${name}</strong>${meta ? `<div class="fine">${meta}</div>` : ''}${action}</section>`;
      })
      .join('');

    return pageShell('Ø Remote Work Console', `
<h1>Ø Remote Work Console</h1>
<p class="meta">${escapeHtml(snapshot?.package || '<unknown>')} · revision ${safeRevision}${snapshot?.activity ? ` · ${escapeHtml(snapshot.activity)}` : ''}</p>
<p class="fine">Semantic Android state only. Authorization screens are handed back to the user and redacted.</p>
${renderedNodes || '<p>No actionable semantic nodes are currently exposed.</p>'}
<p><a href="/work">Refresh screen state</a></p>`);
  }

  async function renderSession(session) {
    const observed = await observe(session);
    const result = observed?.rpc?.result;
    const snapshot = result?.structuredContent;
    if (!snapshot || typeof snapshot !== 'object') throw new Error('INVALID_DEVICE_RESPONSE');
    if (snapshot.authorization_required === true || snapshot.privacy_mode === 'USER_AUTH_REDACTED') {
      return renderAuthorizationTakeover(snapshot);
    }
    return renderDevicePage(session, snapshot);
  }

  function csrfMatches(session, supplied) {
    return Boolean(session?.csrf) && safeEqual(session.csrf, supplied);
  }

  function parseClickForm(form) {
    const expectedRevision = Number(form.get('expected_revision'));
    const selectorKind = String(form.get('selector_kind') || '');
    const selectorValue = String(form.get('selector_value') || '');
    if (!Number.isSafeInteger(expectedRevision) || !SELECTOR_KINDS.has(selectorKind) || !selectorValue) return null;
    return {
      expected_revision: expectedRevision,
      selector_kind: selectorKind,
      selector_value: selectorValue,
      exact: String(form.get('exact') || '').toLowerCase() === 'true',
    };
  }

  return {
    createSession,
    sessionFromCookie,
    sessionCookie,
    renderPairing,
    renderSession,
    callTool,
    csrfMatches,
    parseClickForm,
  };
}
