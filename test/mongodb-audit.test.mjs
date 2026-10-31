import test from 'node:test';
import assert from 'node:assert/strict';
import { addRider } from './support/workflow-fixture.mjs';
import { fixture, password } from './support/api-fixture.mjs';
import { hashPassword, verifyPassword } from '../lib/password.mjs';
import { hashSessionId } from '../lib/mongodb-auth.mjs';
import { startNotificationWorkers } from '../lib/mongo-notifications.mjs';

const checkout = (f, key, as = 'customer') => f.call('/api/orders', { as, method: 'POST', body: { addressId: as === 'customer2' ? 'a2' : 'a1', paymentMethod: 'cod', idempotencyKey: key } });
test('Mongo mock audit: custom millilitres use current per-litre price and restore shared stock', async t => {
  const f = await fixture(t, { products: [{ id: 'oil', name: 'Loose oil', category: 'pantry', saleType: 'loose', measurementUnit: 'ml', price: 123.45, stock: 2000, isActive: true, variants: [{ id: 'bottle', label: '500 ml', quantityBase: 500, price: 61.73, stock: 2000, isActive: true }] }] });
  const cart = await f.call('/api/cart/items', { method: 'POST', body: { productId: 'oil', variantId: 'custom-333', delta: 2 } });
  assert.equal(cart.status, 200); assert.equal(cart.data.items[0].variantLabel, '333 ml'); assert.equal(cart.data.subtotal, 82.22);
  const placed = await checkout(f, 'millilitre-audit-order'); assert.equal(placed.status, 201);
  assert.equal(f.docs.products[0].stock, 1334);
  assert.equal((await f.call(`/api/orders/${placed.data.order.id}/cancel`, { method: 'POST', body: {} })).status, 200);
  assert.equal(f.docs.products[0].stock, 2000);
});
async function ready(f, id) {
  assert.ok((await f.call('/api/rider/bootstrap', { as:'rider' })).data.availableOrders.some(o=>o.id===id));
}
async function deliver(f, id) {
  await ready(f, id);
  assert.equal((await f.call(`/api/rider/orders/${id}/accept`, { as: 'rider', method: 'POST', body: {} })).status, 200);
  for (const action of ['out_for_delivery']) assert.equal((await f.call(`/api/rider/orders/${id}`, { as: 'rider', method: 'POST', body: { action } })).status, 200);
  assert.equal((await f.call(`/api/rider/orders/${id}/payment`, { as: 'rider', method: 'POST', body: { confirmed: true, method: 'cash', amount: f.docs.orders.find(o=>o.id===id).total } })).status, 200);
  const result = await f.call(`/api/rider/orders/${id}`, { as: 'rider', method: 'POST', body: { action: 'delivered' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}

test('Mongo mock audit: packed units, fractional money, tier edits and immutable order snapshots', async t => {
  const f = await fixture(t);
  const payload = { name: 'Packed milk', category: 'pantry', saleType: 'packed', measurementUnit: 'ml', variants: [{ id: 'pack250', label: '250 ml pack', quantityBase: 250, price: 18.25, mrp: 22, stock: 2 }] };
  const created = await f.call('/api/admin/products', { as: 'admin', method: 'POST', body: payload }); assert.equal(created.status, 201);
  const id = created.data.product.id;
  const added = await f.call('/api/cart/items', { method: 'POST', body: { productId: id, variantId: 'pack250', delta: 2 } });
  assert.equal(added.data.subtotal, 36.5); assert.equal(added.data.itemSavings, 7.5);
  assert.equal((await f.call('/api/cart/items', { method: 'POST', body: { productId: id, variantId: 'pack250', delta: 1 } })).status, 409);
  const placed = await checkout(f, 'packed-audit-order-001'); assert.equal(placed.status, 201);
  const product = f.docs.products.find(row => row.id === id); assert.equal(product.stock, 0); assert.equal(product.variants[0].stock, 0);
  assert.equal((await f.call(`/api/admin/products/${id}`, { as: 'admin', method: 'PATCH', body: { saleType: 'legacy' } })).status, 409);
  assert.equal((await f.call(`/api/admin/products/${id}`, { as: 'admin', method: 'PATCH', body: { variants: [{ ...product.variants[0], price: 20 }] } })).status, 200);
  assert.equal((await f.call(`/api/orders/${placed.data.order.id}`)).data.order.items[0].price, 18.25);
  assert.equal((await f.call(`/api/orders/${placed.data.order.id}/cancel`, { method: 'POST', body: {} })).status, 200);
  assert.equal(f.docs.products.find(row => row.id === id).variants[0].stock, 2);
  assert.equal((await f.call(`/api/admin/products/${id}`, { as: 'admin', method: 'PATCH', body: { saleType: 'legacy' } })).status, 200);
  assert.equal(f.docs.products.find(row => row.id === id).variants, undefined);
});

test('Mongo mock audit: loose price edits cannot replenish shared stock and malformed weights fail', async t => {
  const f = await fixture(t);
  for (const variantId of ['custom-0','custom-49','custom-100001','custom-1.5','missing']) assert.equal((await f.call('/api/cart/items', { method: 'POST', body: { productId: 'loose', variantId, delta: 1 } })).status, 409);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'loose', variantId: 'custom-750', delta: 1 } });
  assert.equal((await checkout(f, 'custom-audit-order-001')).status, 201);
  const before = structuredClone(f.docs.products[1]);
  const edited = await f.call('/api/admin/products/loose', { as: 'admin', method: 'PATCH', body: { variants: before.variants.map(row => ({ ...row, price: row.price + 1 })) } });
  assert.equal(edited.status, 200); assert.equal(edited.data.product.stock, 1250);
});

