import { CONSUMER_DELIVERY_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeDiscoverablePlanSkill } from '../native/augmented-exact-plan.js';
import { deliveryProfileById } from './app-profiles.js';

const CHECKOUT_OR_ORDER_PATTERN = /(?:checkout|place order|confirm order|pay|payment|buy now|purchase|cancel order|delivery address|shipping address|change address|choose address|current location|checkout address|оформить заказ|подтвердить заказ|оплат|заказать|купить|отменить заказ|способ оплаты|карта|адрес доставки|изменить адрес|выбрать адрес|текущее местоположение|геолокац|геопозици|подъезд|квартир|этаж|sign in|log in|login|account|войти|аккаунт|авторизац)/iu;
const ADDRESS_OR_LOCATION_PATTERN = /(?:(?:delivery|shipping)[_\s-]*address|(?:change|choose)[_\s-]*address|current[_\s-]*location|(?:^|[_\s-])address(?:$|[_\s-])|адрес(?: доставки)?|изменить[_\s-]*адрес|выбрать[_\s-]*адрес|место[_\s-]*доставки|текущее[_\s-]*местоположение|геолокац|геопозици|подъезд|квартир|этаж)/iu;

export function createDeliveryCartPlanSkill() {
  const base = createNativeDiscoverablePlanSkill({
    id: 'delivery.consumer.build_cart',
    packages: CONSUMER_DELIVERY_PACKAGES,
    effect: 'cart_write',
    risk: 'R2',
    forbiddenClickPattern: CHECKOUT_OR_ORDER_PATTERN,
  });

  return Object.freeze({
    ...base,
    createContext({ inputs = {}, deviceId = null, pairId = null } = {}) {
      const profile = deliveryProfileById(inputs.provider);
      const resolvedInputs = profile
        ? { ...inputs, package: profile.package }
        : inputs;
      return base.createContext({ inputs: resolvedInputs, deviceId, pairId });
    },
    async next(args) {
      const step = args?.context?.steps?.[args?.context?.index];
      if (String(step?.type || '').startsWith('SET_TEXT')) {
        const label = String(step?.label ?? step?.selector?.value ?? '');
        if (ADDRESS_OR_LOCATION_PATTERN.test(label)) {
          return {
            type: 'STOP',
            error_code: 'SKILL_ACTION_NOT_ALLOWED',
            message: 'Delivery cart skill cannot enter or change delivery address/location.',
          };
        }
      }
      return base.next(args);
    },
  });
}
