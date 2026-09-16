const PROFILES = Object.freeze([
  Object.freeze({ id: 'yandex_afisha', package: 'ru.yandex.mobile.afisha' }),
  Object.freeze({ id: 'yandex_music', package: 'ru.yandex.music' }),
  Object.freeze({ id: 'kinopoisk', package: 'ru.kinopoisk' }),
]);

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));
const BY_PACKAGE = new Map(PROFILES.map((profile) => [profile.package, profile]));

function publicProfile(profile) {
  return profile ? { id: profile.id, package: profile.package } : null;
}

export function mediaProfileById(id) {
  return publicProfile(BY_ID.get(String(id || '').trim().toLowerCase()) || null);
}

export function mediaProfileForPackage(packageName) {
  return publicProfile(BY_PACKAGE.get(String(packageName || '').trim()) || null);
}