test('Mongo mock audit: coupon expiry, ownership, assignment, notification, revocation and caps', async t => {
  const f = await fixture(t);
  const assigned = await f.call('/api/admin/customers/u1/coupons', { as: 'admin', method: 'POST', body: { code: 'SAVE10', notify: true } });
  assert.equal(assigned.status, 201); assert.equal(assigned.data.notification.created, true);
  const code = assigned.data.coupon.code;
  assert.equal((await f.call('/api/admin/customers/u1/coupons', { as: 'admin', method: 'POST', body: { code: 'SAVE10' } })).status, 409);
  assert.equal((await f.call(`/api/admin/customers/u1/coupons/${code}/notify`, { as: 'admin', method: 'POST', body: {} })).status, 409);
  assert.equal((await f.call('/api/coupons/apply', { as: 'customer2', method: 'POST', body: { code } })).status, 400);
  assert.equal((await f.call(`/api/admin/customers/u1/coupons/${code}/revoke`, { as: 'admin', method: 'POST', body: {} })).data.coupon.status, 'Revoked');
  assert.equal((await f.call('/api/coupons/apply', { method: 'POST', body: { code } })).status, 400);
  f.docs.coupons[0].expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await f.call('/api/coupons/apply', { method: 'POST', body: { code: 'SAVE10' } })).status, 400);
  const created = await f.call('/api/admin/coupons', { as: 'admin', method: 'POST', body: { code: 'DELIVERY', discountType: 'free_delivery', discount: 0, minimum: 0, maximumDiscount: null } }); assert.equal(created.status, 201);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  const applied = await f.call('/api/coupons/apply', { method: 'POST', body: { code: 'DELIVERY' } });
  assert.equal(applied.data.cart.delivery, 0); assert.equal(applied.data.cart.freeDeliveryRemaining, 0);
  const order = await checkout(f, 'free-delivery-audit-001'); assert.equal(order.status, 201);
  assert.equal(order.data.order.deliveryArea.deliveryCharge, 0); assert.equal(order.data.order.deliveryArea.standardDeliveryCharge, 20);
});

test('Mongo mock audit: disabling areas preserves addresses and historical charges; ownership is enforced', async t => {
  const f = await fixture(t), placed = await f.order();
  assert.equal((await f.call('/api/addresses', { method: 'POST', body: { recipientName: 'Recipient', phone: '9444444001', line1: 'Street', city: 'Town' } })).status, 400);
  assert.equal((await f.call('/api/addresses/a2/default', { method: 'PATCH', body: {} })).status, 404);
  await f.call('/api/admin/delivery-areas/area1', { as: 'admin', method: 'PATCH', body: { isActive: false } });
  assert.equal((await f.call('/api/bootstrap')).data.activeAddress.deliveryAreaUnavailable, true);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  assert.equal((await checkout(f, 'disabled-area-audit-001')).status, 409);
  assert.equal((await f.call(`/api/orders/${placed.data.order.id}`)).data.order.delivery, 20);
  await f.call('/api/admin/delivery-areas/area1', { as: 'admin', method: 'DELETE', body: {} });
  assert.equal((await f.call('/api/addresses')).data.addresses.length, 1);
});

