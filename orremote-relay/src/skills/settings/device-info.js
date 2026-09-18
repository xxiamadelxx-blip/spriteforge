export const SETTINGS_PACKAGE = 'com.android.settings';

export const SettingsState = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HOME: 'HOME',
  DEVICE_INFO: 'DEVICE_INFO',
});

function nodes(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function text(node) {
  return String(node?.text ?? node?.content_description ?? '').trim();
}

function resourceEnds(node, suffix) {
  return String(node?.resource_id || '').endsWith(suffix);
}

function boundsContain(parent, child) {
  const p = parent?.bounds;
  const c = child?.bounds;
  if (!p || !c) return false;
  return p.left <= c.left && p.top <= c.top && p.right >= c.right && p.bottom >= c.bottom;
}

function clickableAncestorForText(snapshot, pattern) {
  const list = nodes(snapshot);
  const childIndex = list.findIndex((node) => pattern.test(text(node)));
  if (childIndex < 0) return null;
  const child = list[childIndex];
  for (let index = childIndex - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (
      candidate?.enabled !== false
      && candidate?.clickable === true
      && typeof candidate?.handle === 'string'
      && candidate.handle.length > 0
      && Number(candidate.depth) < Number(child.depth)
      && boundsContain(candidate, child)
    ) {
      return candidate;
    }
  }
  return null;
}

function valueByResource(snapshot, suffix) {
  const node = nodes(snapshot).find((entry) => resourceEnds(entry, suffix) && text(entry));
  return node ? text(node) : null;
}

function valueAfterTitle(snapshot, label, allowedResourceSuffixes) {
  const list = nodes(snapshot);
  const titleIndex = list.findIndex((node) => resourceEnds(node, '/title') && text(node).toLocaleLowerCase('ru-RU') === label.toLocaleLowerCase('ru-RU'));
  if (titleIndex < 0) return null;
  for (let index = titleIndex + 1; index < list.length; index += 1) {
    const node = list[index];
    if (resourceEnds(node, '/title')) break;
    if (allowedResourceSuffixes.some((suffix) => resourceEnds(node, suffix)) && text(node)) {
      return text(node);
    }
  }
  return null;
}

export function parseSettingsDeviceInfo(snapshot) {
  return {
    model_name: valueByResource(snapshot, '/model_name'),
    system_version_display: valueByResource(snapshot, '/model_number'),
    storage: valueAfterTitle(snapshot, 'Память', ['/summary']),
    processor: valueAfterTitle(snapshot, 'Процессор', ['/assignment']),
    battery_capacity: valueAfterTitle(snapshot, 'Батарея', ['/assignment']),
    ram: valueAfterTitle(snapshot, 'RAM', ['/coui_statusText1']),
    ram_expansion: valueByResource(snapshot, '/expand_ram'),
    front_camera: valueByResource(snapshot, '/device_camera_info_front_content'),
    back_camera: valueByResource(snapshot, '/device_camera_info_back_content'),
    system_core: valueAfterTitle(snapshot, 'Ядро системы', ['/assignment']),
    display_size: valueByResource(snapshot, '/text_size'),
  };
}

export function recognizeSettingsState(snapshot) {
  if (snapshot?.package !== SETTINGS_PACKAGE) return SettingsState.UNKNOWN;
  if (
    nodes(snapshot).some((node) => /^об устройстве$/i.test(text(node)))
    && nodes(snapshot).some((node) => resourceEnds(node, '/model_name'))
  ) {
    return SettingsState.DEVICE_INFO;
  }
  if (nodes(snapshot).some((node) => /^настройки$/i.test(text(node)))) {
    return SettingsState.HOME;
  }
  return SettingsState.UNKNOWN;
}

function viewport(snapshot) {
  const visibleBounds = nodes(snapshot)
    .map((node) => node?.bounds)
    .filter((bounds) => (
      bounds
      && Number.isFinite(Number(bounds.right))
      && Number.isFinite(Number(bounds.bottom))
    ));
  return {
    width: Math.max(1, ...visibleBounds.map((bounds) => Number(bounds.right))),
    height: Math.max(1, ...visibleBounds.map((bounds) => Number(bounds.bottom))),
  };
}

function safeScroll(snapshot) {
  const { width, height } = viewport(snapshot);
  const x = Math.max(1, Math.floor(width * 0.5));
  return {
    type: 'SWIPE',
    start_x: x,
    start_y: Math.max(1, Math.floor(height * 0.78)),
    end_x: x,
    end_y: Math.max(1, Math.floor(height * 0.38)),
    duration_ms: 350,
    purpose: 'SEARCH_DEVICE_INFO',
  };
}

export function createSettingsDeviceInfoSkill({ maxHomeScrolls = 6 } = {}) {
  return Object.freeze({
    id: 'settings.device_info.read',
    version: 1,
    packages: [SETTINGS_PACKAGE],
    safety: Object.freeze({
      effect: 'read_only',
      risk: 'R0',
    }),

    createContext() {
      return { homeScrolls: 0 };
    },

    recognize(snapshot) {
      return recognizeSettingsState(snapshot);
    },

    async next({ state, snapshot, context }) {
      if (state === SettingsState.UNKNOWN) {
        if (snapshot?.package !== SETTINGS_PACKAGE) {
          return { type: 'LAUNCH', package: SETTINGS_PACKAGE, purpose: 'OPEN_SETTINGS' };
        }
        return {
          type: 'STOP',
          error_code: 'AMBIGUOUS_STATE',
          message: 'Settings screen is not recognized as a proven safe state.',
        };
      }

      if (state === SettingsState.HOME) {
        const target = clickableAncestorForText(snapshot, /^об устройстве$/i);
        if (target) {
          return { type: 'CLICK_HANDLE', handle: target.handle, purpose: 'OPEN_DEVICE_INFO' };
        }
        if (context.homeScrolls >= maxHomeScrolls) {
          return {
            type: 'STOP',
            error_code: 'DEVICE_INFO_NOT_FOUND',
            message: 'About device was not found within the bounded Settings search.',
          };
        }
        context.homeScrolls += 1;
        return safeScroll(snapshot);
      }

      if (state === SettingsState.DEVICE_INFO) {
        const output = parseSettingsDeviceInfo(snapshot);
        if (!output.model_name) {
          return {
            type: 'STOP',
            error_code: 'DEVICE_INFO_PARSE_FAILED',
            message: 'Device model was not available on the proven About device screen.',
          };
        }
        return { type: 'COMPLETE', output };
      }

      return { type: 'STOP', error_code: 'AMBIGUOUS_STATE', message: 'Unsupported Settings state.' };
    },

    async validateDirective({ state, snapshot, directive }) {
      if (directive.type === 'LAUNCH') {
        return state === SettingsState.UNKNOWN && directive.package === SETTINGS_PACKAGE
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'SWIPE') {
        return state === SettingsState.HOME && directive.purpose === 'SEARCH_DEVICE_INFO'
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'CLICK_HANDLE') {
        const target = clickableAncestorForText(snapshot, /^об устройстве$/i);
        return state === SettingsState.HOME
          && directive.purpose === 'OPEN_DEVICE_INFO'
          && target?.handle === directive.handle
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
