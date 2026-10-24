import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
let tempDir, storePath, port, child, riderCookie, adminCookie, testAreaId;
const base = () => `http://127.0.0.1:${port}`;

async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
async function startServer() {
  port = await freePort();
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(port), STORE_PATH: storePath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    try { const response = await fetch(`${base()}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  child.kill(); throw new Error(`Test server did not start: ${output}`);
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]); child = null;
}
async function call(route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base()}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function signInCustomer(phone) {
  const challenge = await call('/api/auth/request-otp', { method: 'POST', body: { phone } }); assert.equal(challenge.status, 200);
  const verified = await call('/api/auth/verify-otp', { method: 'POST', body: { challengeId: challenge.data.challengeId, code: challenge.data.testCode } }); assert.equal(verified.status, 200);
  return verified.cookie;
}
async function signInRider(phone = '9000000000') {
  const challenge = await call('/api/rider/auth/request-otp', { method: 'POST', body: { phone } }); assert.equal(challenge.status, 200);
  const verified = await call('/api/rider/auth/verify-otp', { method: 'POST', body: { challengeId: challenge.data.challengeId, code: challenge.data.testCode } }); assert.equal(verified.status, 200);
  return verified.cookie;
}
async function signInAdmin() {
  const challenge = await call('/api/admin/auth/request-otp', { method: 'POST', body: { phone: '9000000001' } }); assert.equal(challenge.status, 200);
  const verified = await call('/api/admin/auth/verify-otp', { method: 'POST', body: { challengeId: challenge.data.challengeId, code: challenge.data.testCode } }); assert.equal(verified.status, 200);
  return verified.cookie;
}
async function makeOrder(phone, paymentMethod = 'cod') {
  const cookie = await signInCustomer(phone);
  const address = await call('/api/addresses', { method: 'POST', cookie, body: { label: 'Home', recipientName: 'Test customer', phone, line1: `${phone} Test Street`, line2: 'Test locality', landmark: 'Library', city: 'Test City', deliveryAreaId: testAreaId } }); assert.equal(address.status, 201, JSON.stringify(address.data));
  const added = await call('/api/cart/items', { method: 'POST', cookie, body: { productId: 'p101', delta: 1 } }); assert.equal(added.status, 200);
  const placed = await call('/api/orders', { method: 'POST', cookie, body: { addressId: address.data.address.id, paymentMethod } }); assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.match(placed.data.order.displayId, /^PM[0-9A-F]{24}$/);
  const stored = JSON.parse(await fs.readFile(storePath, 'utf8')); const ids = stored.orders.map(row => row.displayId); assert.equal(new Set(ids).size, ids.length, 'new display IDs never collide with existing order IDs');
  return { cookie, order: placed.data.order };
}
async function readyRider() {
  const result = await call('/api/rider/status', { method: 'POST', cookie: riderCookie, body: { status: 'online' } }); assert.equal(result.status, 200);
}
async function moveToOutForDelivery(orderId) {
  const accept = await call(`/api/rider/orders/${orderId}/accept`, { method: 'POST', cookie: riderCookie }); assert.equal(accept.status, 200, JSON.stringify(accept.data));
  for (const action of ['pickup', 'out_for_delivery']) {
    const moved = await call(`/api/rider/orders/${orderId}`, { method: 'POST', cookie: riderCookie, body: { action } }); assert.equal(moved.status, 200, JSON.stringify(moved.data));
  }
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zepto-rider-audit-')); storePath = path.join(tempDir, 'test-store.json');
  await startServer(); riderCookie = await signInRider(); adminCookie = await signInAdmin();
  const area = await call('/api/admin/delivery-areas', { method: 'POST', cookie: adminCookie, body: { name: 'Test Area', pinCodes: [], deliveryCharge: 25, minimumOrder: 0, freeDeliveryThreshold: 299, etaMinMinutes: 10, etaMaxMinutes: 20 } });
  assert.equal(area.status, 201, JSON.stringify(area.data)); testAreaId = area.data.area.id; await readyRider();
});
after(async () => { await stopServer(); if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); });


test('customer cancellation is owner-only, valid only before acceptance, and restores inventory once', async () => {
  const { cookie, order } = await makeOrder('9100000001');
  const stranger = await signInCustomer('9100000002');
  assert.equal((await call(`/api/orders/${order.id}/cancel`, { method: 'POST', cookie: stranger, body: {} })).status, 404);
  const cancelled = await call(`/api/orders/${order.id}/cancel`, { method: 'POST', cookie, body: {} });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.order.status, 'Cancelled'); assert.equal(cancelled.data.order.cancellation.actorType, 'customer');
  assert.ok(cancelled.data.order.inventoryRestockedAt);
  assert.equal((await call(`/api/orders/${order.id}/cancel`, { method: 'POST', cookie, body: {} })).status, 409);
  assert.equal((await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: riderCookie })).status, 409);
});

test('checkout idempotency key replays the original order without charging stock or creating another order', async () => {
  const cookie = await signInCustomer('9100000020');
  const address = await call('/api/addresses', { method: 'POST', cookie, body: { label: 'Home', recipientName: 'Idempotency Test', phone: '9100000020', line1: '1 Test Street', city: 'Test City', deliveryAreaId: testAreaId } });
  assert.equal(address.status, 201);
  assert.equal((await call('/api/cart/items', { method: 'POST', cookie, body: { productId: 'p101', delta: 1 } })).status, 200);
  const key = 'checkout-test-key-00000001';
  const body = { addressId: address.data.address.id, paymentMethod: 'cod', idempotencyKey: key };
  const first = await call('/api/orders', { method: 'POST', cookie, body });
  const second = await call('/api/orders', { method: 'POST', cookie, body });
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.equal(second.data.idempotentReplay, true); assert.equal(second.data.order.id, first.data.order.id);
  const stored = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(stored.orders.filter(row => row.userId === stored.sessions[decodeURIComponent(cookie.slice(4))]?.userId && row.idempotencyKey === key).length, 1);
  assert.equal(stored.products.find(row => row.id === 'p101').stock, 19);
});

test('customer cancellation and rider acceptance race has exactly one winner', async () => {
  const { cookie, order } = await makeOrder('9100000003');
  const [cancel, accept] = await Promise.all([
    call(`/api/orders/${order.id}/cancel`, { method: 'POST', cookie, body: {} }),
    call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: riderCookie })
  ]);
  assert.equal([cancel.status, accept.status].filter(status => status === 200).length, 1);
  assert.equal([cancel.status, accept.status].filter(status => status === 409).length, 1);
  const stored = JSON.parse(await fs.readFile(storePath, 'utf8')).orders.find(row => row.id === order.id);
  assert.ok(['Cancelled', 'Rider assigned'].includes(stored.status));
  assert.equal(stored.status === 'Cancelled', Boolean(stored.cancellation?.actorType === 'customer'));
  if (stored.status === 'Rider assigned') await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: riderCookie, body: { reason: 'End race test' } });
});

test('two simultaneous Rider accepts cannot claim the same available order twice', async () => {
  const { order } = await makeOrder('9100000092');
  const secondSession = await signInRider();
  const preview = await call(`/api/rider/orders/${order.id}`, { cookie: riderCookie });
  assert.equal(preview.status,200);assert.equal(preview.data.order.status,'Ready for pickup');
  const [first,second]=await Promise.all([
    call(`/api/rider/orders/${order.id}/accept`,{method:'POST',cookie:riderCookie}),
    call(`/api/rider/orders/${order.id}/accept`,{method:'POST',cookie:secondSession})
  ]);
  assert.deepEqual([first.status,second.status].sort(),[200,409]);
  assert.equal(JSON.parse(await fs.readFile(storePath,'utf8')).orders.find(row=>row.id===order.id).status,'Rider assigned');
});

test('rider rejection requires a reason, records history, and cannot be reaccepted by same rider', async () => {
  const { order } = await makeOrder('9100000004');
  assert.equal((await call(`/api/rider/orders/${order.id}/reject`, { method: 'POST', cookie: riderCookie, body: {} })).status, 400);
  const rejected = await call(`/api/rider/orders/${order.id}/reject`, { method: 'POST', cookie: riderCookie, body: { reason: 'Outside delivery route' } });
  assert.equal(rejected.status, 200); assert.equal(rejected.data.order.status, 'Ready for pickup');
  assert.equal((await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: riderCookie })).status, 409);
  const list = await call('/api/rider/orders', { cookie: riderCookie }); assert.equal(list.status, 200); assert.ok(!list.data.availableOrders.some(row => row.id === order.id));
});

test('another authorized rider can accept an order after its first rider rejects it', async () => {
  const created = await call('/api/admin/riders', { method: 'POST', cookie: adminCookie, body: { phone: '9000000012', name: 'Second Test Rider', vehicle: 'Bike', password: 'test-rider-initial-passphrase' } }); assert.equal(created.status, 201);
  const secondRider = await signInRider('9000000012');
  assert.equal((await call('/api/rider/status', { method: 'POST', cookie: secondRider, body: { status: 'online' } })).status, 200);
  const { order } = await makeOrder('9100000015');
  const rejected = await call(`/api/rider/orders/${order.id}/reject`, { method: 'POST', cookie: riderCookie, body: { reason: 'Route unavailable' } }); assert.equal(rejected.status, 200);
  const hiddenBeforeDesignation = await call('/api/rider/orders', { cookie: secondRider }); assert.ok(!hiddenBeforeDesignation.data.availableOrders.some(row => row.id === order.id));
  assert.equal((await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: secondRider })).status, 403);
  assert.equal((await call('/api/admin/dispatch-settings', { method: 'PATCH', body: { designatedRiderId: created.data.rider.id } })).status, 401);
  assert.equal((await call('/api/admin/dispatch-settings', { method: 'PATCH', cookie: adminCookie, body: { designatedRiderId: created.data.rider.id } })).status, 200);
  const available = await call('/api/rider/orders', { cookie: secondRider }); assert.ok(available.data.availableOrders.some(row => row.id === order.id));
  const privateBeforeDesignation = await call(`/api/rider/orders/${order.id}`, { cookie: riderCookie }); assert.equal(privateBeforeDesignation.status,404,'a rider rejected from the available inbox cannot retrieve its details');
  const readyDetails = await call(`/api/rider/orders/${order.id}`, { cookie: secondRider }); assert.equal(readyDetails.status,200); assert.equal(readyDetails.data.order.assignedToRiderId,null); assert.equal(readyDetails.data.order.displayId,order.displayId); assert.equal(readyDetails.data.order.customerContact.phone,order.address.phone); assert.equal(readyDetails.data.order.address.phone,order.address.phone); assert.equal(readyDetails.data.order.address.line1,order.address.line1); assert.equal(readyDetails.data.order.deliveryInstructions,'Library');assert.equal(readyDetails.data.order.items[0].quantity,1);assert.equal(readyDetails.data.order.total,order.total);assert.equal(readyDetails.data.order.paymentMethod,order.paymentMethod);
  const accepted = await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: secondRider }); assert.equal(accepted.status, 200); assert.equal(accepted.data.order.customerContact.phone,order.address.phone); assert.equal(accepted.data.order.address.line1,order.address.line1);
  assert.equal((await call(`/api/rider/orders/${order.id}`, { cookie: riderCookie })).status,404,'a rider who did not accept the delivery cannot view customer contact');
  const riderCancel = await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: secondRider, body: { reason: 'Test cleanup' } }); assert.equal(riderCancel.status, 200);
  assert.equal((await call('/api/admin/dispatch-settings', { method: 'PATCH', cookie: adminCookie, body: { designatedRiderId: 'demo-rider' } })).status, 200);
});

test('COD delivery requires one exact, rider-authenticated cash collection before completion', async () => {
  const { cookie, order } = await makeOrder('9100000005'); await moveToOutForDelivery(order.id);
  assert.equal((await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } })).status, 409);
  assert.equal((await call(`/api/rider/orders/${order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: false } })).status, 400);
  const collection = await call(`/api/rider/orders/${order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: true, amount: 1 } });
  assert.equal(collection.status, 200); assert.equal(collection.data.order.paymentCollection.amount, order.total);
  assert.equal((await call(`/api/rider/orders/${order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: true } })).status, 409);
  assert.equal((await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } })).status, 200);
  assert.equal((await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } })).status, 409);
  const customerView = await call(`/api/orders/${order.id}`, { cookie }); assert.equal(customerView.data.order.status, 'Delivered'); assert.equal(customerView.data.order.paymentStatus, 'Cash collected');
});