test('Mongo mock audit: callback replay and duplicate requests commit one order and one notification', async t => {
  const f = await fixture(t);
  await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
  f.retryNextTransaction();
  const attempts = await Promise.all([checkout(f, 'retry-audit-order-001'), checkout(f, 'retry-audit-order-001')]);
  assert.deepEqual(attempts.map(row => row.status).sort(), [200,201]);
  assert.equal(f.docs.orders.length, 1); assert.equal(f.docs.products[0].stock, 19); assert.equal(f.docs.notifications.length, 1); assert.equal(f.docs.notificationOutbox.length, 3);
});

test('Mongo mock audit: two customers cannot exceed a global coupon cap', async t => {
  const f = await fixture(t); f.docs.coupons[0].maxRedemptions = 1;
  for (const as of ['customer','customer2']) {
    await f.call('/api/cart/items', { as, method: 'POST', body: { productId: 'p1', delta: 1 } });
    assert.equal((await f.call('/api/coupons/apply', { as, method: 'POST', body: { code: 'SAVE10' } })).status, 200);
  }
  const responses = await Promise.all([checkout(f, 'coupon-race-audit-001'), checkout(f, 'coupon-race-audit-002', 'customer2')]);
  assert.deepEqual(responses.map(row => row.status).sort(), [201,409]);
  assert.equal(responses.find(row => row.status === 409).data.code, 'COUPON_INELIGIBLE');
  assert.equal(f.docs.coupons[0].redemptionCount, 1); assert.equal(f.docs.couponRedemptions.length, 1); assert.equal(f.docs.products[0].stock, 19);
});

test('Mongo mock audit: cancellation racing acceptance has one winner and no double restock', async t => {
  const f = await fixture(t), placed = await f.order(), id = placed.data.order.id; await ready(f, id);
  const attempts = await Promise.all([f.call(`/api/orders/${id}/cancel`, { method: 'POST', body: {} }), f.call(`/api/rider/orders/${id}/accept`, { as: 'rider', method: 'POST', body: {} })]);
  assert.deepEqual(attempts.map(row => row.status).sort(), [200,409]);
  assert.equal(f.docs.products[0].stock, f.docs.orders[0].status === 'Cancelled' ? 20 : 19);
});

test('Mongo mock audit: rider rejection, reassignment and cash reconciliation preserve history', async t => {
  const f = await fixture(t), placed = await f.order(), id = placed.data.order.id; await ready(f, id);
  assert.equal((await f.call(`/api/rider/orders/${id}/reject`, { as: 'rider', method: 'POST', body: {} })).status, 400);
  assert.equal((await f.call(`/api/rider/orders/${id}/reject`, { as: 'rider', method: 'POST', body: { reason: 'Unavailable' } })).status, 200);
  assert.equal((await f.call(`/api/rider/orders/${id}`, { as: 'rider' })).status, 404);
  assert.equal((await f.call(`/api/rider/orders/${id}/accept`, { as: 'rider', method: 'POST', body: {} })).status, 409);
  assert.equal((await f.call(`/api/admin/orders/${id}/assign`, { as: 'admin', method: 'POST', body: { riderId: 'r1' } })).status, 409);
  addRider(f, 'r2');
  assert.equal((await f.call(`/api/rider/orders/${id}/accept`, { as:'r2', method:'POST', body:{} })).status, 200);
  for (const action of ['out_for_delivery']) await f.call(`/api/rider/orders/${id}`, { as: 'r2', method: 'POST', body: { action } });
  await f.call(`/api/rider/orders/${id}/payment`, { as: 'r2', method: 'POST', body: { method: 'cash', confirmed: true, amount: f.docs.orders.find(o=>o.id===id).total } });
  const cancelled = await f.call(`/api/rider/orders/${id}/cancel`, { as: 'r2', method: 'POST', body: { reason: 'Unable to complete' } });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.order.inventoryReconciliationRequired, true); assert.equal(cancelled.data.order.paymentCollection.amount, 122); assert.equal(cancelled.data.order.paymentReconciliation.status, 'review_required'); assert.equal(f.docs.products[0].stock, 19);
});

