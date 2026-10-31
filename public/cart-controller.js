const keyFor = (id, variantId) => JSON.stringify([id, variantId || null]);
const cents = value => Math.round(Number(value || 0) * 100);

// Estimates are display-only. The server recalculates every line and checkout.
export function estimateCart(cart, items) {
  items = items.map(item => ({ ...item, lineTotal: cents(item.price) * item.quantity / 100, totalBaseQuantity: (item.quantityPerUnit || 1) * item.quantity, lineDiscount: cents(item.discountPerUnit) * item.quantity / 100 }));
  const subtotal = items.reduce((sum, item) => sum + cents(item.lineTotal), 0) / 100;
  const minimumOrderMet = cart.deliveryAvailable && subtotal >= Number(cart.minimumOrder || 0);
  const threshold = cart.freeDeliveryThreshold;
  const thresholdFree = cart.deliveryAvailable && threshold != null && subtotal >= threshold;
  let coupon = cart.activeCoupon;
  if (coupon && (subtotal < Number(coupon.minimum || 0) || coupon.discountType === 'free_delivery' && (!minimumOrderMet || thresholdFree))) coupon = null;
  const couponFree = coupon?.discountType === 'free_delivery';
  const raw = coupon?.discountType === 'percentage' ? Math.round(cents(subtotal) * Number(coupon.discount) / 100) : coupon?.discountType === 'fixed' ? cents(coupon.discount) : 0;
  const discount = Math.min(cents(subtotal), raw, coupon?.maximumDiscount == null ? Infinity : cents(coupon.maximumDiscount)) / 100;
  const delivery = thresholdFree || couponFree ? 0 : Number(cart.deliveryArea?.deliveryCharge ?? cart.delivery ?? 0);
  const platform = subtotal > 0 ? 2 : 0;
  const itemSavings = items.reduce((sum, item) => sum + cents(item.lineDiscount), 0) / 100;
  const freeDeliverySavings = thresholdFree || couponFree ? Number(cart.deliveryArea?.deliveryCharge || 0) : 0;
  return { ...cart, items, count: items.reduce((sum, item) => sum + item.quantity, 0), subtotal, discount, delivery, platform, total: (cents(subtotal)-cents(discount)+cents(delivery)+cents(platform))/100, activeCoupon: coupon, minimumOrderMet, freeDeliveryUnlocked: thresholdFree || couponFree, freeDeliveryRemaining: couponFree ? 0 : threshold == null ? null : Math.max(0, threshold-subtotal), freeDeliveryProgressPercent: couponFree ? 100 : threshold == null ? null : Math.min(100, Math.round(subtotal/(threshold||1)*100)), itemSavings, freeDeliverySavings, totalSavings: itemSavings+discount+freeDeliverySavings, pending: true };
}

export function createCartController({ getCart, setCart, send, read, onError = () => {} }) {
  let confirmed, running = null, generation = 0, lastError = null;
  const pending = new Map();
  function publish() {
    const items = new Map(confirmed.items.map(item => [keyFor(item.id, item.variantId), item]));
    for (const [key, entry] of pending) {
      if (entry.quantity) items.set(key, { ...(items.get(key) || entry.item), quantity: entry.quantity });
      else items.delete(key);
    }
    setCart(pending.size ? estimateCart(confirmed, [...items.values()]) : { ...confirmed, pending: false });
  }
  async function drain(epoch) {
    while (pending.size && epoch === generation) {
      const [key, entry] = pending.entries().next().value;
      const quantity = entry.quantity;
      const expectedQuantity = confirmed.items.find(item=>keyFor(item.id,item.variantId)===key)?.quantity || 0;
      try {
        const result = await send({ productId: entry.item.id, variantId: entry.item.variantId || null, quantity, expectedQuantity });
        if (epoch !== generation) return;
        confirmed = { ...result, couponOffers: result.couponOffers ?? confirmed.couponOffers };
        if (pending.get(key)?.quantity === quantity) pending.delete(key);
      } catch (error) {
        if (epoch !== generation) return;
        if (error.code === 'CART_CONFLICT' && (entry.conflicts || 0) < 2) {
          try {
            const fresh = await read();
            if (epoch !== generation) return;
            const latest = fresh.items.find(item=>keyFor(item.id,item.variantId)===key)?.quantity || 0;
            const intent = pending.get(key);
            if (intent) { intent.quantity=Math.max(0,Math.min(10,latest+intent.quantity-expectedQuantity)); intent.conflicts=(entry.conflicts||0)+1; }
            confirmed=fresh;publish();continue;
          } catch { /* Reconciliation failed: fall through to visible rollback. */ }
        }
        lastError = error;
        pending.delete(key);
        // A dropped response may have committed. Read once to reconcile; never
        // replay a delta or silently retry a checkout after ambiguous failure.
        if (!error.status || error.status >= 500) {
          try { confirmed = await read(); } catch { /* keep last confirmed state */ }
        }
        if (epoch !== generation) return;
        onError(error);
      }
      publish();
    }
  }
  return {
    set(item, quantity) {
      if (!running) { confirmed = getCart(); lastError = null; }
      pending.set(keyFor(item.id, item.variantId), { item, quantity });
      publish();
      if (!running) running = Promise.resolve().then(() => drain(generation)).finally(() => { running = null; });
    },
    async flush() { if (running) await running; if (lastError) { const error=lastError; lastError=null; throw error; } },
    get pending() { return pending.size > 0; },
    reset() { generation++; pending.clear(); confirmed = getCart(); lastError = null; }
  };
}
