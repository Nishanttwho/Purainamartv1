function duplicateKey(error) { return error?.code === 11000; }

function stockUse(item) {
  const amount = item.saleType === 'loose' ? Number(item.totalBaseQuantity) : Number(item.quantity);
  if (!Number.isSafeInteger(amount) || amount < 1) throw Object.assign(new Error('Cart quantity is invalid.'), { status: 409 });
  return amount;
}

export async function createMongoCodOrder({ db, client, userId, idempotencyKey, buildOrder, authorize, recordEvents, rewardCart, now = new Date() }) {
  if (!db || !client || typeof buildOrder !== 'function') throw new TypeError('Mongo checkout requires a database, transaction client, and server order builder.');
  if (!userId) return { status: 401, body: { error: 'Sign in to continue', code: 'AUTH_REQUIRED' } };
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey || '')) return { status: 400, body: { error: 'A valid checkout request key is required.' } };
  const orders = db.collection('orders');
  if (idempotencyKey) {
    const prior = await orders.findOne({ userId, idempotencyKey }, { projection: { _id: 0 } });
    if (prior) return { status: 200, body: { order: prior, idempotentReplay: true } };
  }
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      await authorize?.(session);
      if (idempotencyKey) {
        const prior = await orders.findOne({ userId, idempotencyKey }, { session, projection: { _id: 0 } });
        if (prior) { result = { status: 200, body: { order: prior, idempotentReplay: true } }; return; }
      }
      const cart = rewardCart ? await rewardCart(session) : await db.collection('carts').findOne({ ownerId: userId }, { session, projection: { _id: 0 } });
      if (!cart?.items?.length) { result = { status: 400, body: { error: 'Your cart is empty' } }; return; }
      const ids = [...new Set(cart.items.map(item => String(item.productId)))];
      const products = await db.collection('products').find({ id: { $in: ids } }, { session }).toArray();
      if (products.length !== ids.length || products.some(product => product.isActive === false)) {
        result = { status: 409, body: { error: 'A product is no longer available. Update your cart and try again.' } }; return;
      }
      const built = await buildOrder({ userId, cart, products, session, now });
      if (!built || !built.order || built.order.paymentMethod !== 'Cash on delivery' || built.order.paymentStatus !== 'Pay on delivery') throw new TypeError('Server order builder must produce a COD order with pending collection status.');
      const productById = new Map(products.map(product => [String(product.id), product]));
      // The builder has re-priced every line against products read in this
      // transaction. Never use stored cart prices or client quantity metadata.
      for (const item of built.order.items) {
        const product = productById.get(String(item.id));
        if (!product) throw Object.assign(new Error('Order product is invalid.'), { status: 409 });
        const amount = stockUse(item);
        const filter = { id: product.id, isActive: { $ne: false }, stock: { $gte: amount } };
        const update = { $inc: { stock: -amount } };
        const options = { session };
        if (item.variantId && !String(item.variantId).startsWith('custom-')) {
          filter.variants = { $elemMatch: { id: item.variantId, isActive: { $ne: false }, stock: { $gte: amount } } };
          update.$inc['variants.$[variant].stock'] = -amount;
          options.arrayFilters = [{ 'variant.id': item.variantId, 'variant.isActive': { $ne: false }, 'variant.stock': { $gte: amount } }];
        }
        const updated = await db.collection('products').updateOne(filter, update, options);
        if (updated.modifiedCount !== 1) throw Object.assign(new Error(`${item.name || 'A product'} no longer has enough stock.`), { status: 409 });
      }
      let couponRedemption = null;
      const couponCode = built.couponCode || built.order.couponCode;
      if (couponCode) {
        const coupon = await db.collection('coupons').findOne({ code: couponCode }, { session, projection: { _id: 0 } });
        const expiresAt = coupon?.expiresAt ? Date.parse(coupon.expiresAt) : null;
        if (!coupon || coupon.isActive === false || coupon.userId && coupon.userId !== userId || expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) || Number(built.order.subtotal || 0) < Number(coupon.minimum || 0)) {
          throw Object.assign(new Error('The applied coupon is no longer eligible.'), { status: 409 });
        }
        const couponUpdate = await db.collection('coupons').updateOne(
          { code: couponCode, isActive: { $ne: false }, $or: [{ maxRedemptions: { $exists: false } }, { maxRedemptions: null }, { $expr: { $lt: [{ $ifNull: ['$redemptionCount', 0] }, '$maxRedemptions'] } }] },
          { $inc: { redemptionCount: 1 } }, { session }
        );
        if (couponUpdate.modifiedCount !== 1) throw Object.assign(new Error('The applied coupon has reached its redemption limit.'), { status: 409 });
        const customerLimit = Number(built.maxRedemptionsPerCustomer ?? coupon.maxRedemptionsPerCustomer ?? (coupon.userId ? 1 : 0));
        if (customerLimit > 0 && !String(userId).startsWith('guest:')) {
          const count = await db.collection('couponRedemptions').countDocuments({ couponCode, userId, cancelledAt: { $exists: false } }, { session });
          if (count >= customerLimit) throw Object.assign(new Error('This coupon has already been used the maximum number of times for this account.'), { status: 409 });
        }
        couponRedemption = { id: `${couponCode}:${userId}:${built.order.id}`, couponCode, userId, orderId: built.order.id, redeemedAt: now, discount: Number(built.order.discount || 0) };
      }
      if (built.rewardId) {
        const reward = await db.collection('rewards').findOne({ id: built.rewardId, userId, status: 'available' }, { session, projection: { _id: 0 } });
        const currentRedemptions = Number(reward?.redemptionCount || 0), redemptionLimit = Number(reward?.redemptionLimit || 1);
        if (!reward || currentRedemptions >= redemptionLimit || reward.expiresAt && (!Number.isFinite(Date.parse(reward.expiresAt)) || Date.parse(reward.expiresAt) <= now.getTime())) throw Object.assign(new Error('This reward is no longer available.'), { status: 409 });
        const rewardUpdate = await db.collection('rewards').updateOne(
          { id: built.rewardId, userId, status: 'available', $or: [{ redemptionCount: currentRedemptions }, { redemptionCount: { $exists: false } }] },
          { $inc: { redemptionCount: 1 }, $set: { ...(currentRedemptions + 1 >= redemptionLimit ? { status: 'redeemed', redeemedAt: now } : {}), orderId: built.order.id, lastRedeemedAt: now }, $push: { redemptionHistory: { orderId: built.order.id, redeemedAt: now, status: 'redeemed' } } }, { session }
        );
        if (rewardUpdate.modifiedCount !== 1) throw Object.assign(new Error('This reward is no longer available.'), { status: 409 });
      }
      await orders.insertOne(built.order, { session });
      if (couponRedemption) await db.collection('couponRedemptions').insertOne(couponRedemption, { session });
      if (built.notifications?.length) await db.collection('notifications').insertMany(built.notifications, { session, ordered: true });
      if (built.outbox?.length) await db.collection('notificationOutbox').insertMany(built.outbox, { session, ordered: true });
      await recordEvents?.(built.order, session);
      if (!rewardCart) {
        const cleared = await db.collection('carts').deleteOne({ ownerId: userId, version: cart.version }, { session });
        if (cleared.deletedCount !== 1) throw Object.assign(new Error('Your cart changed. Please retry checkout.'), { status: 409 });
        await db.collection('shoppingPreferences').updateOne({ ownerId: userId }, { $unset: { couponCode: '' } }, { session });
      }
      result = { status: 201, body: { order: built.order } };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return result;
  } catch (error) {
    if (idempotencyKey && duplicateKey(error)) {
      const prior = await orders.findOne({ userId, idempotencyKey }, { projection: { _id: 0 } });
      if (prior) return { status: 200, body: { order: prior, idempotentReplay: true } };
    }
    if (error?.status) return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
    throw error;
  } finally {
    await session.endSession();
  }
}
