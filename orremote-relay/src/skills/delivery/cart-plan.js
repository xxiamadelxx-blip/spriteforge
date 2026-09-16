import { CONSUMER_DELIVERY_PACKAGES } from '../catalogs/device-apps.js';
import { createNativeExactPlanSkill } from '../native/exact-plan.js';

const CHECKOUT_OR_ORDER_PATTERN = /(?:checkout|place order|confirm order|pay|payment|buy now|purchase|cancel order|оформить заказ|подтвердить заказ|оплат|заказать|купить|отменить заказ|способ оплаты|карта)/iu;

export function createDeliveryCartPlanSkill() {
  return createNativeExactPlanSkill({
    id: 'delivery.consumer.build_cart',
    packages: CONSUMER_DELIVERY_PACKAGES,
    effect: 'cart_write',
    risk: 'R2',
    forbiddenClickPattern: CHECKOUT_OR_ORDER_PATTERN,
  });
}
