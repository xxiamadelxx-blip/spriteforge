export const FILES_PACKAGE = 'com.google.android.apps.nbu.files';

export const FilesState = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HOME: 'HOME',
  DOWNLOADS: 'DOWNLOADS',
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

function downloadsRow(snapshot) {
  return nodes(snapshot).find((node) =>
    node?.enabled !== false
    && node?.clickable === true
    && typeof node?.handle === 'string'
    && node.handle.length > 0
    && resourceEnds(node, '/download_category_item_view')) || null;
}

export function parseVisibleApks(snapshot) {
  const list = nodes(snapshot);
  const result = [];
  for (let index = 0; index < list.length; index += 1) {
    const name = text(list[index]);
    if (!/\.apk$/i.test(name)) continue;
    let metadata = null;
    for (let next = index + 1; next < Math.min(list.length, index + 6); next += 1) {
      const candidate = text(list[next]);
      if (/\.apk$/i.test(candidate)) break;
      if (candidate && /(?:кБ|МБ|ГБ)\s*•/i.test(candidate)) {
        metadata = candidate;
        break;
      }
    }
    result.push({ name, metadata });
  }
  return result;
}

export function recognizeFilesState(snapshot) {
  if (snapshot?.package !== FILES_PACKAGE) return FilesState.UNKNOWN;
  if (
    nodes(snapshot).some((node) => resourceEnds(node, '/file_list'))
    && nodes(snapshot).some((node) => /^загрузки$/i.test(text(node)))
  ) {
    return FilesState.DOWNLOADS;
  }
  if (downloadsRow(snapshot)) return FilesState.HOME;
  return FilesState.UNKNOWN;
}

function searchSwipe() {
  return {
    type: 'SWIPE',
    start_x: 540,
    start_y: 1900,
    end_x: 540,
    end_y: 700,
    duration_ms: 350,
    purpose: 'SEARCH_APKS',
  };
}

export function createFilesDownloadsApksSkill({ maxDownloadScrolls = 5 } = {}) {
  return Object.freeze({
    id: 'files.downloads.apks.read',
    version: 1,
    packages: [FILES_PACKAGE],
    safety: Object.freeze({ effect: 'read_only', risk: 'R0' }),

    createContext() {
      return { downloadScrolls: 0 };
    },

    recognize(snapshot) {
      return recognizeFilesState(snapshot);
    },

    async next({ state, snapshot, context }) {
      if (state === FilesState.UNKNOWN) {
        if (snapshot?.package !== FILES_PACKAGE) {
          return { type: 'LAUNCH', package: FILES_PACKAGE, purpose: 'OPEN_FILES' };
        }
        return {
          type: 'STOP',
          error_code: 'AMBIGUOUS_STATE',
          message: 'Files screen is not recognized as a proven safe state.',
        };
      }

      if (state === FilesState.HOME) {
        const target = downloadsRow(snapshot);
        if (!target) {
          return { type: 'STOP', error_code: 'SAFE_TARGET_NOT_FOUND', message: 'Downloads category was not found.' };
        }
        return { type: 'CLICK_HANDLE', handle: target.handle, purpose: 'OPEN_DOWNLOADS' };
      }

      if (state === FilesState.DOWNLOADS) {
        const apks = parseVisibleApks(snapshot);
        if (apks.length > 0) {
          return { type: 'COMPLETE', output: { apks } };
        }
        if (context.downloadScrolls >= maxDownloadScrolls) {
          return { type: 'COMPLETE', output: { apks: [] } };
        }
        context.downloadScrolls += 1;
        return searchSwipe();
      }

      return { type: 'STOP', error_code: 'AMBIGUOUS_STATE', message: 'Unsupported Files state.' };
    },

    async validateDirective({ state, snapshot, directive }) {
      if (directive.type === 'LAUNCH') {
        return state === FilesState.UNKNOWN && directive.package === FILES_PACKAGE
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'CLICK_HANDLE') {
        const target = downloadsRow(snapshot);
        return state === FilesState.HOME
          && directive.purpose === 'OPEN_DOWNLOADS'
          && target?.handle === directive.handle
          ? { ok: true }
          : { ok: false, code: 'SKILL_ACTION_NOT_ALLOWED' };
      }
      if (directive.type === 'SWIPE') {
        return state === FilesState.DOWNLOADS && directive.purpose === 'SEARCH_APKS'
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