for (const type of ['coupon', 'free_product']) test(`Mongo mock audit: ${type} referral issuance, repeated redemption, cancellation and qualifying-order reversal`, async t => {
  const f = await fixture(t);
  f.docs.settings.push({ key: 'referralCampaign', value: { enabled: true, minimumOrder: 1, firstOrderOnly: true, qualifyingStatus: 'Delivered', rewardType: type, rewardAmount: 15, freeProductId: 'p1', expiryDays: 30, redemptionLimit: 2, maxRewardsPerCustomer: 20 } });
  f.docs.referrals = [{ id: 'ref1', referrerUserId: 'u1', referredUserId: 'u2', status: 'pending' }];
  await f.call('/api/cart/items', { as: 'customer2', method: 'POST', body: { productId: 'p1', delta: 1 } });
  const source = await checkout(f, 'referral-source-audit-001', 'customer2'); await deliver(f, source.data.order.id);
  assert.equal(f.docs.rewards.length, 1); const rewardId = f.docs.rewards[0].id;
  for (let i = 0; i < 2; i++) {
    let response;
    if (type === 'coupon') {
      await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
      assert.equal((await f.call('/api/coupons/apply', { method: 'POST', body: { code: f.docs.rewards[0].couponCode } })).status, 200);
      response = await checkout(f, `referral-coupon-audit-00${i}`);
    } else response = await f.call(`/api/rewards/${rewardId}/redeem`, { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: `referral-product-audit-00${i}` } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal(f.docs.rewards[0].redemptionCount, i + 1); assert.equal(f.docs.rewards[0].status, i === 0 ? 'available' : 'redeemed');
  }
  const redemption = f.docs.rewards[0].orderId;
  assert.equal((await f.call(`/api/orders/${redemption}/cancel`, { method: 'POST', body: {} })).status, 200);
  assert.equal(f.docs.rewards[0].redemptionCount, 1); assert.equal(f.docs.rewards[0].status, 'available');
  assert.equal((await f.call(`/api/orders/${redemption}/cancel`, { method: 'POST', body: {} })).status, 409);
  const reversal = await f.call(`/api/admin/orders/${source.data.order.id}/status`, { as: 'admin', method: 'PATCH', body: { status: 'Cancelled', reason: 'Delivery correction' } });
  assert.equal(reversal.status, 200); assert.equal(f.docs.rewards[0].status, 'review_required');
  if (type === 'coupon') assert.equal(f.docs.coupons.find(row => row.code === f.docs.rewards[0].couponCode).isActive, false);
});

test('Mongo mock audit: guest isolation, invalid guest cookie repair, wishlist and coupon merge', async t => {
  const f = await fixture(t), guest = 'g'.repeat(40);
  const invalid = await f.call('/api/cart', { as: '', cookie: 'gid=bad' }); assert.match(invalid.cookie, /gid=[A-Za-z0-9_-]{32,}/);
  for (const [route, body] of [['/api/cart/items', { productId: 'p1', delta: 2 }], ['/api/wishlist/toggle', { productId: 'p1' }], ['/api/coupons/apply', { code: 'SAVE10' }], ['/api/delivery-area/select', { areaId: 'area1' }]]) assert.equal((await f.call(route, { as: '', cookie: `gid=${guest}`, method: 'POST', body })).status, 200);
  const login = await f.call('/api/auth/password/login', { as: '', cookie: `gid=${guest}`, method: 'POST', body: { phone: '9444444001', password } }); assert.equal(login.status, 200);
  assert.equal((await f.call('/api/cart')).data.count, 2); assert.equal((await f.call('/api/cart')).data.discount, 10);
  assert.deepEqual((await f.call('/api/wishlist')).data.items.map(row => row.id), ['p1']);
  assert.equal((await f.call('/api/cart', { as: '', cookie: `gid=${guest}` })).data.count, 0);
  assert.equal((await f.call('/api/cart', { as: 'customer2' })).data.count, 0);
});

test('Mongo mock audit: password rotation revokes sessions and passwordless records cannot be claimed', async t => {
  const f = await fixture(t), next = 'changed-test-password-phrase';
  assert.notEqual(await hashPassword(password), await hashPassword(password));
  assert.equal(await verifyPassword('incorrect', await hashPassword(password)), false);
  const change = await f.call('/api/auth/password/set', { method: 'POST', body: { currentPassword: password, newPassword: next, confirmPassword: next } });
  assert.equal(change.status, 200); assert.equal((await f.call('/api/auth/session')).status, 401);
  assert.equal((await f.call('/api/auth/session', { cookie: change.cookie.split(';')[0] })).status, 200);
  delete f.docs.users[1].passwordHash; const before = structuredClone(f.docs.users[1]);
  const result = await f.call('/api/auth/register', { as: '', method: 'POST', body: { phone: before.phone, name: 'Claim attempt', password, confirmPassword: password } });
  assert.equal(result.status, 400); assert.deepEqual(f.docs.users[1], before);
  assert.equal((await f.call('/api/auth/password/login', { as: '', method: 'POST', body: { phone: before.phone, password } })).status, 401);
});

test('Mongo mock audit: normalized phone throttling survives different number formatting', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 8; n++) assert.equal((await f.call('/api/auth/password/login', { as: '', method: 'POST', body: { phone: n % 2 ? '+91 94444 44001' : '9444444001', password: 'wrong-password' } })).status, 401);
  assert.equal((await f.call('/api/auth/password/login', { as: '', method: 'POST', body: { phone: '9444444001', password } })).status, 429);
  assert.ok(f.docs.authAttempts.every(row => /^[a-f0-9]{64}$/.test(row.id) && row.expiresAt instanceof Date));
});

