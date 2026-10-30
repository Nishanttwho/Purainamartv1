import { requireRider } from './api-auth.mjs';
import { fail, pageOptions } from './mongo-repository.mjs';
import { safeRider, nowIso } from './commerce.mjs';
import { notificationList, createNotice } from './mongo-notifications.mjs';
import { issueReferralReward } from './mongo-referrals.mjs';
import { isValidSummaryMonth, isValidSummaryDate } from './rider-delivery-summary.mjs';

export const openOrderFilter = riderId => ({ riderId, status: { $nin: ['Delivered', 'Cancelled'] } });
export function milestone(order, label, actorType, actorId, reason) {
  const at = nowIso();
  order.timeline ||= [];
  const step = order.timeline.find(row => row.label === label);
  if (step) Object.assign(step, { complete: true, at }); else order.timeline.push({ label, complete: true, at, ...(reason ? { reason } : {}) });
  order.history ||= []; order.history.push({ status: order.status, at, actorType, actorId, ...(reason ? { reason } : {}) });
  return at;
}
export function riderOrderSummary(order) {
  return { id: order.id, displayId: order.displayId, status: order.status, deliveredAt: order.deliveredAt || null, itemCount: (order.items || []).reduce((n, row) => n + row.quantity, 0), city: order.address?.city, deliveryArea: order.deliveryArea || null, total: order.total, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, paymentCollection: order.paymentCollection || null, amountToCollect: order.paymentMethod === 'Cash on delivery' && !order.paymentCollection?.collectedAt && !['Delivered', 'Cancelled'].includes(order.status) ? order.total : 0, readyAt: order.readyAt || null, assignedAt: order.assignedAt || null };
}
export async function riderOrderDetails(repo, order, { preview = false } = {}) {
  const user = await repo.one('users', { id: order.userId }), visible = Boolean(order.riderId) || preview;
  const address = order.address || {};
  return { ...riderOrderSummary(order), assignedToRiderId: order.riderId || null, customerContact: visible ? { name: address.recipientName || user?.name || 'Customer', phone: address.phone || user?.phone || null } : null, address: visible ? address : { label: address.label, city: address.city, deliveryAreaName: address.deliveryAreaName }, deliveryInstructions: visible ? String(address.deliveryInstructions || address.instructions || address.landmark || '').slice(0, 300) : '', items: order.items, timeline: order.timeline, cancellation: order.cancellation || null, paymentVerification: order.paymentVerification || null, paymentReconciliation: order.paymentReconciliation || null, inventoryReconciliationRequired: Boolean(order.inventoryReconciliationRequired) };
}
export async function riderDeliverySummary(repo, riderId, month, date) {
  const today = nowIso().slice(0, 10); month ||= today.slice(0, 7); date ||= today;
  if (!isValidSummaryMonth(month) || !isValidSummaryDate(date) || date > today) fail(400, 'Choose a valid month and date no later than today.');
  const pipeline = [
    { $match: { riderId, status: 'Delivered' } },
    { $set: { summaryMonth: { $substrBytes: [{ $ifNull: ['$deliveredAt', ''] }, 0, 7] }, summaryDate: { $substrBytes: [{ $ifNull: ['$deliveredAt', ''] }, 0, 10] }, cash: { $cond: [{ $and: [{ $eq: ['$paymentMethod', 'Cash on delivery'] }, { $eq: ['$paymentCollection.method', 'cash'] }, { $eq: ['$paymentCollection.riderId', riderId] }, { $eq: ['$paymentCollection.amount', '$total'] }, { $ne: [{ $ifNull: ['$paymentCollection.collectedAt', null] }, null] }] }, '$total', 0] } } },
    { $group: { _id: null, completedDeliveries: { $sum: 1 }, codCollected: { $sum: '$cash' }, monthCompletedDeliveries: { $sum: { $cond: [{ $eq: ['$summaryMonth', month] }, 1, 0] } }, monthCodCollected: { $sum: { $cond: [{ $eq: ['$summaryMonth', month] }, '$cash', 0] } }, dailyCompletedDeliveries: { $sum: { $cond: [{ $eq: ['$summaryDate', date] }, 1, 0] } }, dailyCodCollected: { $sum: { $cond: [{ $eq: ['$summaryDate', date] }, '$cash', 0] } } } }
  ];
  const [value] = await repo.collection('orders').aggregate(pipeline, repo.options()).toArray();
  const { _id, ...totals } = value || {};
  return { completedDeliveries: 0, codCollected: 0, monthCompletedDeliveries: 0, monthCodCollected: 0, dailyCompletedDeliveries: 0, dailyCodCollected: 0, ...totals, month, date, today };
}
export async function notifyDesignatedRider(repo, order) {
  const settings = await repo.setting('dispatchSettings', {});
  if (!settings.designatedRiderId || !await repo.exists('riders', { id: settings.designatedRiderId, isActive: { $ne: false } })) return;
  await createNotice(repo, 'rider', settings.designatedRiderId, { eventType: 'rider_order', eventId: `order:${order.id}:ready_for_pickup`, title: 'New delivery available', message: `Order ${order.displayId} is ready for pickup.`, orderId: order.id, destination: `/rider?order=${order.id}` });
}
export async function assignRider(repo, order, rider, actorType, actorId) {
  if (order.status !== 'Ready for pickup' || order.riderId) fail(409, 'Only ready, unassigned orders can be assigned.');
  // Serializes assignment against rider deactivation/availability changes.
  await repo.update('riders', { id: rider.id }, { $inc: { assignmentRevision: 1 } });
  order.riderId = rider.id; order.status = 'Rider assigned'; order.assignedAt = milestone(order, 'Accepted by rider', actorType, actorId);
  await createNotice(repo, 'customer', order.userId, { eventType: 'rider_assigned', eventId: `order:${order.id}:rider_assigned`, title: 'Your rider is assigned', message: `A delivery partner is preparing to collect order ${order.displayId}.`, orderId: order.id });
  await createNotice(repo, 'rider', rider.id, { eventType: 'rider_order', eventId: `order:${order.id}:assigned:${rider.id}`, title: 'Delivery assigned', message: `Order ${order.displayId} is assigned to you.`, orderId: order.id, destination: `/rider?order=${order.id}` });
}
export async function handleRiderApi(repo, ctx) {
  if (!ctx.route.startsWith('/api/rider/')) return undefined;
  const { route, method, body, url } = ctx;
  const rider = requireRider(ctx, route === '/api/rider/bootstrap');
  if (route === '/api/rider/bootstrap' && rider.mustChangePassword) return { rider: safeRider(rider), needsPasswordChange: true };
  const dispatch = await repo.setting('dispatchSettings', {});
  const availableFilter = { status: 'Ready for pickup', riderId: null, 'riderRejections.riderId': { $ne: rider.id } };
  if (method === 'GET' && ['/api/rider/bootstrap', '/api/rider/orders'].includes(route)) {
    const available = dispatch.designatedRiderId === rider.id ? await repo.list('orders', availableFilter, pageOptions(url)) : [];
    const assigned = await repo.list('orders', openOrderFilter(rider.id), pageOptions(url)), assignedOrders = [];
    for (const row of assigned) assignedOrders.push(await riderOrderDetails(repo, row));
    const delivered = await repo.list('orders', { riderId: rider.id, status: 'Delivered' }, { ...pageOptions(url), sort: { deliveredAt: -1 } });
    const notices = await notificationList(repo, 'rider', rider.id, { limit: 50 });
    return { rider: safeRider(rider), availableOrders: available.map(riderOrderSummary), assignedOrders, deliveredOrders: delivered.map(riderOrderSummary), deliverySummary: await riderDeliverySummary(repo, rider.id, url.searchParams.get('month'), url.searchParams.get('date')), notifications: notices.notifications, notificationUnread: notices.unread };
  }
  if (route === '/api/rider/status' && method === 'POST') {
    if (!['online', 'offline'].includes(body.status)) fail(400, 'Choose online or offline.');
    if (body.status === 'offline' && await repo.exists('orders', openOrderFilter(rider.id))) fail(409, 'Complete your active delivery before going offline.');
    rider.status = body.status; return { rider: safeRider(rider) };
  }
  const match = route.match(/^\/api\/rider\/orders\/([^/]+)(?:\/(accept|reject|payment))?$/);
  if (!match) return undefined;
  const [, id, actionRoute] = match;
  const order = await repo.one('orders', { id });
  if (!order) fail(404, 'Delivery not found');
  const available = order.status === 'Ready for pickup' && !order.riderId && dispatch.designatedRiderId === rider.id && !(order.riderRejections || []).some(row => row.riderId === rider.id);
  if (method === 'GET' && !actionRoute) {
    if (order.riderId !== rider.id && !available) fail(404, 'Delivery not found');
    return { order: await riderOrderDetails(repo, order, { preview: available }) };
  }
  if (method !== 'POST') fail(405, 'Method not allowed');
  if (actionRoute === 'accept' || actionRoute === 'reject') {
    if (dispatch.designatedRiderId !== rider.id) fail(403, 'Only the designated rider can accept or reject new orders.');
    if (!available) fail(409, 'This delivery is no longer available.');
    if (actionRoute === 'accept') {
      if (rider.status !== 'online') fail(409, 'Go online before accepting a delivery.');
      await assignRider(repo, order, rider, 'rider', rider.id);
    } else {
      const reason = String(body.reason || '').trim().slice(0, 300); if (!reason) fail(400, 'Enter a rejection reason.');
      order.riderRejections ||= []; order.riderRejections.push({ riderId: rider.id, reason, at: nowIso() }); milestone(order, 'Rejected by rider', 'rider', rider.id, reason);
    }
  } else {
    if (order.riderId !== rider.id) fail(404, 'Assigned delivery not found');
    if (actionRoute === 'payment') {
      if (order.status !== 'Out for delivery') fail(409, 'Payment collection is available during the delivery handoff.');
      if (order.paymentMethod !== 'Cash on delivery' || body.method !== 'cash') fail(400, 'Only cash collection is supported.', 'COD_ONLY');
      if (order.paymentCollection?.collectedAt) fail(409, 'Cash collection has already been recorded.');
      if (body.confirmed !== true) fail(400, 'Confirm that the customer physically handed over the cash.');
      order.paymentCollection = { amount: order.total, method: 'cash', riderId: rider.id, collectedAt: nowIso() }; order.paymentStatus = 'Cash collected by rider';
      milestone(order, 'Cash collected', 'rider', rider.id);
      await createNotice(repo, 'customer', order.userId, { eventType: 'payment_update', eventId: `order:${id}:cash_collected`, title: 'Cash collected', message: `The delivery partner recorded cash collection for order ${order.displayId}.`, orderId: id });
    } else {
      const transition = { pickup: ['Rider assigned', 'Picked up'], out_for_delivery: ['Picked up', 'Out for delivery'], delivered: ['Out for delivery', 'Delivered'] }[body.action];
      if (!transition) fail(400, 'Unknown delivery action');
      if (order.status !== transition[0]) fail(409, `Delivery must be ${transition[0].toLowerCase()} before this step.`);
      if (body.action === 'delivered' && !(order.paymentMethod === 'Cash on delivery' && order.paymentCollection?.method === 'cash' && order.paymentCollection.riderId === rider.id && order.paymentCollection.collectedAt && order.paymentCollection.amount === order.total)) fail(409, 'Collect and record the exact COD amount before marking this order delivered.');
      order.status = transition[1]; order[`${body.action}At`] = milestone(order, transition[1], 'rider', rider.id);
      if (body.action === 'delivered') { order.paymentStatus = 'Cash collected'; await issueReferralReward(repo, order); }
      await createNotice(repo, 'customer', order.userId, { eventType: 'delivery_status', eventId: `order:${id}:status:${transition[1]}`, title: transition[1], message: `Order ${order.displayId} is ${transition[1].toLowerCase()}.`, orderId: id });
    }
  }
  return { order: await riderOrderDetails(repo, order) };
}