test('rider cancellation is valid at each assigned stage and preserves post-pickup reconciliation', async () => {
  const stages = ['Rider assigned', 'Picked up', 'Out for delivery'];
  for (let index = 0; index < stages.length; index++) {
    const { cookie, order } = await makeOrder(`910000000${6 + index}`);
    const accepted = await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: riderCookie }); assert.equal(accepted.status, 200);
    assert.equal((await call(`/api/orders/${order.id}/cancel`, { method: 'POST', cookie, body: {} })).status, 409);
    if (index > 0) { const picked = await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'pickup' } }); assert.equal(picked.status, 200); }
    if (index > 1) { const onway = await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'out_for_delivery' } }); assert.equal(onway.status, 200); }
    assert.equal((await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: riderCookie, body: {} })).status, 400);
    const cancelled = await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: riderCookie, body: { reason: 'Customer not reachable' } });
    assert.equal(cancelled.status, 200); assert.equal(cancelled.data.order.cancellation.previousStatus, stages[index]);
    assert.equal(Boolean(cancelled.data.order.inventoryReconciliationRequired), index > 0);
    const customer = await call(`/api/orders/${order.id}`, { cookie }); assert.equal(customer.data.order.status, 'Cancelled');
    const adminView = await call('/api/admin/bootstrap', { cookie: adminCookie });
    assert.equal(adminView.data.orders.find(row => row.id === order.id)?.cancellation?.actorType, 'rider');
    assert.equal((await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } })).status, 409);
  }
});

