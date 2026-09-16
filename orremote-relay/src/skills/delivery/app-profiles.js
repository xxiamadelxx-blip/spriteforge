const PROFILES = Object.freeze([
  Object.freeze({ id: 'yandex_food', package: 'ru.foodfox.client' }),
  Object.freeze({ id: 'yandex_lavka', package: 'com.yandex.lavka' }),
  Object.freeze({ id: 'vkusvill', package: 'ru.vkusvill' }),
  Object.freeze({ id: 'samokat', package: 'ru.sbcs.store' }),
  Object.freeze({ id: 'azbuka_vkusa', package: 'ru.av.vkusomania' }),
  Object.freeze({ id: 'metro', package: 'www.metro.com' }),
  Object.freeze({ id: 'pyaterochka', package: 'ru.pyaterochka.app.browser' }),
  Object.freeze({ id: 'auchan', package: 'ru.myauchan.droid' }),
  Object.freeze({ id: 'lenta', package: 'com.icemobile.lenta.prod' }),
  Object.freeze({ id: 'magnit', package: 'ru.tander.magnit' }),
  Object.freeze({ id: 'shaverno', package: 'starter.shaverno.client' }),
  Object.freeze({ id: 'farsh', package: 'starter.farshburger.client' }),
]);

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));
const BY_PACKAGE = new Map(PROFILES.map((profile) => [profile.package, profile]));

function publicProfile(profile) {
  return profile ? { id: profile.id, package: profile.package } : null;
}

export function deliveryProfileById(id) {
  return publicProfile(BY_ID.get(String(id || '').trim().toLowerCase()) || null);
}

export function deliveryProfileForPackage(packageName) {
  return publicProfile(BY_PACKAGE.get(String(packageName || '').trim()) || null);
}
