export const ADMIN_BROWSER = Object.freeze({
  opera: 'com.opera.browser',
});

export const AI_ASSISTANT_APPS = Object.freeze({
  chatgpt: 'com.openai.chatgpt',
  qwen: 'ai.qwenlm.chat.android',
  deepseek: 'com.deepseek.chat',
  claude: 'com.anthropic.claude',
  gemini: 'com.google.android.apps.bard',
  suno: 'com.suno.android',
});

export const MEDIA_DISCOVERY_APPS = Object.freeze({
  yandexAfisha: 'ru.yandex.mobile.afisha',
  yandexMusic: 'ru.yandex.music',
  kinopoisk: 'ru.kinopoisk',
});

export const CONSUMER_DELIVERY_APPS = Object.freeze({
  yandexFood: 'ru.foodfox.client',
  yandexLavka: 'com.yandex.lavka',
  vkusvill: 'ru.vkusvill',
  samokat: 'ru.sbcs.store',
  azbukaVkusa: 'ru.av.vkusomania',
  metro: 'www.metro.com',
  pyaterochka: 'ru.pyaterochka.app.browser',
  auchan: 'ru.myauchan.droid',
  lenta: 'com.icemobile.lenta.prod',
  magnit: 'ru.tander.magnit',
  shaverno: 'starter.shaverno.client',
  farsh: 'starter.farshburger.client',
});

export const AI_ASSISTANT_PACKAGES = Object.freeze(Object.values(AI_ASSISTANT_APPS));
export const MEDIA_DISCOVERY_PACKAGES = Object.freeze(Object.values(MEDIA_DISCOVERY_APPS));
export const CONSUMER_DELIVERY_PACKAGES = Object.freeze(Object.values(CONSUMER_DELIVERY_APPS));
