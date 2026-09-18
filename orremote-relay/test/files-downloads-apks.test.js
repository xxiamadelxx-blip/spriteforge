import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FilesState,
  createFilesDownloadsApksSkill,
  parseVisibleApks,
  recognizeFilesState,
} from '../src/skills/files/downloads-apks.js';

function node(overrides = {}) {
  return {
    handle: 'h', display_id: 0, window_id: 1,
    class_name: 'android.widget.TextView',
    bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
    clickable: false, enabled: true, editable: false, sensitive: false, depth: 6,
    ...overrides,
  };
}

const home = {
  package: 'com.google.android.apps.nbu.files',
  activity: 'com.google.android.apps.nbu.files.home.HomeActivity',
  revision: 20,
  nodes: [
    node({ text: 'Категории', resource_id: 'com.google.android.apps.nbu.files:id/category_title' }),
    node({ handle: 'downloads-row', clickable: true, class_name: 'android.widget.LinearLayout', resource_id: 'com.google.android.apps.nbu.files:id/download_category_item_view' }),
    node({ text: 'Загрузки', resource_id: 'com.google.android.apps.nbu.files:id/title' }),
  ],
};

const downloads = {
  package: 'com.google.android.apps.nbu.files',
  activity: 'com.google.android.apps.nbu.files.documentbrowser.filebrowser.FileBrowserRegularActivity',
  revision: 21,
  nodes: [
    node({ text: 'Загрузки', depth: 2 }),
    node({ class_name: 'android.widget.GridView', resource_id: 'com.google.android.apps.nbu.files:id/file_list', depth: 4 }),
    node({ text: 'report_2026-09-15.png', depth: 8 }),
    node({ text: '207 кБ • 8 часов назад', depth: 8 }),
    node({ text: 'app-debug (5).apk', depth: 8 }),
    node({ text: '4,47 МБ • 13 часов назад', depth: 8 }),
    node({ text: 'orremote-0.5.0-m5.112.apk', depth: 8 }),
    node({ text: '4,48 МБ • Только что', depth: 8 }),
  ],
};

test('recognizes Files home and Downloads', () => {
  assert.equal(recognizeFilesState(home), FilesState.HOME);
  assert.equal(recognizeFilesState(downloads), FilesState.DOWNLOADS);
});

test('parser returns APK rows only and ignores unrelated filenames', () => {
  assert.deepEqual(parseVisibleApks(downloads), [
    { name: 'app-debug (5).apk', metadata: '4,47 МБ • 13 часов назад' },
    { name: 'orremote-0.5.0-m5.112.apk', metadata: '4,48 МБ • Только что' },
  ]);
});

test('skill can only launch Files, open Downloads, search by scrolling, and complete', async () => {
  const skill = createFilesDownloadsApksSkill();
  assert.equal(skill.id, 'files.downloads.apks.read');
  assert.equal(skill.safety.effect, 'read_only');

  const context = skill.createContext();
  const open = await skill.next({ state: FilesState.HOME, snapshot: home, context });
  assert.deepEqual(open, { type: 'CLICK_HANDLE', handle: 'downloads-row', purpose: 'OPEN_DOWNLOADS' });
  assert.deepEqual(await skill.validateDirective({ state: FilesState.HOME, snapshot: home, directive: open }), { ok: true });

  const search = await skill.next({ state: FilesState.DOWNLOADS, snapshot: downloads, context });
  assert.equal(search.type, 'SWIPE');
  assert.equal(search.purpose, 'SEARCH_APKS');

  const complete = await skill.next({ state: FilesState.DOWNLOADS, snapshot: downloads, context });
  assert.equal(complete.type, 'COMPLETE');
  assert.equal(complete.output.apks.length, 2);

  const forbidden = await skill.validateDirective({
    state: FilesState.DOWNLOADS,
    snapshot: downloads,
    directive: { type: 'CLICK_HANDLE', handle: 'apk-file', purpose: 'OPEN_APK' },
  });
  assert.equal(forbidden.ok, false);
});


test('skill accumulates unique APKs across changed Downloads viewports before completing', async () => {
  const skill = createFilesDownloadsApksSkill({ maxDownloadScrolls: 4 });
  const context = skill.createContext();

  const first = await skill.next({ state: FilesState.DOWNLOADS, snapshot: downloads, context });
  assert.equal(first.type, 'SWIPE');

  const later = {
    ...downloads,
    revision: 22,
    nodes: [
      node({ text: 'Загрузки', depth: 2 }),
      node({ class_name: 'android.widget.GridView', resource_id: 'com.google.android.apps.nbu.files:id/file_list', depth: 4 }),
      node({ text: 'orremote-0.5.0-m5.112.apk', depth: 8 }),
      node({ text: '4,48 МБ • Только что', depth: 8 }),
      node({ text: 'orremote-0.5.0-m5.200.apk', depth: 8 }),
      node({ text: '4,50 МБ • 1 минуту назад', depth: 8 }),
    ],
  };

  const second = await skill.next({ state: FilesState.DOWNLOADS, snapshot: later, context });
  assert.equal(second.type, 'SWIPE');

  const complete = await skill.next({ state: FilesState.DOWNLOADS, snapshot: later, context });
  assert.equal(complete.type, 'COMPLETE');
  assert.deepEqual(complete.output.apks, [
    { name: 'app-debug (5).apk', metadata: '4,47 МБ • 13 часов назад' },
    { name: 'orremote-0.5.0-m5.112.apk', metadata: '4,48 МБ • Только что' },
    { name: 'orremote-0.5.0-m5.200.apk', metadata: '4,50 МБ • 1 минуту назад' },
  ]);
});

test('empty Downloads completes only after one bounded no-progress scroll', async () => {
  const skill = createFilesDownloadsApksSkill({ maxDownloadScrolls: 4 });
  const context = skill.createContext();
  const empty = {
    ...downloads,
    revision: 30,
    nodes: [
      node({ text: 'Загрузки', depth: 2 }),
      node({ class_name: 'android.widget.GridView', resource_id: 'com.google.android.apps.nbu.files:id/file_list', depth: 4 }),
      node({ text: 'photo.jpg', depth: 8 }),
      node({ text: '1,2 МБ • Сегодня', depth: 8 }),
    ],
  };

  const first = await skill.next({ state: FilesState.DOWNLOADS, snapshot: empty, context });
  assert.equal(first.type, 'SWIPE');

  const complete = await skill.next({ state: FilesState.DOWNLOADS, snapshot: empty, context });
  assert.equal(complete.type, 'COMPLETE');
  assert.deepEqual(complete.output.apks, []);
});


test('Files search swipe is derived from the observed semantic viewport', async () => {
  const skill = createFilesDownloadsApksSkill({ maxDownloadScrolls: 2 });
  const context = skill.createContext();
  const largeDownloads = {
    ...downloads,
    revision: 40,
    nodes: [
      node({ handle: 'root', depth: 0, bounds: { left: 0, top: 0, right: 1000, bottom: 2000 } }),
      node({ text: 'Загрузки', depth: 2 }),
      node({ class_name: 'android.widget.GridView', resource_id: 'com.google.android.apps.nbu.files:id/file_list', depth: 4 }),
      node({ text: 'photo.jpg', depth: 8 }),
    ],
  };

  const swipe = await skill.next({ state: FilesState.DOWNLOADS, snapshot: largeDownloads, context });
  assert.deepEqual(swipe, {
    type: 'SWIPE',
    start_x: 500,
    start_y: 1560,
    end_x: 500,
    end_y: 760,
    duration_ms: 350,
    purpose: 'SEARCH_APKS',
  });
});
