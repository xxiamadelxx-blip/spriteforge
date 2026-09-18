import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SettingsState,
  createSettingsDeviceInfoSkill,
  parseSettingsDeviceInfo,
  recognizeSettingsState,
} from '../src/skills/settings/device-info.js';

function node(overrides = {}) {
  return {
    handle: 'h',
    display_id: 0,
    window_id: 1,
    class_name: 'android.widget.TextView',
    bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
    clickable: false,
    enabled: true,
    editable: false,
    sensitive: false,
    depth: 4,
    ...overrides,
  };
}

const home = {
  package: 'com.android.settings',
  revision: 10,
  nodes: [
    node({ text: 'Настройки', resource_id: 'com.android.settings:id/toolbar_title', depth: 3 }),
    node({ handle: 'about-row', clickable: true, class_name: 'android.widget.LinearLayout', depth: 4, bounds: { left: 0, top: 1800, right: 1080, bottom: 1960 } }),
    node({ text: 'Об устройстве', resource_id: 'android:id/title', depth: 5, bounds: { left: 216, top: 1815, right: 900, bottom: 1940 } }),
  ],
};

const deviceInfo = {
  package: 'com.android.settings',
  revision: 11,
  nodes: [
    node({ text: 'Об устройстве', depth: 2 }),
    node({ text: 'OnePlus Nord CE3 5G', resource_id: 'com.android.settings:id/model_name' }),
    node({ text: '15.0', resource_id: 'com.android.settings:id/model_number' }),
    node({ text: 'Память', resource_id: 'android:id/title' }),
    node({ text: '165 ГБ / 256 ГБ', resource_id: 'android:id/summary' }),
    node({ text: 'Процессор', resource_id: 'android:id/title' }),
    node({ text: 'Qualcomm®\nSnapdragon™\n782G Octa-core', resource_id: 'com.android.settings:id/assignment' }),
    node({ text: 'Батарея', resource_id: 'android:id/title' }),
    node({ text: '5000 мА·ч (ТИП)', resource_id: 'com.android.settings:id/assignment' }),
    node({ text: 'RAM', resource_id: 'android:id/title' }),
    node({ text: '12,0 ГБ +', resource_id: 'com.android.settings:id/coui_statusText1' }),
    node({ text: '4,00 ГБ', resource_id: 'com.android.settings:id/expand_ram' }),
    node({ text: 'Фронтальная 16MP', resource_id: 'com.android.settings:id/device_camera_info_front_content' }),
    node({ text: 'Основная 50MP+8MP+2MP', resource_id: 'com.android.settings:id/device_camera_info_back_content' }),
    node({ text: 'Ядро системы', resource_id: 'android:id/title' }),
    node({ text: 'Trinity Engine', resource_id: 'com.android.settings:id/assignment' }),
    node({ text: '17,02 см', resource_id: 'com.android.settings:id/text_size' }),
  ],
};

test('recognizes Settings home and device info screen', () => {
  assert.equal(recognizeSettingsState(home), SettingsState.HOME);
  assert.equal(recognizeSettingsState(deviceInfo), SettingsState.DEVICE_INFO);
});

test('parses read-only device information from semantic nodes', () => {
  assert.deepEqual(parseSettingsDeviceInfo(deviceInfo), {
    model_name: 'OnePlus Nord CE3 5G',
    system_version_display: '15.0',
    storage: '165 ГБ / 256 ГБ',
    processor: 'Qualcomm®\nSnapdragon™\n782G Octa-core',
    battery_capacity: '5000 мА·ч (ТИП)',
    ram: '12,0 ГБ +',
    ram_expansion: '4,00 ГБ',
    front_camera: 'Фронтальная 16MP',
    back_camera: 'Основная 50MP+8MP+2MP',
    system_core: 'Trinity Engine',
    display_size: '17,02 см',
  });
});

test('skill only launches Settings, scrolls, opens About device, then completes', async () => {
  const skill = createSettingsDeviceInfoSkill();
  assert.equal(skill.id, 'settings.device_info.read');
  assert.equal(skill.safety.effect, 'read_only');
  assert.deepEqual(skill.packages, ['com.android.settings']);

  const context = skill.createContext();
  const open = await skill.next({ state: SettingsState.HOME, snapshot: home, context });
  assert.deepEqual(open, { type: 'CLICK_HANDLE', handle: 'about-row', purpose: 'OPEN_DEVICE_INFO' });
  assert.deepEqual(await skill.validateDirective({ state: SettingsState.HOME, snapshot: home, directive: open }), { ok: true });

  const complete = await skill.next({ state: SettingsState.DEVICE_INFO, snapshot: deviceInfo, context });
  assert.equal(complete.type, 'COMPLETE');
  assert.equal(complete.output.model_name, 'OnePlus Nord CE3 5G');

  const forbidden = await skill.validateDirective({
    state: SettingsState.DEVICE_INFO,
    snapshot: deviceInfo,
    directive: { type: 'CLICK_HANDLE', handle: 'anything', purpose: 'CHANGE_SETTING' },
  });
  assert.equal(forbidden.ok, false);
});


test('Settings search swipe is derived from the observed semantic viewport', async () => {
  const skill = createSettingsDeviceInfoSkill({ maxHomeScrolls: 2 });
  const context = skill.createContext();
  const homeWithoutAbout = {
    package: 'com.android.settings',
    revision: 50,
    nodes: [
      node({ handle: 'root', depth: 0, bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } }),
      node({ text: 'Настройки', resource_id: 'com.android.settings:id/toolbar_title', depth: 3 }),
      node({ text: 'Wi-Fi', resource_id: 'android:id/title', depth: 5 }),
    ],
  };

  const swipe = await skill.next({ state: SettingsState.HOME, snapshot: homeWithoutAbout, context });
  assert.deepEqual(swipe, {
    type: 'SWIPE',
    start_x: 540,
    start_y: 1872,
    end_x: 540,
    end_y: 912,
    duration_ms: 350,
    purpose: 'SEARCH_DEVICE_INFO',
  });
});
