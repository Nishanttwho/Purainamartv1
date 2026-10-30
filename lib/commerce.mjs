import crypto from 'node:crypto';
import { toMoneyCents, fromMoneyCents } from './product-pricing.mjs';
import { fail } from './mongo-repository.mjs';

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export const referralDefaults = () => ({ enabled: false, minimumOrder: 399, firstOrderOnly: true, qualifyingStatus: 'Delivered', rewardType: 'free_product', rewardAmount: 50, freeProductId: null, expiryDays: 30, redemptionLimit: 1, maxRewardsPerCustomer: 20, publicBaseUrl: '', demoSettings: false });
export const safeUser = user => user ? { id: user.id, phone: user.phone || null, email: user.email || null, name: user.name || 'PurainaMart member' } : null;
export const safeRider = rider => ({ id: rider.id, name: rider.name, phone: rider.phone, vehicle: rider.vehicle, status: rider.status, isActive: rider.isActive !== false, mustChangePassword: Boolean(rider.mustChangePassword) });
export function resolveLine(product, selection, { strict = false } = {}) {
  const quantity = Number(selection.quantity), variantId = selection.variantId || null;
  let error;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) error = 'Choose a quantity between 1 and 10.';
  if (!product || product.isActive === false) error = 'This product is unavailable. Remove it from the cart.';
  let variant;
  if (product?.variants?.length) {
    if (product.saleType === 'loose' && ['g', 'ml'].includes(product.measurementUnit) && /^custom-\d{1,6}$/.test(variantId || '')) {
      const grams = Number(variantId.slice(7));
      if (grams < 50 || grams > 100000) error = `Enter a custom quantity between 50 and 100,000 ${product.measurementUnit}.`;
      variant = { id: variantId, label: `${grams} ${product.measurementUnit}`, quantityBase: grams, unit: product.measurementUnit, price: fromMoneyCents(Math.round((toMoneyCents(product.price) ?? 0) * grams / 1000)), mrp: null, stock: product.stock, isActive: true };
    } else variant = product.variants.find(row => row.id === variantId);
    if (!variant || variant.isActive === false) error = 'This quantity option is unavailable. Remove it from the cart.';
  } else if (variantId) error = 'This product no longer has that quantity option.';
  const saleType = product?.variants?.length ? product.saleType : 'legacy';
  const totalBaseQuantity = variant ? variant.quantityBase * quantity : quantity;
  const consumed = saleType === 'loose' ? totalBaseQuantity : quantity;
  if (!Number.isSafeInteger(consumed) || consumed < 1 || !Number.isSafeInteger(product?.stock) || product.stock < consumed || (variant && (!Number.isSafeInteger(variant.stock) || variant.stock < consumed))) error ||= 'The requested quantity is no longer in stock.';
  const priceCents = toMoneyCents(variant?.price ?? product?.price);
  const mrpValue = variant ? variant.mrp : product?.mrp;
  const mrpCents = mrpValue == null ? null : toMoneyCents(mrpValue);
  if (priceCents == null || priceCents <= 0) error ||= 'Product pricing is unavailable.';
  if (strict && error) fail(409, error, 'CART_ITEM_UNAVAILABLE');
  const { _id, variants, ...fields } = product || { id: selection.productId, name: 'Unavailable product' };
  return { ...fields, id: String(selection.productId), saleType, variantId, variantLabel: variant?.label || null, measurementUnit: product?.measurementUnit || null, quantityPerUnit: variant?.quantityBase || null, totalBaseQuantity, baseQuantityTotal: totalBaseQuantity, quantity, price: fromMoneyCents(priceCents || 0), mrp: mrpCents == null ? null : fromMoneyCents(mrpCents), lineTotal: fromMoneyCents((priceCents || 0) * quantity), discountPerUnit: fromMoneyCents(Math.max(0, (mrpCents ?? priceCents) - priceCents)), lineDiscount: fromMoneyCents(Math.max(0, (mrpCents ?? priceCents) - priceCents) * quantity), isAvailable: !error, availabilityError: error || null, stock: variant?.stock ?? product?.stock, ...(variant ? { variantStock: variant.stock } : {}) };
}
export async function couponEligible(repo, coupon, ownerId, subtotal = 0, { allowBelowMinimum = false } = {}) {
  if (!coupon || coupon.isActive === false || coupon.revokedAt || coupon.userId && coupon.userId !== ownerId) return false;
  if (coupon.expiresAt && (!Number.isFinite(Date.parse(coupon.expiresAt)) || Date.parse(coupon.expiresAt) <= Date.now())) return false;
  if (coupon.maxRedemptions != null && Number(coupon.redemptionCount || 0) >= coupon.maxRedemptions) return false;
  const limit = Number(coupon.maxRedemptionsPerCustomer ?? (coupon.userId ? 1 : 0));
  if (limit && await repo.count('couponRedemptions', { couponCode: coupon.code, userId: ownerId, cancelledAt: { $exists: false } }) >= limit) return false;
  if (coupon.rewardId) {
    const reward = await repo.one('rewards', { id: coupon.rewardId, userId: ownerId, status: 'available' });
    if (!reward || reward.expiresAt && Date.parse(reward.expiresAt) <= Date.now() || Number(reward.redemptionCount || 0) >= Number(reward.redemptionLimit || 1)) return false;
  }
  return allowBelowMinimum || subtotal >= Number(coupon.minimum || 0);
}
export async function eligibleCoupons(repo, ownerId, subtotal = 0, options = {}) {
  const rows = await repo.all('coupons', { isActive: { $ne: false }, $or: [{ userId: null }, { userId: ownerId }] });
  const result = [];
  for (const coupon of rows) if (await couponEligible(repo, coupon, ownerId, subtotal, options)) result.push(coupon);
  return result;
}
export function deliveryQuote(area, subtotal) {
  const available = Boolean(area && area.isActive !== false), minimumOrder = Number(area?.minimumOrder || 0);
  const threshold = area?.freeDeliveryThreshold == null ? null : Number(area.freeDeliveryThreshold);
  const free = available && threshold != null && subtotal >= threshold;
  return { area: available ? area : null, available, minimumOrder, minimumOrderMet: available && subtotal >= minimumOrder, freeDeliveryThreshold: threshold, free, delivery: available && !free ? Number(area.deliveryCharge || 0) : 0, estimate: available ? `${area.etaMinMinutes}–${area.etaMaxMinutes} min` : null, message: !available ? 'Select an enabled delivery area.' : subtotal < minimumOrder ? `Add ₹${minimumOrder - subtotal} more to meet this area’s minimum order.` : free ? 'Free delivery for this area.' : `Delivery charge ₹${area.deliveryCharge || 0}.` };
}
export async function addressForCustomer(repo, address) {
  if (!address) return null;
  const area = await repo.one('deliveryAreas', { id: address.deliveryAreaId, isActive: { $ne: false } });
  const { pincode, customerId, ...fields } = address;
  return { ...fields, deliveryAreaName: area?.name || null, deliveryAreaUnavailable: !area };
}
export async function cartSummary(repo, ownerId, { addressId, strict = false, cart: suppliedCart, products: suppliedProducts } = {}) {
  const cart = suppliedCart || await repo.one('carts', { ownerId }) || { items: [], version: 0 };
  const products = suppliedProducts || (cart.items.length ? await repo.list('products', { id: { $in: [...new Set(cart.items.map(row => row.productId))] } }, { limit: 200 }) : []);
  const items = cart.items.map(line => resolveLine(products.find(p => p.id === line.productId), line, { strict }));
  const preferences = await repo.one('shoppingPreferences', { ownerId }) || {};
  const address = await repo.one('addresses', { customerId: ownerId, ...(addressId || preferences.addressId ? { id: addressId || preferences.addressId } : { isDefault: true }) });
  if (strict && !address) fail(400, 'Choose a saved delivery address.');
  const areaId = address?.deliveryAreaId || preferences.areaId;
  const area = areaId ? await repo.one('deliveryAreas', { id: areaId, isActive: { $ne: false } }) : null;
  const subtotalCents = items.reduce((sum, row) => sum + toMoneyCents(row.lineTotal), 0), subtotal = fromMoneyCents(subtotalCents);
  const quote = deliveryQuote(area, subtotal);
  const couponOffers = strict ? [] : await eligibleCoupons(repo, ownerId, subtotal, { allowBelowMinimum: true });
  const coupon = preferences.couponCode ? await repo.one('coupons', { code: preferences.couponCode }) : null;
  let activeCoupon = await couponEligible(repo, coupon, ownerId, subtotal) ? coupon : null;
  if (activeCoupon?.discountType === 'free_delivery' && (!quote.available || !quote.minimumOrderMet || quote.free)) activeCoupon = null;
  if (strict && preferences.couponCode && !activeCoupon) fail(409, 'The applied coupon is no longer eligible. Remove it or choose another offer.', 'COUPON_INELIGIBLE');
  const rawDiscount = activeCoupon?.discountType === 'percentage' ? Math.round(subtotalCents * Number(activeCoupon.discount) / 100) : activeCoupon?.discountType === 'fixed' ? toMoneyCents(activeCoupon.discount) : 0;
  const discountCents = Math.min(subtotalCents, Math.max(0, Math.min(rawDiscount || 0, activeCoupon?.maximumDiscount == null ? Infinity : toMoneyCents(activeCoupon.maximumDiscount))));
  const freeDeliveryCouponApplied = activeCoupon?.discountType === 'free_delivery', delivery = freeDeliveryCouponApplied ? 0 : quote.delivery;
  const platform = subtotal > 0 ? 2 : 0, itemSavings = items.reduce((n, item) => n + toMoneyCents(item.lineDiscount), 0) / 100;
  const freeDeliverySavings = quote.free || freeDeliveryCouponApplied ? Number(area?.deliveryCharge || 0) : 0;
  return { items, subtotal, itemSavings, discount: discountCents / 100, delivery, platform, total: (subtotalCents - discountCents + toMoneyCents(delivery) + toMoneyCents(platform)) / 100, count: items.reduce((sum, item) => sum + item.quantity, 0), activeCoupon, appliedCouponCode: preferences.couponCode || null, couponOffers: couponOffers.map(row => ({ ...row, eligible: subtotal >= Number(row.minimum || 0) && (row.discountType !== 'free_delivery' || quote.available && quote.minimumOrderMet && !quote.free), remaining: Math.max(0, Number(row.minimum || 0) - subtotal, row.discountType === 'free_delivery' ? quote.minimumOrder - subtotal : 0), ineligibleReason: subtotal < Number(row.minimum || 0) ? 'Add more items to qualify.' : null })), deliveryArea: quote.area, deliveryAvailable: quote.available, minimumOrder: quote.minimumOrder, minimumOrderMet: quote.minimumOrderMet, freeDeliveryThreshold: quote.freeDeliveryThreshold, deliveryEstimate: quote.estimate, deliveryMessage: quote.message, freeDeliveryUnlocked: quote.free || freeDeliveryCouponApplied, freeDeliveryRemaining: freeDeliveryCouponApplied ? 0 : quote.freeDeliveryThreshold == null ? null : Math.max(0, quote.freeDeliveryThreshold - subtotal), freeDeliveryProgressPercent: freeDeliveryCouponApplied ? 100 : quote.freeDeliveryThreshold == null ? null : Math.min(100, Math.round(subtotal / (quote.freeDeliveryThreshold || 1) * 100)), freeDeliverySavings, freeDeliveryCouponApplied, totalSavings: itemSavings + discountCents / 100 + freeDeliverySavings };
}
export function makeOrder(userId, address, summary, idempotencyKey) {
  const createdAt = nowIso();
  return { id: newId(), displayId: `PM${crypto.randomBytes(12).toString('hex').toUpperCase()}`, idempotencyKey, userId, rewardId: summary.activeCoupon?.rewardId || null, items: structuredClone(summary.items), address: structuredClone(address), deliveryArea: { ...structuredClone(summary.deliveryArea), standardDeliveryCharge: Number(summary.deliveryArea?.deliveryCharge || 0), deliveryCharge: summary.delivery }, paymentMethod: 'Cash on delivery', paymentStatus: 'Pay on delivery', subtotal: summary.subtotal, discount: summary.discount, couponCode: summary.activeCoupon?.code || null, delivery: summary.delivery, platform: summary.platform, total: summary.total, status: 'Order received', eta: summary.deliveryEstimate, createdAt, readyAt: null, riderId: null, history: [{ status: 'Order received', at: createdAt, actorType: 'customer', actorId: userId }], timeline: ['Order placed', 'Being packed', 'Ready for pickup', 'Accepted by rider', 'Picked up', 'Out for delivery', 'Delivered'].map((label, index) => ({ label, at: index ? null : createdAt, complete: index === 0 })) };
}