test('cancelling after rider cash collection flags reconciliation without erasing collection', async () => {
  const { order } = await makeOrder('9100000014'); await moveToOutForDelivery(order.id);
  const collected = await call(`/api/rider/orders/${order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: true } }); assert.equal(collected.status, 200);
  const cancelled = await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: riderCookie, body: { reason: 'Delivery could not be completed' } });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.order.paymentCollection.amount, order.total);
  assert.equal(cancelled.data.order.paymentReconciliation.status, 'review_required');
  assert.equal(cancelled.data.order.paymentStatus, 'Cash collection reconciliation required');
});

test('admin authorization and cancellation reasons are enforced on active accepted deliveries', async () => {
  const stages = ['Ready for pickup', 'Rider assigned', 'Picked up', 'Out for delivery'];
  for (let index = 0; index < stages.length; index++) {
    const { cookie, order } = await makeOrder(`910000001${index}`);
    if (index > 0) { const accepted = await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: riderCookie }); assert.equal(accepted.status, 200); }
    if (index > 1) { const picked = await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'pickup' } }); assert.equal(picked.status, 200); }
    if (index > 2) { const onway = await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'out_for_delivery' } }); assert.equal(onway.status, 200); }
    if (index === 0) {
      assert.equal((await call(`/api/admin/orders/${order.id}/status`, { method: 'PATCH', body: { status: 'Cancelled', reason: 'x' } })).status, 401);
      assert.equal((await call(`/api/admin/orders/${order.id}/status`, { method: 'PATCH', cookie: adminCookie, body: { status: 'Cancelled', reason: '' } })).status, 400);
    }
    const result = await call(`/api/admin/orders/${order.id}/status`, { method: 'PATCH', cookie: adminCookie, body: { status: 'Cancelled', reason: 'Store safety issue' } });
    assert.equal(result.status, 200); assert.equal(result.data.order.cancellation.actorType, 'admin'); assert.equal(result.data.order.cancellation.previousStatus, stages[index]);
    assert.equal((await call(`/api/orders/${order.id}`, { cookie })).data.order.status, 'Cancelled');
    if (index > 0) assert.equal((await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: riderCookie, body: { reason: 'duplicate' } })).status, 409);
  }
});

test('demo UPI stays labelled simulated; rider UPI collection is blocked without provider verification', async () => {
  const { order } = await makeOrder('9100000008', 'upi'); await moveToOutForDelivery(order.id);
  assert.equal(order.paymentStatus, 'Demo payment complete (simulated)');
  const paymentAttempt = await call(`/api/rider/orders/${order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'upi', confirmed: true } });
  assert.equal(paymentAttempt.status, 503); assert.equal(paymentAttempt.data.code, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
  const delivered = await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } });
  assert.equal(delivered.status, 200);
});

