import {
  CONSUMER_DELIVERY_PACKAGES,
  MEDIA_DISCOVERY_PACKAGES,
} from './catalogs/device-apps.js';
import {
  browserAdminProfileAllowsHost,
  browserAdminProfileById,
} from './browser/site-profiles.js';
import { deliveryProfileById } from './delivery/app-profiles.js';
import { mediaProfileById } from './media/app-profiles.js';

const DEFAULT_BROWSER_ADMIN_DOMAINS = Object.freeze([
  'codemagic.io',
  'gitlab.com',
  'github.com',
  'render.com',
  'dashboard.render.com',
  'supabase.com',
  'app.circleci.com',
  'railway.app',
  'vercel.com',
]);

const DEFAULT_APPROVED_SKILLS = Object.freeze({
  'yandex_pro.planned_slot_orders.read': Object.freeze({
    effect: 'read_only',
    packages: Object.freeze(['ru.yandex.taximeter']),
  }),
  'settings.device_info.read': Object.freeze({
    effect: 'read_only',
    packages: Object.freeze(['com.android.settings']),
  }),
  'files.downloads.apks.read': Object.freeze({
    effect: 'read_only',
    packages: Object.freeze(['com.google.android.apps.nbu.files']),
  }),
  'browser.admin.run_plan': Object.freeze({
    effect: 'configuration',
    packages: Object.freeze(['com.opera.browser']),
    domains: DEFAULT_BROWSER_ADMIN_DOMAINS,
  }),
  'media.discovery.run_plan': Object.freeze({
    effect: 'read_only',
    packages: MEDIA_DISCOVERY_PACKAGES,
  }),
  'delivery.consumer.build_cart': Object.freeze({
    effect: 'cart_write',
    packages: CONSUMER_DELIVERY_PACKAGES,
  }),
});

const AUTH_FIELD_PATTERN = /(?:password|passcode|pin|otp|2fa|two[- ]?factor|verification code|security code|api[ _-]?token|access[ _-]?token|secret|private key|cvv|cvc|card number|парол|пин|код подтверж|однораз|токен|секрет)/iu;
const FORBIDDEN_BROWSER_CLICK_PATTERN = /(?:delete|remove|revoke|rotate|billing|pay now|purchase|checkout|buy now|reset pairing|удал|отозв|ротац|оплат|купить|оформить заказ|сбросить pairing)/iu;
const FORBIDDEN_MEDIA_CLICK_PATTERN = /(?:like|favorite|favourite|subscribe|download|buy|rent|purchase|remove|delete|collection|sign in|log in|login|account|мне нравится|лайк|избран|коллекц|подпис|скачать|купить|аренд|удал|войти|аккаунт|авторизац)/iu;
const FORBIDDEN_DELIVERY_CLICK_PATTERN = /(?:checkout|place order|confirm order|pay|payment|buy now|purchase|cancel order|delivery address|shipping address|change address|choose address|current location|sign in|log in|login|account|оформить заказ|подтвердить заказ|оплат|заказать|купить|отменить заказ|способ оплаты|карта|адрес доставки|изменить адрес|выбрать адрес|текущее местоположение|геолокац|геопозици|подъезд|квартир|этаж|войти|аккаунт|авторизац)/iu;
const DELIVERY_ADDRESS_OR_LOCATION_PATTERN = /(?:(?:delivery|shipping)[_\s-]*address|(?:change|choose)[_\s-]*address|current[_\s-]*location|(?:^|[_\s-])address(?:$|[_\s-])|адрес(?: доставки)?|изменить[_\s-]*адрес|выбрать[_\s-]*адрес|место[_\s-]*доставки|текущее[_\s-]*местоположение|геолокац|геопозици|подъезд|квартир|этаж)/iu;

const ALLOWED_BROWSER_STEP_TYPES = new Set([
  'CLICK_EXACT_TEXT',
  'CLICK_EXACT_SELECTOR',
  'SET_TEXT_EXACT_SELECTOR',
  'SET_TEXT_EXACT_LABEL',
  'ASSERT_EXACT_TEXT',
  'SCROLL_DOWN',
  'NAVIGATE_URL',
  'WAIT_FOR_EXACT_SELECTOR',
  'CAPTURE_EXACT_SELECTOR_TEXT',
  'BROWSER_BACK',
]);
const ALLOWED_NATIVE_STEP_TYPES = new Set([
  'CLICK_EXACT_TEXT',
  'CLICK_EXACT_SELECTOR',
  'SET_TEXT_EXACT_SELECTOR',
  'ASSERT_EXACT_TEXT',
  'SCROLL_DOWN',
]);

function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return raw.replace(/^www\./, '').split('/')[0];
  }
}

