// Display compatibility only. Historical records and their timestamps are never migrated.
export const ORDER_STATUSES = ['New', 'Accepted', 'Out for Delivery', 'Delivered', 'Cancelled'];
export const STATUS_ALIASES = {
  New: ['New', 'Order received', 'Order placed', 'Placed'],
  Accepted: ['Accepted', 'Being packed', 'Ready for pickup', 'Rider assigned', 'Accepted by rider'],
  'Out for Delivery': ['Out for Delivery', 'Out for delivery', 'Dispatched', 'Picked up'],
  Delivered: ['Delivered'], Cancelled: ['Cancelled']
};
// Only orders explicitly enrolled in the new workflow enter automatic distribution.
// Legacy unassigned records keep their original status, dates and payment data.
export const INBOX_STATUSES = ['New'];
export function isAutomaticOrder(order) { return order?.workflowVersion === 2 && INBOX_STATUSES.includes(order.status); }
export function orderStatus(order) {
  const raw = typeof order === 'string' ? order : order?.status;
  return ORDER_STATUSES.find(status => STATUS_ALIASES[status].includes(raw)) || raw || 'Unknown';
}
export function customerCanCancel(order) {
  return !order.riderId && !order.fulfillmentStartedAt && !order.inventoryReconciliationRequired && [...STATUS_ALIASES.New, 'Being packed', 'Ready for pickup'].includes(order.status);
}