test('referral reward orders also receive collision-resistant display IDs', async () => {
  const referrerCookie = await signInCustomer('9100000030');
  const referrer = (await call('/api/referrals/me', { cookie: referrerCookie })).data;
  const campaign = await call('/api/admin/referrals/campaign', { method: 'PATCH', cookie: adminCookie, body: { enabled: true, minimumOrder: 1, firstOrderOnly: true, qualifyingStatus: 'Delivered', rewardType: 'free_product', rewardAmount: 50, freeProductId: 'p105', expiryDays: 30, redemptionLimit: 1, maxRewardsPerCustomer: 20, publicBaseUrl: 'https://purainamart.example' } }); assert.equal(campaign.status, 200);
  const challenge = await call('/api/auth/request-otp', { method: 'POST', body: { phone: '9100000031' } });
  const referredLogin = await call('/api/auth/verify-otp', { method: 'POST', body: { challengeId: challenge.data.challengeId, code: challenge.data.testCode, referralCode: referrer.referralCode } }); assert.equal(referredLogin.status, 200);
  const orderData = await makeOrder('9100000031'); await moveToOutForDelivery(orderData.order.id);
  const collected = await call(`/api/rider/orders/${orderData.order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: true } }); assert.equal(collected.status, 200);
  const delivered = await call(`/api/rider/orders/${orderData.order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } }); assert.equal(delivered.status, 200);
  const rewardData = (await call('/api/referrals/me', { cookie: referrerCookie })).data.rewards.find(row => row.status === 'available'); assert.ok(rewardData);
  const address = await call('/api/addresses', { method: 'POST', cookie: referrerCookie, body: { label: 'Home', recipientName: 'Referrer', phone: '9100000030', line1: 'Reward Test Road', city: 'Test City', deliveryAreaId: testAreaId } }); assert.equal(address.status, 201);
  const rewardOrder = await call(`/api/rewards/${rewardData.id}/redeem`, { method: 'POST', cookie: referrerCookie, body: { addressId: address.data.address.id, deliveryAreaId: testAreaId, paymentMethod: 'cod' } }); assert.equal(rewardOrder.status, 201, JSON.stringify(rewardOrder.data));
  const stored = JSON.parse(await fs.readFile(storePath, 'utf8')), ids = stored.orders.map(row => row.displayId);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(rewardOrder.data.order.displayId, /^PM[0-9A-F]{24}$/);
  await call('/api/admin/referrals/campaign', { method: 'PATCH', cookie: adminCookie, body: { enabled: false } });
});

