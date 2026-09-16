import { CONSUMER_DELIVERY_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeDiscoverablePlanSkill } from '../native/augmented-exact-plan.js';
import { deliveryProfileById } from './app-profiles.js';

const CHECKOUT_OR_ORDER_PATTERN = /(?:checkout|place order|confirm order|pay|payment|buy now|purchase|cancel order|оформить заказ|подтвердить заказ|оплат|заказать|купить|отменить заказ|способ оплаты|карта)/iu;

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
  });
}
