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

function viewportSignature(snapshot) {
  return nodes(snapshot)
    .map((node) => [
      node?.text,
      node?.content_description,
      node?.resource_id,
    ].map((value) => String(value ?? '')).join('|'))
    .join('\n');
}

function rememberVisibleApks(context, snapshot) {
  const seen = context.apksByName || (context.apksByName = {});
  for (const apk of parseVisibleApks(snapshot)) {
    const previous = seen[apk.name];
    seen[apk.name] = {
      name: apk.name,
      metadata: apk.metadata ?? previous?.metadata ?? null,
    };
  }
}

function collectedApks(context) {
  return Object.values(context.apksByName || {});
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

function searchSwipe(snapshot) {
  const { width, height } = viewport(snapshot);
  const x = Math.max(1, Math.floor(width * 0.5));
  return {
    type: 'SWIPE',
    start_x: x,
    start_y: Math.max(1, Math.floor(height * 0.78)),
    end_x: x,
    end_y: Math.max(1, Math.floor(height * 0.38)),
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
      return {
        downloadScrolls: 0,
        apksByName: {},
        lastViewportSignature: null,
      };
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
        rememberVisibleApks(context, snapshot);
        const signature = viewportSignature(snapshot);
        const noProgress = context.downloadScrolls > 0
          && context.lastViewportSignature === signature;
        context.lastViewportSignature = signature;

        if (noProgress || context.downloadScrolls >= maxDownloadScrolls) {
          return { type: 'COMPLETE', output: { apks: collectedApks(context) } };
        }

        context.downloadScrolls += 1;
        return searchSwipe(snapshot);
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