test('active rider deliveries survive server restart and authenticated reload', async () => {
  const { order } = await makeOrder('9100000009');
  const accepted = await call(`/api/rider/orders/${order.id}/accept`, { method: 'POST', cookie: riderCookie }); assert.equal(accepted.status, 200);
  await stopServer(); await startServer();
  const bootstrap = await call('/api/rider/bootstrap', { cookie: riderCookie }); assert.equal(bootstrap.status, 200);
  assert.ok(bootstrap.data.assignedOrders.some(row => row.id === order.id && row.status === 'Rider assigned'));
  const cancelled = await call(`/api/rider/orders/${order.id}/cancel`, { method: 'POST', cookie: riderCookie, body: { reason: 'Recovery test cleanup' } }); assert.equal(cancelled.status, 200);
});

test('Rider and Admin summaries count completed COD deliveries without exposing estimate fields', async () => {
  const existing = await call('/api/rider/bootstrap',{cookie:riderCookie});
  const { order } = await makeOrder('9100000091');
  await moveToOutForDelivery(order.id);
  const collected = await call(`/api/rider/orders/${order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: true } }); assert.equal(collected.status,200);
  const delivered = await call(`/api/rider/orders/${order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } }); assert.equal(delivered.status,200);
  const month=delivered.data.order.deliveredAt.slice(0,7);
  const day=delivered.data.order.deliveredAt.slice(0,10);
  assert.equal((await call('/api/rider/bootstrap?month=2026-13',{cookie:riderCookie})).status,400);
  assert.equal((await call(`/api/rider/bootstrap?date=${new Date(Date.now()+86400000).toISOString().slice(0,10)}`,{cookie:riderCookie})).status,400,'future delivery history dates are rejected');
  const riderSummary=await call(`/api/rider/bootstrap?month=${month}&date=${day}`,{cookie:riderCookie});assert.equal(riderSummary.status,200);
  assert.equal(riderSummary.data.deliverySummary.monthCompletedDeliveries,existing.data.deliverySummary.monthCompletedDeliveries+1);assert.equal(riderSummary.data.deliverySummary.monthCodCollected,existing.data.deliverySummary.monthCodCollected+order.total);
  assert.equal(riderSummary.data.deliverySummary.dailyCompletedDeliveries,existing.data.deliverySummary.dailyCompletedDeliveries+1);assert.equal(riderSummary.data.deliverySummary.dailyCodCollected,existing.data.deliverySummary.dailyCodCollected+order.total);
  assert.equal('earnings' in riderSummary.data,false);assert.equal('estimatedEarning' in riderSummary.data.deliveredOrders.find(row=>row.id===order.id),false);
  assert.equal((await call(`/api/admin/rider-delivery-summaries?month=${month}`)).status,401);
  const adminSummary=await call(`/api/admin/rider-delivery-summaries?month=${month}&date=${day}`,{cookie:adminCookie});assert.equal(adminSummary.status,200);
  const rider=adminSummary.data.riders.find(row=>row.id==='demo-rider');assert.equal(rider.deliverySummary.monthCompletedDeliveries,existing.data.deliverySummary.monthCompletedDeliveries+1);assert.equal(rider.deliverySummary.monthCodCollected,existing.data.deliverySummary.monthCodCollected+order.total);assert.equal(rider.deliverySummary.dailyCompletedDeliveries,existing.data.deliverySummary.dailyCompletedDeliveries+1);assert.equal(rider.deliverySummary.dailyCodCollected,existing.data.deliverySummary.dailyCodCollected+order.total);
});
