function validTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function utcMonth(value) {
  return validTimestamp(value) ? new Date(value).toISOString().slice(0, 7) : null;
}

function utcDate(value) {
  return validTimestamp(value) ? new Date(value).toISOString().slice(0, 10) : null;
}

export function isValidSummaryMonth(month) {
  return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export function isValidSummaryDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`))
    && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
}

export function summarizeRiderDeliveries(orders, riderId, month, date = new Date().toISOString().slice(0, 10)) {
  if (month !== undefined && !isValidSummaryMonth(month)) throw new TypeError('Month must use YYYY-MM format.');
  if (!isValidSummaryDate(date)) throw new TypeError('Date must use YYYY-MM-DD format.');
  const unique = new Map();
  for (const order of orders || []) {
    if (!order || !order.id || order.riderId !== riderId || order.status !== 'Delivered') continue;
    const current = unique.get(order.id);
    if (!current || Date.parse(order.deliveredAt || '') > Date.parse(current.deliveredAt || '')) unique.set(order.id, order);
  }
  const completed = [...unique.values()];
  const inMonth = month === undefined ? completed : completed.filter(order => utcMonth(order.deliveredAt) === month);
  const inDay = completed.filter(order => utcDate(order.deliveredAt) === date);
  const codCollected = rows => rows.reduce((sum, order) => {
    const collection = order.paymentCollection;
    const validCollection = order.paymentMethod === 'Cash on delivery'
      && collection?.method === 'cash'
      && collection.riderId === riderId
      && validTimestamp(collection.collectedAt)
      && Number.isFinite(Number(collection.amount))
      && Number(collection.amount) === Number(order.total);
    return sum + (validCollection ? Number(collection.amount) : 0);
  }, 0);
  return {
    completedDeliveries: completed.length,
    codCollected: codCollected(completed),
    month: month === undefined ? null : month,
    monthCompletedDeliveries: inMonth.length,
    monthCodCollected: codCollected(inMonth),
    date,
    today: new Date().toISOString().slice(0, 10),
    dailyCompletedDeliveries: inDay.length,
    dailyCodCollected: codCollected(inDay)
  };
}
