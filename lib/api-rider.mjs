import { requireRider } from './api-auth.mjs';
import { fail, pageOptions } from './mongo-repository.mjs';
import { safeRider, nowIso } from './commerce.mjs';
import { notificationList, createNotice } from './mongo-notifications.mjs';
import { issueReferralReward } from './mongo-referrals.mjs';
import { isValidSummaryMonth, isValidSummaryDate } from './rider-delivery-summary.mjs';
import { INBOX_STATUSES, isAutomaticOrder, orderStatus } from '../public/order-status.js';

export const openOrderFilter = riderId => ({ riderId, status: { $nin: ['Delivered', 'Cancelled'] } });
export function milestone(order, label, actorType, actorId, reason) {
  const at = nowIso();
  order.timeline ||= [];
  const step = order.timeline.find(row => row.label === label && !row.complete);
  if (step) Object.assign(step, { complete: true, at, actorType, actorId, ...(reason ? { reason } : {}) }); else order.timeline.push({ label, complete: true, at, actorType, actorId, ...(reason ? { reason } : {}) });
  order.history ||= []; order.history.push({ status: order.status, at, actorType, actorId, ...(reason ? { reason } : {}) });
  return at;
}
export function riderOrderSummary(order) {
  return { id: order.id, displayId: order.displayId, createdAt: order.createdAt, customerName: order.address?.recipientName || 'Customer', status: order.status, deliveredAt: order.deliveredAt || null, itemCount: (order.items || []).reduce((n, row) => n + row.quantity, 0), city: order.address?.city, deliveryArea: order.deliveryArea || null, total: order.total, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, paymentCollection: order.paymentCollection || null, amountToCollect: order.paymentMethod === 'Cash on delivery' && !order.paymentCollection?.collectedAt && !['Delivered', 'Cancelled'].includes(order.status) ? order.total : 0, readyAt: order.readyAt || null, assignedAt: order.assignedAt || null };
}
export async function riderOrderDetails(repo, order, { preview = false } = {}) {
  const user = order.address?.recipientName && order.address?.phone ? null : await repo.one('users', { id: order.userId }), visible = Boolean(order.riderId) || preview;
  const address = order.address || {};
  return { ...riderOrderSummary(order), displayStatus: orderStatus(order), subtotal: order.subtotal, delivery: order.delivery, discount: order.discount, platform: order.platform, couponCode: order.couponCode, history: order.history, deliveryReleases: order.deliveryReleases || [], assignedToRiderId: order.riderId || null, customerContact: visible ? { name: address.recipientName || user?.name || 'Customer', phone: address.phone || user?.phone || null } : null, address: visible ? address : { label: address.label, city: address.city, deliveryAreaName: address.deliveryAreaName }, deliveryInstructions: visible ? String(address.deliveryInstructions || address.instructions || address.landmark || '').slice(0, 300) : '', items: order.items, timeline: order.timeline, cancellation: order.cancellation || null, paymentVerification: order.paymentVerification || null, paymentReconciliation: order.paymentReconciliation || null, inventoryReconciliationRequired: Boolean(order.inventoryReconciliationRequired) };
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
export const eligibleRiderFilter = { isActive: { $ne: false }, status: 'online', mustChangePassword: { $ne: true } };
export const riderInboxFilter = riderId => ({ workflowVersion: 2, status: { $in: INBOX_STATUSES }, riderId: null, 'riderRejections.riderId': { $ne: riderId } });
export async function notifyAvailableRiders(repo, order) {
  if (!isAutomaticOrder(order) || order.riderId) return;
  const rejected = (order.riderRejections || []).map(row => row.riderId);
  const riders = await repo.all('riders', { ...eligibleRiderFilter, id: { $nin: rejected } });
  const revision = order.assignmentRevision || 0;
  for (const rider of riders) await createNotice(repo, 'rider', rider.id, { eventType: 'rider_order', eventId: `order:${order.id}:available:${revision}`, title: 'New order available', message: `Order ${order.displayId} is available to accept.`, orderId: order.id, destination: `/rider?order=${order.id}` });
  if (!riders.length) await notifyOrderAdmins(repo, order, `unavailable:${revision}`, 'No rider available', 'No eligible online rider is available. The customer order remains open.');
}
export async function notifyOrderAdmins(repo, order, event, title, message) {
  for (const admin of await repo.all('admins', { isActive: { $ne: false } })) await createNotice(repo, 'admin', admin.id, { eventType: 'admin_operational', eventId: `order:${order.id}:${event}`, title, message: `Order ${order.displayId}: ${message}`, orderId: order.id, destination: '/admin#orders' });
}
export async function assignRider(repo, order, rider, actorType, actorId) {
  if (!isAutomaticOrder(order) || order.riderId) fail(409, 'This order has already been accepted or is no longer available.');
  // Serializes assignment against rider deactivation/availability changes.
  const eligible = await repo.update('riders', { id: rider.id, ...eligibleRiderFilter }, { $inc: { assignmentRevision: 1 } });
  if (eligible.matchedCount !== 1) fail(409, 'Go online with an active rider account before accepting.');
  // Compare-and-set inside the existing transaction: a competing rider cannot win.
  const changed = await repo.update('orders', { id: order.id, ...riderInboxFilter(rider.id) }, { $set: { riderId: rider.id, status: 'Accepted' }, $inc: { assignmentRevision: 1 } });
  if (changed.modifiedCount !== 1) fail(409, 'This delivery is no longer available.');
  order.assignmentRevision = Number(order.assignmentRevision || 0) + 1;
  order.riderId = rider.id; order.status = 'Accepted'; order.acceptedAt = order.assignedAt = milestone(order, 'Accepted', actorType, actorId);
  order.riderSnapshot = { id: rider.id, name: rider.name, phone: rider.phone };
  await createNotice(repo, 'customer', order.userId, { eventType: 'rider_assigned', eventId: `order:${order.id}:accepted:${order.assignmentRevision}`, title: 'Order accepted', message: `A delivery partner accepted order ${order.displayId}.`, orderId: order.id });
  await notifyOrderAdmins(repo, order, `accepted:${order.assignmentRevision}`, 'Order accepted', `${rider.name} accepted the delivery.`);
}
export async function handleRiderApi(repo, ctx) {
  if (!ctx.route.startsWith('/api/rider/')) return undefined;
  const { route, method, body, url } = ctx;
  const rider = requireRider(ctx, route === '/api/rider/bootstrap');
  if (route === '/api/rider/bootstrap' && rider.mustChangePassword) return { rider: safeRider(rider), needsPasswordChange: true };
  const availableFilter = riderInboxFilter(rider.id);
  if (method === 'GET' && ['/api/rider/bootstrap', '/api/rider/orders'].includes(route)) {
    const [available, assigned, delivered, notices, summary] = await repo.reads([
      () => rider.status === 'online' ? repo.list('orders', availableFilter, pageOptions(url, 24)) : [],
      () => repo.list('orders', openOrderFilter(rider.id), pageOptions(url)),
      () => repo.list('orders', { riderId: rider.id, status: 'Delivered' }, { ...pageOptions(url), sort: { deliveredAt: -1 } }),
      () => notificationList(repo, 'rider', rider.id, { limit: 24 }),
      () => riderDeliverySummary(repo, rider.id, url.searchParams.get('month'), url.searchParams.get('date'))
    ]);
    const assignedOrders = await repo.reads(assigned.map(row => () => riderOrderDetails(repo, row)));
    return { rider: safeRider(rider), availableOrders: available.map(riderOrderSummary), assignedOrders, deliveredOrders: delivered.map(riderOrderSummary), deliverySummary: summary, notifications: notices.notifications, notificationUnread: notices.unread };
  }
  if (route === '/api/rider/status' && method === 'POST') {
    if (!['online', 'offline'].includes(body.status)) fail(400, 'Choose online or offline.');
    if (body.status === 'offline' && await repo.exists('orders', openOrderFilter(rider.id))) fail(409, 'Complete your active delivery before going offline.');
    rider.status = body.status; return { rider: safeRider(rider) };
  }
  const match = route.match(/^\/api\/rider\/orders\/([^/]+)(?:\/(accept|reject|payment|release))?$/);
  if (!match) return undefined;
  const [, id, actionRoute] = match;
  const order = await repo.one('orders', { id });
  if (!order) fail(404, 'Delivery not found');
  const available = isAutomaticOrder(order) && !order.riderId && rider.status === 'online' && !(order.riderRejections || []).some(row => row.riderId === rider.id);
  if (method === 'GET' && !actionRoute) {
    if (order.riderId !== rider.id && !available) fail(404, 'Delivery not found');
    return { order: await riderOrderDetails(repo, order, { preview: available }) };
  }
  if (method !== 'POST') fail(405, 'Method not allowed');
  if (actionRoute === 'accept' || actionRoute === 'reject') {
    if (!available) fail(409, 'This delivery is no longer available.');
    if (actionRoute === 'accept') {
      if (rider.status !== 'online') fail(409, 'Go online before accepting a delivery.');
      await assignRider(repo, order, rider, 'rider', rider.id);
    } else {
      const reason = String(body.reason || '').trim().slice(0, 300); if (!reason) fail(400, 'Enter a rejection reason.');
      const changed = await repo.update('orders', { id, ...riderInboxFilter(rider.id) }, { $inc: { rejectionRevision: 1 } });
      if (changed.modifiedCount !== 1) fail(409, 'This delivery is no longer available.');
      order.riderRejections ||= []; order.riderRejections.push({ riderId: rider.id, reason, at: nowIso() }); milestone(order, 'Rejected by rider', 'rider', rider.id, reason);
      await notifyAvailableRiders(repo, order);
    }
  } else {
    if (order.riderId !== rider.id) fail(404, 'Assigned delivery not found');
    if (actionRoute === 'release') {
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!reason) fail(400, 'Enter a reason for releasing this delivery.');
      if (!['Accepted', 'Out for Delivery'].includes(orderStatus(order))) fail(409, 'Only an active assignment can be released.');
      if (order.paymentCollection?.collectedAt) fail(409, 'Cash is already collected. Contact the administrator for reconciliation before releasing this delivery.');
      const previousStatus = order.status;
      const changed = await repo.update('orders', { id, riderId: rider.id, status: previousStatus }, { $set: { riderId: null, status: 'New' }, $inc: { assignmentRevision: 1 } });
      if (changed.modifiedCount !== 1) fail(409, 'The delivery changed. Refresh and try again.');
      order.assignmentRevision = Number(order.assignmentRevision || 0) + 1;
      order.riderId = null; order.status = 'New'; order.workflowVersion = 2;
      if (orderStatus(previousStatus) === 'Out for Delivery') { order.fulfillmentStartedAt ||= order.pickupAt || order.out_for_deliveryAt || null; order.inventoryReconciliationRequired = true; }
      const at = milestone(order, 'Delivery released', 'rider', rider.id, reason);
      order.deliveryReleases ||= []; order.deliveryReleases.push({ riderId: rider.id, riderName: rider.name, previousStatus, reason, at });
      order.riderRejections ||= []; if (!order.riderRejections.some(row => row.riderId === rider.id)) order.riderRejections.push({ riderId: rider.id, reason, at, released: true });
      await notifyAvailableRiders(repo, order);
      await notifyOrderAdmins(repo, order, `released:${order.assignmentRevision}`, 'Delivery released', `${rider.name} released the delivery: ${reason}`);
      await createNotice(repo, 'customer', order.userId, { eventType: 'delivery_status', eventId: `order:${id}:released:${order.assignmentRevision}`, title: 'Finding another rider', message: 'Your order remains open while another delivery partner accepts it.', orderId: id });
      return { released: true, orderId: id };
    } else if (actionRoute === 'payment') {
      if (orderStatus(order) !== 'Out for Delivery') fail(409, 'Payment collection is available during the delivery handoff.');
      if (order.paymentMethod !== 'Cash on delivery' || body.method !== 'cash') fail(400, 'Only cash collection is supported.', 'COD_ONLY');
      if (order.paymentCollection?.collectedAt) fail(409, 'Cash collection has already been recorded.');
      if (body.confirmed !== true) fail(400, 'Confirm that the customer physically handed over the cash.');
      if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount !== order.total) fail(400, 'Enter the exact amount of cash received; it must equal the order total.');
      const changed = await repo.update('orders', { id, riderId: rider.id, status: order.status, 'paymentCollection.collectedAt': null }, { $set: { paymentStatus: 'Cash collected by rider' } });
      if (changed.matchedCount !== 1) fail(409, 'Cash collection has already been recorded or the order changed.');
      order.paymentCollection = { amount: body.amount, method: 'cash', riderId: rider.id, collectedAt: nowIso() }; order.paymentStatus = 'Cash collected by rider';
      milestone(order, 'Cash collected', 'rider', rider.id);
      await createNotice(repo, 'customer', order.userId, { eventType: 'payment_update', eventId: `order:${id}:cash_collected`, title: 'Cash collected', message: `The delivery partner recorded cash collection for order ${order.displayId}.`, orderId: id });
    } else {
      const transition = { out_for_delivery: ['Accepted', 'Out for Delivery'], delivered: ['Out for Delivery', 'Delivered'] }[body.action];
      if (!transition) fail(400, 'Unknown delivery action');
      if (orderStatus(order) !== transition[0]) fail(409, `Delivery must be ${transition[0].toLowerCase()} before this step.`);
      const paid = order.paymentMethod === 'Cash on delivery' ? order.paymentCollection?.method === 'cash' && order.paymentCollection.riderId === rider.id && order.paymentCollection.collectedAt && order.paymentCollection.amount === order.total : order.paymentVerification?.status === 'verified' && order.paymentVerification?.transactionReference;
      if (body.action === 'delivered' && !paid) fail(409, 'Record the exact COD amount or verify the historical payment before marking this order delivered.');
      order.status = transition[1]; order[`${body.action}At`] = milestone(order, transition[1], 'rider', rider.id);
      if (body.action === 'out_for_delivery') order.fulfillmentStartedAt ||= order.out_for_deliveryAt;
      if (body.action === 'delivered') { if (order.paymentMethod === 'Cash on delivery') order.paymentStatus = 'Cash collected'; await issueReferralReward(repo, order); }
      await notifyOrderAdmins(repo, order, `status:${transition[1]}:${order.assignmentRevision || 0}`, transition[1], `${rider.name} updated the delivery.`);
      await createNotice(repo, 'customer', order.userId, { eventType: 'delivery_status', eventId: `order:${id}:status:${transition[1]}:${order.assignmentRevision || 0}`, title: transition[1], message: `Order ${order.displayId} is ${transition[1].toLowerCase()}.`, orderId: id });
    }
  }
  return { order: await riderOrderDetails(repo, order) };
}