function domainAllowed(domain, approvedDomains = []) {
  const host = normalizeDomain(domain);
  return approvedDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function planFieldLabel(step) {
  return String(step?.label ?? step?.text ?? step?.selector?.value ?? '');
}

function basicPlanValidation(steps, allowedTypes, forbiddenClickPattern) {
  if (steps.length > 80) {
    return {
      ok: false,
      code: 'SKILL_PLAN_TOO_LARGE',
      message: 'Skill plan exceeds the bounded step limit.',
    };
  }

  for (const step of steps) {
    if (!step || !allowedTypes.has(String(step.type || ''))) {
      return {
        ok: false,
        code: 'SKILL_ACTION_NOT_ALLOWED',
        message: 'Skill plan contains an unsupported action type.',
      };
    }

    const type = String(step.type || '');
    const label = planFieldLabel(step);
    if (
      step.sensitive === true
      || ((type.startsWith('SET_TEXT') || type === 'CAPTURE_EXACT_SELECTOR_TEXT') && AUTH_FIELD_PATTERN.test(label))
    ) {
      return {
        ok: false,
        code: 'USER_AUTH_REQUIRED',
        message: 'Passwords, OTPs, API tokens and other authorization secrets are user-only.',
      };
    }

    if (
      type.startsWith('CLICK')
      && forbiddenClickPattern
      && forbiddenClickPattern.test(label)
    ) {
      return {
        ok: false,
        code: 'SKILL_ACTION_NOT_ALLOWED',
        message: 'Plan requests an action outside the skill safety boundary.',
      };
    }
  }

  return { ok: true };
}

function browserPlanAuthorization(inputs, approved) {
  const site = String(inputs?.site || '').trim().toLowerCase();
  const domain = normalizeDomain(inputs?.domain);
  let allowedDomains = approved.domains || [];

  if (site) {
    const profile = browserAdminProfileById(site);
    if (!profile) {
      return {
        ok: false,
        code: 'SKILL_SITE_NOT_ALLOWED',
        message: 'Unknown browser administration site profile.',
      };
    }
    allowedDomains = profile.domains;
    if (domain && !browserAdminProfileAllowsHost(site, domain)) {
      return {
        ok: false,
        code: 'SKILL_DOMAIN_NOT_ALLOWED',
        message: 'Declared browser domain does not belong to the selected site profile.',
      };
    }
  } else if (!domainAllowed(domain, allowedDomains)) {
    return {
      ok: false,
      code: 'SKILL_DOMAIN_NOT_ALLOWED',
      message: 'Browser administration is limited to explicitly approved infrastructure domains.',
    };
  }

  const steps = Array.isArray(inputs?.steps) ? inputs.steps : [];
  const base = basicPlanValidation(steps, ALLOWED_BROWSER_STEP_TYPES, FORBIDDEN_BROWSER_CLICK_PATTERN);
  if (!base.ok) return base;

  for (const step of steps) {
    if (step.type !== 'NAVIGATE_URL') continue;
    let targetDomain = '';
    try {
      targetDomain = new URL(String(step.url || '')).hostname;
    } catch {
      return {
        ok: false,
        code: 'SKILL_DOMAIN_NOT_ALLOWED',
        message: 'Browser navigation URL must be an absolute HTTPS URL on an approved domain.',
      };
    }
    const permitted = site
      ? browserAdminProfileAllowsHost(site, targetDomain)
      : domainAllowed(targetDomain, allowedDomains);
    if (!String(step.url || '').startsWith('https://') || !permitted) {
      return {
        ok: false,
        code: 'SKILL_DOMAIN_NOT_ALLOWED',
        message: 'Browser navigation cannot leave the selected infrastructure service boundary.',
      };
    }
  }

  return { ok: true };
}

function nativePlanAuthorization(inputs, approved, forbiddenClickPattern) {
  const targetPackage = String(inputs?.package || '');
  if (!approved.packages.includes(targetPackage)) {
    return {
      ok: false,
      code: 'SKILL_PACKAGE_NOT_ALLOWED',
      message: 'Requested native package is outside this skill package allowlist.',
    };
  }
  const steps = Array.isArray(inputs?.steps) ? inputs.steps : [];
  return basicPlanValidation(steps, ALLOWED_NATIVE_STEP_TYPES, forbiddenClickPattern);
}

function mediaPlanAuthorization(inputs, approved) {
  const provider = String(inputs?.provider || '').trim().toLowerCase();
  const declaredPackage = String(inputs?.package || '');
  let targetPackage = declaredPackage;

  if (provider) {
    const profile = mediaProfileById(provider);
    if (!profile) {
      return {
        ok: false,
        code: 'SKILL_PROVIDER_NOT_ALLOWED',
        message: 'Unknown media discovery provider profile.',
      };
    }
    if (declaredPackage && declaredPackage !== profile.package) {
      return {
        ok: false,
        code: 'SKILL_PACKAGE_NOT_ALLOWED',
        message: 'Declared package does not match the selected media provider.',
      };
    }
    targetPackage = profile.package;
  }

  if (!approved.packages.includes(targetPackage)) {
    return {
      ok: false,
      code: 'SKILL_PACKAGE_NOT_ALLOWED',
      message: 'Requested media package is outside the discovery allowlist.',
    };
  }

  const steps = Array.isArray(inputs?.steps) ? inputs.steps : [];
  return basicPlanValidation(steps, ALLOWED_NATIVE_STEP_TYPES, FORBIDDEN_MEDIA_CLICK_PATTERN);
}

function deliveryPlanAuthorization(inputs, approved) {
  const provider = String(inputs?.provider || '').trim().toLowerCase();
  const declaredPackage = String(inputs?.package || '');
  let targetPackage = declaredPackage;

  if (provider) {
    const profile = deliveryProfileById(provider);
    if (!profile) {
      return {
        ok: false,
        code: 'SKILL_PROVIDER_NOT_ALLOWED',
        message: 'Unknown consumer delivery provider profile.',
      };
    }
    if (declaredPackage && declaredPackage !== profile.package) {
      return {
        ok: false,
        code: 'SKILL_PACKAGE_NOT_ALLOWED',
        message: 'Declared package does not match the selected delivery provider.',
      };
    }
    targetPackage = profile.package;
  }

  if (!approved.packages.includes(targetPackage)) {
    return {
      ok: false,
      code: 'SKILL_PACKAGE_NOT_ALLOWED',
      message: 'Requested delivery package is outside the consumer allowlist.',
    };
  }

  const steps = Array.isArray(inputs?.steps) ? inputs.steps : [];
  const base = basicPlanValidation(steps, ALLOWED_NATIVE_STEP_TYPES, FORBIDDEN_DELIVERY_CLICK_PATTERN);
  if (!base.ok) return base;

  for (const step of steps) {
    const label = planFieldLabel(step);
    if (DELIVERY_ADDRESS_OR_LOCATION_PATTERN.test(label)) {
      return {
        ok: false,
        code: 'SKILL_ACTION_NOT_ALLOWED',
        message: 'Delivery cart skill cannot select, enter or change delivery address/location.',
      };
    }
  }

  return { ok: true };
}

export function createDefaultSkillSafetyPolicy({
  approvedSkills = DEFAULT_APPROVED_SKILLS,
  panicSwitch = () => process.env.ORREMOTE_SKILLS_PANIC === '1',
} = {}) {
  return Object.freeze({
    isPanicked() {
      return Boolean(panicSwitch());
    },

    authorizeSkill(skill, { inputs = {} } = {}) {
      const id = String(skill?.id || '');
      const declaredEffect = skill?.safety?.effect ?? null;
      const approved = approvedSkills[id] || null;

      if (!approved) {
        if (declaredEffect !== 'read_only') {
          return {
            ok: false,
            code: 'SKILL_EFFECT_NOT_ALLOWED',
            message: 'Non-read-only skills require an explicit approved safety policy.',
          };
        }
        return {
          ok: false,
          code: 'SKILL_PACKAGE_NOT_ALLOWED',
          message: 'Skill is not present in the external approved manifest.',
        };
      }

      if (declaredEffect !== approved.effect) {
        return {
          ok: false,
          code: 'SKILL_EFFECT_NOT_ALLOWED',
          message: 'Skill effect does not exactly match the external approved manifest.',
        };
      }

      const packages = Array.isArray(skill?.packages) ? skill.packages.map(String) : [];
      const approvedPackages = new Set(approved.packages.map(String));
      if (
        packages.length !== approvedPackages.size
        || packages.some((pkg) => !approvedPackages.has(pkg))
      ) {
        return {
          ok: false,
          code: 'SKILL_PACKAGE_NOT_ALLOWED',
          message: 'Skill packages do not exactly match the external approved manifest.',
        };
      }

      if (id === 'browser.admin.run_plan') {
        return browserPlanAuthorization(inputs, approved);
      }
      if (id === 'media.discovery.run_plan') {
        return mediaPlanAuthorization(inputs, approved);
      }
      if (id === 'delivery.consumer.build_cart') {
        return deliveryPlanAuthorization(inputs, approved);
      }

      if (declaredEffect !== 'read_only') {
        return {
          ok: false,
          code: 'SKILL_EFFECT_NOT_ALLOWED',
          message: 'Non-read-only skills require an explicit specialized safety policy.',
        };
      }

      return { ok: true };
    },
  });
}