test('Mongo mock audit: rider initial password, reset, deactivation and reactivation enforce sessions', async t => {
  const f = await fixture(t);
  const created = await f.call('/api/admin/riders', { as: 'admin', method: 'POST', body: { phone: '9333333002', name: 'New Rider', password } }); assert.equal(created.status, 201);
  const id = created.data.rider.id;
  const login = await f.call('/api/rider/auth/login', { as: '', method: 'POST', body: { phone: '9333333002', password } }); const cookie = login.cookie.split(';')[0];
  assert.equal((await f.call('/api/rider/bootstrap', { cookie })).data.needsPasswordChange, true);
  assert.equal((await f.call('/api/rider/status', { cookie, method: 'POST', body: { status: 'online' } })).status, 403);
  const changed = await f.call('/api/rider/auth/password', { cookie, method: 'POST', body: { newPassword: 'new-rider-password-phrase', confirmPassword: 'new-rider-password-phrase' } }); assert.equal(changed.status, 200);
  const newCookie = changed.cookie.split(';')[0]; assert.equal((await f.call('/api/rider/bootstrap', { newCookie, cookie: newCookie })).status, 200);
  const reset = await f.call(`/api/admin/riders/${id}/reset-password`, { as: 'admin', method: 'POST', body: {} }); assert.equal(reset.status, 200);
  assert.equal(JSON.stringify(f.docs).includes(reset.data.temporaryPassword), false);
  assert.equal((await f.call('/api/rider/bootstrap', { cookie: newCookie })).status, 401);
  for (const isActive of [false, true]) assert.equal((await f.call(`/api/admin/riders/${id}`, { as: 'admin', method: 'PATCH', body: { isActive } })).status, 200);
  assert.equal((await f.call('/api/rider/bootstrap', { cookie: newCookie })).status, 401);
});

test('Mongo mock audit: OAuth setup, state validation and public endpoints do not expose secrets or OTPs', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/auth/google/start', { as: '', method: 'POST', body: {}, headers: { origin: f.base } })).data.code, 'GOOGLE_AUTH_NOT_CONFIGURED');
  const configured = await fixture(t, {}, { env: { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'private-test-secret' } });
  const start = await configured.call('/api/auth/google/start', { as: '', method: 'POST', body: {}, headers: { origin: configured.base } });
  assert.equal(start.status, 200); assert.doesNotMatch(JSON.stringify(start.data), /private-test-secret/); assert.match(start.cookie, /HttpOnly/);
  const callback = await configured.call('/api/auth/google/callback', { as: '', cookie: start.cookie.split(';')[0], method: 'POST', headers: { origin: configured.base, 'x-requested-with': 'XMLHttpRequest' }, body: { code: 'no-external-exchange', state: 'incorrect' } }); assert.equal(callback.data.code, 'GOOGLE_STATE_INVALID');
  for (const prefix of ['/api', '/api/admin', '/api/rider']) assert.notEqual((await f.call(prefix + '/auth/request-otp', { as: '', method: 'POST', body: {} })).status, 200);
});

test('Mongo mock audit: production HTTP rejects cross-origin writes and preserves security headers', async t => {
  const f = await fixture(t, {}, { env: { NODE_ENV: 'production' } });
  assert.equal((await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 }, headers: { origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await f.call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 }, headers: { origin: f.base } })).status, 200);
  const response = await f.call('/'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.ok(response.headers.get('strict-transport-security'));
});
