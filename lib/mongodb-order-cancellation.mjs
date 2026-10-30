const CUSTOMER_CANCELLABLE = new Set(['Order received', 'Being packed', 'Ready for pickup']);

function consumedUnits(item) {
  const amount = item.saleType === 'loose' ? Number(item.totalBaseQuantity) : Number(item.quantity);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Order contains an invalid inventory quantity.');
  return amount;
}

export async function cancelMongoCodOrder({ db, client, orderId, customerId, actorType = 'customer', actorId = customerId, reason = 'Cancelled by customer', now = new Date(), buildNotifications, recordEvents, authorize }) {
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      await authorize?.(session);
      const orders = db.collection('orders');
      const ownership = actorType === 'customer' ? { userId: String(actorId) } : actorType === 'rider' ? { riderId: String(actorId) } : {};
      const order = await orders.findOne({ id: String(orderId), ...ownership }, { session, projection: { _id: 0 } });
      if (!order) { result = { status: 404, body: { error: 'Order not found' } }; return; }
      if (order.status === 'Cancelled') { result = { status: 409, body: { error: 'This order has already been cancelled.' } }; return; }
      if (actorType === 'customer' && (!CUSTOMER_CANCELLABLE.has(order.status) || order.riderId) || actorType === 'rider' && !['Rider assigned', 'Picked up', 'Out for delivery'].includes(order.status)) {
        result = { status: 409, body: { error: 'This order can no longer be cancelled because a rider has accepted it or fulfillment has advanced.' } };
        return;
      }
      if (!['customer', 'rider', 'admin'].includes(actorType)) throw new Error('Cancellation actor is invalid.');
      if (actorType === 'admin' && ![...CUSTOMER_CANCELLABLE, 'Rider assigned', 'Picked up', 'Out for delivery', 'Delivered'].includes(order.status)) {
        result = { status: 409, body: { error: 'That order status transition is not allowed.' } }; return;
      }
      if (actorType === 'admin' && order.status === 'Delivered' && !await db.collection('referrals').findOne({ qualifyingOrderId: order.id, rewardId: { $ne: null } }, { session })) {
        result = { status: 409, body: { error: 'Delivered orders require a supported correction workflow.' } }; return;
      }
      const at = now.toISOString();
      const previousStatus = order.status;
      const next = {
        ...order,
        status: 'Cancelled',
        cancellation: { actorType, actorId: String(actorId), reason, at, previousStatus },
        cancellationReason: reason,
        cancelledAt: at,
        paymentStatus: order.paymentCollection?.collectedAt ? 'Cash collection reconciliation required' : 'Not collected (order cancelled)',
        history: [...(order.history || []), { status: 'Cancelled', at, actorType, actorId: String(actorId), reason, previousStatus }],
        timeline: [...(order.timeline || []), { label: 'Cancelled', complete: true, at, reason }]
      };
      if (order.paymentCollection?.collectedAt) next.paymentReconciliation = { status: 'review_required', reason: 'Order cancelled after rider collected cash', amount: order.paymentCollection.amount, flaggedAt: at };
      if (order.paymentMethod !== 'Cash on delivery') next.paymentReconciliation = { status: 'review_required', reason: 'Historical payment requires manual review; no refund was issued.', flaggedAt: at };
      const shouldRestore = !order.inventoryRestockedAt && [...CUSTOMER_CANCELLABLE, 'Rider assigned'].includes(previousStatus);
      if (shouldRestore) {
        for (const item of order.items || []) {
          const amount = consumedUnits(item);
          const filter = { id: String(item.id) };
          const update = { $inc: { stock: amount } };
          const options = { session };
          if (item.variantId && !String(item.variantId).startsWith('custom-')) {
            filter.variants = { $elemMatch: { id: item.variantId } };
            update.$inc['variants.$[variant].stock'] = amount;
            options.arrayFilters = [{ 'variant.id': item.variantId }];
          }
          const changed = await db.collection('products').updateOne(filter, update, options);
          if (changed.modifiedCount !== 1) throw new Error(`Unable to restore stock for order item ${item.id}.`);
        }
        next.inventoryRestockedAt = at;
      } else if (!order.inventoryRestockedAt) next.inventoryReconciliationRequired = true;
      const orderGuard = { id: order.id, ...ownership, status: previousStatus };
      if (order.inventoryRestockedAt) orderGuard.inventoryRestockedAt = order.inventoryRestockedAt;
      else orderGuard.inventoryRestockedAt = { $exists: false };
      const write = await orders.updateOne(orderGuard, { $set: next }, { session });
      if (write.modifiedCount !== 1) throw Object.assign(new Error('Order changed during cancellation; retry the request.'), { code: 'ORDER_CONFLICT' });
      // Regular promotional coupons remain consumed after cancellation. A
      // referral reward is returned once when the cancellation commits.
      if (order.rewardId) {
        const reward = await db.collection('rewards').findOne({ id: order.rewardId, userId: order.userId }, { session, projection: { _id: 0 } });
        const history = reward?.redemptionHistory?.find(row => row.orderId === order.id && row.status === 'redeemed');
        if (reward && (history || reward.orderId === order.id) && ['available', 'redeemed'].includes(reward.status)) {
          const count = Math.max(0, Number(reward.redemptionCount || 1) - 1);
          const status = reward.expiresAt && Date.parse(reward.expiresAt) <= now.getTime() ? 'expired' : count >= Number(reward.redemptionLimit || 1) ? 'redeemed' : 'available';
          const redemptionHistory = (reward.redemptionHistory || []).map(row => row.orderId === order.id ? { ...row, status: 'cancelled', cancelledAt: at } : row);
          const latest = redemptionHistory.findLast(row => row.status === 'redeemed');
          await db.collection('rewards').updateOne({ id: reward.id }, { $set: { redemptionCount: count, status, redemptionHistory, orderId: latest?.orderId || null, redeemedAt: latest?.redeemedAt || null } }, { session });
          if (reward.couponCode) {
            await db.collection('coupons').updateOne({ code: reward.couponCode }, { $set: { redemptionCount: count, isActive: status === 'available' } }, { session });
            await db.collection('couponRedemptions').updateOne({ orderId: order.id, couponCode: reward.couponCode }, { $set: { cancelledAt: at } }, { session });
          }
        }
      }
      const referrals = await db.collection('referrals').find({ qualifyingOrderId: order.id }, { session }).toArray();
      for (const referral of referrals) {
        const reward = await db.collection('rewards').findOne({ id: referral.rewardId }, { session });
        if (reward) {
          await db.collection('rewards').updateOne({ id: reward.id }, { $set: { status: Number(reward.redemptionCount || 0) ? 'review_required' : 'cancelled', cancelledAt: at, reviewReason: 'Qualifying order cancelled' } }, { session });
          if (reward.couponCode) await db.collection('coupons').updateOne({ code: reward.couponCode }, { $set: { isActive: false } }, { session });
        }
        await db.collection('referrals').updateOne({ id: referral.id }, { $set: { status: 'cancelled' } }, { session });
      }
      const notices = await buildNotifications?.(next, session);
      if (notices?.length) await db.collection('notifications').insertMany(notices, { session, ordered: true });
      await recordEvents?.(next, session);
      result = { status: 200, body: { order: next } };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return result;
  } finally {
    await session.endSession();
  }
}
