import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, password } from './support/api-fixture.mjs';
import { matches } from './support/fake-mongo.mjs';

test('HTTP Mongo mock: registration, durable hashed session, login, logout and guest cart merge', async t => {
  const f = await fixture(t), gid = 'g'.repeat(40);
  await f.call('/api/cart/items', { as: '', cookie: `gid=${gid}`, method: 'POST', body: { productId: 'p1', delta: 2 } });
  const registered = await f.call('/api/auth/register', { as: '', cookie: `gid=${gid}`, method: 'POST', body: { phone: '9444444003', name: 'New Customer', password, confirmPassword: password } });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  assert.equal(f.docs.carts.find(row => row.ownerId === registered.data.user.id).items[0].quantity, 2);
  assert.ok(f.docs.sessions.every(row => row.idHash.length === 64 && row.expiresAt instanceof Date));
  assert.equal(JSON.stringify(registered.data).includes('passwordHash'), false);
  const wrong = await f.call('/api/auth/password/login', { as: '', method: 'POST', body: { phone: '9444444003', password: 'incorrect-password' } }); assert.equal(wrong.status, 401);
  const login = await f.call('/api/auth/password/login', { as: '', method: 'POST', body: { phone: '9444444003', password } }); assert.equal(login.status, 200);
  const cookie = login.cookie.split(';')[0];
  assert.equal((await f.call('/api/auth/session', { cookie })).status, 200);
  await f.call('/api/auth/logout', { cookie, method: 'POST', body: {} });
  assert.equal((await f.call('/api/auth/session', { cookie })).status, 401);
});
test('HTTP Mongo mock: COD checkout uses authoritative prices, atomic stock, notifications and idempotent replay', async t => {
  const f = await fixture(t);
  const response = await f.order(); assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.order.total, 122); assert.equal(response.data.order.status, 'New');
  assert.equal(f.docs.products[0].stock, 19); assert.equal(f.docs.carts.length, 0);
  assert.equal(f.docs.notifications.length, 1); assert.equal(f.docs.notificationEvents.length, 3); assert.equal(f.docs.notificationOutbox.length, 3);
  const writes = f.operations.filter(row => ['insertOne','updateOne','deleteOne'].includes(row.operation) && ['orders','products','notificationEvents','notificationOutbox','carts'].includes(row.name));
  assert.ok(writes.every(row => row.session));
  const replay = await f.call('/api/orders', { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: 'test-checkout-key-0001', total: 0 } });
  assert.equal(replay.status, 200); assert.equal(replay.data.idempotentReplay, true); assert.equal(f.docs.orders.length, 1); assert.equal(f.docs.products[0].stock, 19);
});
test('HTTP Mongo mock: failures roll back checkout stock, order, coupon and cart writes', async t => {
  const f = await fixture(t);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  await f.call('/api/coupons/apply', { method: 'POST', body: { code: 'SAVE10' } });
  f.failNext('notificationOutbox', 'insertOne');
  const response = await f.call('/api/orders', { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: 'rollback-checkout-0001' } });
  assert.equal(response.status, 503); assert.equal(f.docs.orders?.length || 0, 0); assert.equal(f.docs.products[0].stock, 20); assert.equal(f.docs.coupons[0].redemptionCount, 0); assert.equal(f.docs.carts[0].items.length, 1);
});
test('HTTP Mongo mock: loose and custom grams are repriced and never oversell shared product stock', async t => {
  const f = await fixture(t);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'loose', variantId: 'v500', delta: 2 } });
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'loose', variantId: 'custom-750', delta: 1 } });
  f.docs.carts[0].items.forEach(row => { row.price = 0; row.totalBaseQuantity = 1; row.saleType = 'legacy'; });
  const response = await f.call('/api/orders', { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: 'loose-checkout-0001', total: 0 } });
  assert.equal(response.status, 201, JSON.stringify(response.data)); assert.equal(response.data.order.subtotal, 175); assert.equal(f.docs.products[1].stock, 250);
  const cancelled = await f.call(`/api/orders/${response.data.order.id}/cancel`, { method: 'POST', body: {} }); assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data)); assert.equal(f.docs.products[1].stock, 2000);
});
test('HTTP Mongo mock: customer cancellation is owned and restores inventory only once', async t => {
  const f = await fixture(t), response = await f.order(), id = response.data.order.id;
  assert.equal((await f.call(`/api/orders/${id}/cancel`, { as: 'customer2', method: 'POST', body: {} })).status, 404);
  const result = await f.call(`/api/orders/${id}/cancel`, { method: 'POST', body: {} }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(f.docs.products[0].stock, 20);
  assert.equal((await f.call(`/api/orders/${id}/cancel`, { method: 'POST', body: {} })).status, 409); assert.equal(f.docs.products[0].stock, 20);
});
test('HTTP Mongo mock: real admin and rider handlers enforce full cash delivery workflow', async t => {
  const f = await fixture(t), placed = await f.order(), id = placed.data.order.id;
  for (const status of ['Being packed', 'Ready for pickup']) { const result = await f.call(`/api/admin/orders/${id}/status`, { as: 'admin', method: 'PATCH', body: { status } }); assert.equal(result.status, 409, JSON.stringify(result.data)); }
  assert.equal((await f.call('/api/rider/bootstrap', { as: 'rider' })).data.availableOrders.length, 1);
  assert.equal((await f.call(`/api/rider/orders/${id}/accept`, { as: 'rider', method: 'POST', body: {} })).status, 200);
  assert.equal((await f.call(`/api/orders/${id}/cancel`, { method: 'POST', body: {} })).status, 409);
  for (const action of ['out_for_delivery']) assert.equal((await f.call(`/api/rider/orders/${id}`, { as: 'rider', method: 'POST', body: { action } })).status, 200);
  assert.equal((await f.call(`/api/rider/orders/${id}`, { as: 'rider', method: 'POST', body: { action: 'delivered' } })).status, 409);
  assert.equal((await f.call(`/api/rider/orders/${id}/payment`, { as: 'rider', method: 'POST', body: { method: 'cash', confirmed: true, amount: placed.data.order.total } })).status, 200);
  assert.equal((await f.call(`/api/rider/orders/${id}/payment`, { as: 'rider', method: 'POST', body: { method: 'cash', confirmed: true, amount: placed.data.order.total } })).status, 409);
  const delivered = await f.call(`/api/rider/orders/${id}`, { as: 'rider', method: 'POST', body: { action: 'delivered' } }); assert.equal(delivered.status, 200, JSON.stringify(delivered.data));
  assert.equal(f.docs.orders[0].paymentStatus, 'Cash collected');
  const summary = await f.call('/api/rider/bootstrap', { as: 'rider' }); assert.equal(summary.data.deliverySummary.completedDeliveries, 1); assert.equal(summary.data.deliverySummary.codCollected, 122);
});
test('HTTP Mongo mock: admin dashboard, catalogue and customer management use Mongo documents', async t => {
  const f = await fixture(t);
  const product = await f.call('/api/admin/products', { as: 'admin', method: 'POST', body: { name: 'New Pack', category: 'pantry', price: 25, mrp: 30, stock: 5 } }); assert.equal(product.status, 201, JSON.stringify(product.data));
  assert.equal((await f.call(`/api/admin/products/${product.data.product.id}`, { as: 'admin', method: 'PATCH', body: { stock: 4 } })).status, 200);
  const dashboard = await f.call('/api/admin/bootstrap', { as: 'admin' }); assert.equal(dashboard.status, 200, JSON.stringify(dashboard.data)); assert.equal(dashboard.data.products.length, 3);
  const block = await f.call('/api/admin/customers/u1/block', { as: 'admin', method: 'POST', body: { reason: 'Test restriction' } }); assert.equal(block.status, 200, JSON.stringify(block.data));
  assert.equal((await f.call('/api/auth/session')).status, 401); assert.equal(f.docs.sessions.some(row => row.ownerId === 'u1'), false);
  assert.equal((await f.call('/api/admin/customers/u1/unblock', { as: 'admin', method: 'POST', body: {} })).status, 200);
});
test('HTTP Mongo mock: address edits, selection, ownership and removal persist', async t => {
  const f = await fixture(t);
  const created = await f.call('/api/addresses', { method: 'POST', body: { recipientName: 'Other recipient', phone: '9444444001', line1: 'Second street', city: 'Test City', deliveryAreaId: 'area1' } }); assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.address.id;
  assert.equal((await f.call(`/api/addresses/${id}/default`, { method: 'PATCH', body: {} })).status, 200);
  assert.equal(f.docs.addresses.filter(row => row.customerId === 'u1' && row.isDefault).length, 1);
  assert.equal((await f.call(`/api/addresses/${id}`, { as: 'customer2', method: 'DELETE', body: {} })).status, 404);
  assert.equal((await f.call(`/api/addresses/${id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal(f.docs.addresses.some(row => row.id === id), false);
});
test('HTTP Mongo mock: coupon redemption limits and order pricing are server enforced', async t => {
  const f = await fixture(t);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  const applied = await f.call('/api/coupons/apply', { method: 'POST', body: { code: 'SAVE10' } }); assert.equal(applied.data.cart.discount, 10, JSON.stringify(applied.data));
  const order = await f.call('/api/orders', { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: 'coupon-checkout-0001', discount: 1000 } }); assert.equal(order.status, 201, JSON.stringify(order.data)); assert.equal(order.data.order.total, 112); assert.equal(f.docs.couponRedemptions.length, 1);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  assert.equal((await f.call('/api/coupons/apply', { method: 'POST', body: { code: 'SAVE10' } })).status, 400);
});
test('HTTP Mongo mock: no store-wide reads during checkout and cart ownership stays isolated', async t => {
  const f = await fixture(t); await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  assert.equal((await f.call('/api/cart', { as: 'customer2' })).data.count, 0);
  const before = f.operations.length; await f.call('/api/orders', { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: 'targeted-checkout-0001' } });
  assert.ok(f.operations.slice(before).filter(row => row.operation === 'find').every(row => Object.keys(row.filter).length > 0));
});
for (const [route, as] of [['/api/bootstrap','customer'], ['/api/products',''], ['/api/categories',''], ['/api/delivery-areas',''], ['/api/referrals/me','customer'], ['/api/admin/customers','admin'], ['/api/admin/referrals','admin'], ['/api/admin/settings','admin'], ['/api/admin/notifications','admin'], ['/api/rider/orders','rider']]) {
  test(`HTTP Mongo mock: registered read handler ${route}`, async t => { const f = await fixture(t); const result = await f.call(route, { as }); assert.equal(result.status, 200, JSON.stringify(result.data)); });
}
for (const route of ['/api/admin/bootstrap','/api/rider/bootstrap','/api/orders','/api/addresses','/api/account']) {
  test(`HTTP Mongo mock: unauthenticated access denied for ${route}`, async t => { const f = await fixture(t); assert.equal((await f.call(route, { as: '' })).status, 401); });
}
for (const route of ['/cart','/account','/referral','/orders','/checkout','/orders/example-order','/products/p1','/categories/pantry']) {
  test(`HTTP static route: refresh serves customer shell at ${route}`, async t => { const f = await fixture(t); const response = await f.call(route, { as: '' }); assert.equal(response.status, 200); assert.match(response.data, /id="main-content"/); });
}
test('HTTP Mongo mock: non-COD and missing idempotency key are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/orders', { method: 'POST', body: { paymentMethod: 'upi' } })).status, 400);
  assert.equal((await f.call('/api/orders', { method: 'POST', body: { paymentMethod: 'cod' } })).status, 400);
});
