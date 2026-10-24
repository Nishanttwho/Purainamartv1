import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
let tempDir, storePath, port, child, adminCookie, customerCookie, historicOrderId;
const base = () => `http://127.0.0.1:${port}`;
async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
async function startServer() {
  port = await freePort();
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(port), STORE_PATH: storePath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    try { if ((await fetch(`${base()}/api/health`)).ok) return; } catch {}
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
async function signIn(routePrefix, phone, cookie) {
  const started = await call(`${routePrefix}/auth/request-otp`, { method: 'POST', cookie, body: { phone } }); assert.equal(started.status, 200, JSON.stringify(started.data));
  const verified = await call(`${routePrefix}/auth/verify-otp`, { method: 'POST', cookie, body: { challengeId: started.data.challengeId, code: started.data.testCode } }); assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.cookie;
}
async function adminArea(name, overrides = {}) {
  return call('/api/admin/delivery-areas', { method: 'POST', cookie: adminCookie, body: { name, pinCodes: [], deliveryCharge: 33, minimumOrder: 300, freeDeliveryThreshold: 500, etaMinMinutes: 15, etaMaxMinutes: 25, ...overrides } });
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zepto-area-address-')); storePath = path.join(tempDir, 'isolated-store.json');
  await startServer();
  adminCookie = await signIn('/api/admin', '9000000001');
  customerCookie = await signIn('/api', '9110000001');
});
after(async () => { await stopServer(); if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); });

test('active area IDs govern address eligibility, order quotes, and preserve historical records', async () => {
  const emptyBootstrap = await call('/api/bootstrap', { cookie: customerCookie });
  assert.deepEqual(emptyBootstrap.data.deliveryAreas, [], 'fresh store has no wildcard delivery area');
  const deniedAdmin = await call('/api/admin/delivery-areas', { method: 'POST', cookie: customerCookie, body: { name: 'Forbidden', deliveryCharge: 0, minimumOrder: 0, etaMinMinutes: 5, etaMaxMinutes: 10 } });
  assert.equal(deniedAdmin.status, 401, 'customer cannot manage areas');

  const first = await adminArea('Puraina'); assert.equal(first.status, 201, JSON.stringify(first.data));
  const second = await adminArea('Deoria', { deliveryCharge: 45 }); assert.equal(second.status, 201, JSON.stringify(second.data));
  const areaId = first.data.area.id, secondId = second.data.area.id;
  assert.deepEqual((await call('/api/delivery-areas')).data.areas.map(area => area.id).sort(), [areaId, secondId].sort());
  assert.equal((await call('/api/addresses', { method: 'POST', cookie: customerCookie, body: { line1: 'House 12', city: 'City', recipientName: 'Test Customer', phone: '9110000001' } })).status, 400, 'area selection is mandatory');
  assert.equal((await call('/api/addresses', { method: 'POST', cookie: customerCookie, body: { line1: 'House 12', city: 'City', recipientName: 'Test Customer', phone: '9110000001', deliveryAreaId: 'made-up-area' } })).status, 409, 'unknown area ID is rejected');

  const saved = await call('/api/addresses', { method: 'POST', cookie: customerCookie, body: { label: 'Home', recipientName: 'Test Customer', phone: '9110000001', line1: 'House 12', line2: 'Market Road', landmark: 'Library', city: 'Test City', deliveryAreaId: areaId, pincode: 'not-used' } });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const address = saved.data.address;
  assert.equal(address.deliveryAreaName, 'Puraina'); assert.equal(address.recipientName, 'Test Customer'); assert.equal(address.phone, '9110000001');
  assert.equal(address.line1, 'House 12'); assert.equal(address.line2, 'Market Road'); assert.equal(address.landmark, 'Library'); assert.equal(address.pincode, undefined, 'new records do not store submitted PIN values');
  const disabledAddress = await call('/api/addresses', { method: 'POST', cookie: customerCookie, body: { recipientName: 'Test Customer', phone: '9110000001', line1: 'House 13', city: 'Test City', deliveryAreaId: secondId } });
  assert.equal(disabledAddress.status, 201);
  await call(`/api/admin/delivery-areas/${encodeURIComponent(secondId)}`, { method: 'PATCH', cookie: adminCookie, body: { isActive: false } });
  assert.deepEqual((await call('/api/delivery-areas')).data.areas.map(area => area.id), [areaId]);
  await call(`/api/admin/delivery-areas/${encodeURIComponent(secondId)}`, { method: 'PATCH', cookie: adminCookie, body: { isActive: true } });
  assert.equal((await call('/api/delivery-areas')).data.areas.length, 2, 'admin re-enabling an area makes it selectable immediately');
  await call(`/api/admin/delivery-areas/${encodeURIComponent(secondId)}`, { method: 'PATCH', cookie: adminCookie, body: { isActive: false } });
  const newlyDisabledSave = await call('/api/addresses', { method: 'POST', cookie: customerCookie, body: { recipientName: 'Test Customer', phone: '9110000001', line1: 'House 14', city: 'Test City', deliveryAreaId: secondId } });
  assert.equal(newlyDisabledSave.status, 409, 'disabled area is rejected when saving');
  await call(`/api/addresses/${encodeURIComponent(address.id)}/default`, { method: 'PATCH', cookie: customerCookie });

  await call('/api/cart/items', { method: 'POST', cookie: customerCookie, body: { productId: 'p101', delta: 1 } });
  const belowMinimum = await call('/api/cart', { cookie: customerCookie }); assert.equal(belowMinimum.data.minimumOrderMet, false); assert.equal(belowMinimum.data.minimumOrder, 300);
  assert.equal((await call('/api/orders', { method: 'POST', cookie: customerCookie, body: { addressId: address.id, deliveryAreaId: areaId, paymentMethod: 'cod' } })).status, 409, 'minimum order is enforced server-side');
  await call('/api/cart/items', { method: 'POST', cookie: customerCookie, body: { productId: 'p101', delta: 3 } });
  await call('/api/coupons/apply', { method: 'POST', cookie: customerCookie, body: { code: 'DEMO50' } });
  const quoted = await call('/api/cart', { cookie: customerCookie });
  assert.equal(quoted.data.deliveryArea.id, areaId); assert.equal(quoted.data.delivery, 33); assert.equal(quoted.data.discount, 50); assert.equal(quoted.data.total, 301);
  const tamperedArea = await call('/api/orders', { method: 'POST', cookie: customerCookie, body: { addressId: address.id, deliveryAreaId: 'invalid-area', paymentMethod: 'cod' } });
  assert.equal(tamperedArea.status, 409, 'checkout rejects a submitted area that does not match the saved area ID');
  const placed = await call('/api/orders', { method: 'POST', cookie: customerCookie, body: { addressId: address.id, deliveryAreaId: areaId, deliveryCharge: 0, total: 0, paymentMethod: 'cod' } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const historic = placed.data.order; historicOrderId = historic.id; assert.equal(historic.delivery, 33); assert.equal(historic.discount, 50); assert.equal(historic.total, 301); assert.equal(historic.deliveryArea.id, areaId);

  await call(`/api/admin/delivery-areas/${encodeURIComponent(areaId)}`, { method: 'PATCH', cookie: adminCookie, body: { deliveryCharge: 40, freeDeliveryThreshold: 300 } });
  await call('/api/cart/items', { method: 'POST', cookie: customerCookie, body: { productId: 'p101', delta: 4 } });
  await call('/api/coupons/apply', { method: 'POST', cookie: customerCookie, body: { code: 'DEMO50' } });
  const repriced = await call('/api/cart', { cookie: customerCookie }); assert.equal(repriced.data.delivery, 0); assert.equal(repriced.data.freeDeliveryUnlocked, true); assert.equal(repriced.data.total, 268);
  await call(`/api/admin/delivery-areas/${encodeURIComponent(areaId)}`, { method: 'PATCH', cookie: adminCookie, body: { freeDeliveryThreshold: 600 } });
  const belowFreeThreshold = await call('/api/cart', { cookie: customerCookie }); assert.equal(belowFreeThreshold.data.delivery, 40); assert.equal(belowFreeThreshold.data.freeDeliveryUnlocked, false); assert.equal(belowFreeThreshold.data.total, 308);
  assert.equal((await call(`/api/orders/${historic.id}`, { cookie: customerCookie })).data.order.total, 301, 'old order amount remains a snapshot');

  await call(`/api/admin/delivery-areas/${encodeURIComponent(areaId)}`, { method: 'PATCH', cookie: adminCookie, body: { isActive: false } });
  const stale = await call('/api/bootstrap', { cookie: customerCookie });
  assert.equal(stale.data.activeAddress.deliveryAreaUnavailable, true); assert.equal(stale.data.addresses.length, 2, 'old addresses remain saved');
  assert.equal((await call('/api/orders', { method: 'POST', cookie: customerCookie, body: { addressId: address.id, deliveryAreaId: areaId, paymentMethod: 'cod' } })).status, 409, 'disabled area cannot be used for orders');

  const replacement = await adminArea('New active area', { deliveryCharge: 11, minimumOrder: 0, freeDeliveryThreshold: null }); assert.equal(replacement.status, 201);
  const recovered = await call('/api/delivery-area/select', { method: 'POST', cookie: customerCookie, body: { areaId: replacement.data.area.id, addressId: address.id } });
  assert.equal(recovered.status, 409, 'cart cannot independently reassign the area on an existing address');
  const afterRejectedAreaChange = await call('/api/bootstrap', { cookie: customerCookie }); assert.equal(afterRejectedAreaChange.data.activeAddress.deliveryAreaUnavailable, true, 'the saved address area is left unchanged');
  const replacementAddress = await call('/api/addresses', { method: 'POST', cookie: customerCookie, body: { label: 'Work', recipientName: 'Test Customer', phone: '9110000001', line1: 'New House', city: 'Test City', deliveryAreaId: replacement.data.area.id } });
  assert.equal(replacementAddress.status, 201); assert.equal(replacementAddress.data.address.deliveryAreaName, 'New active area');
  await call(`/api/addresses/${encodeURIComponent(replacementAddress.data.address.id)}/default`, { method: 'PATCH', cookie: customerCookie });
  const afterRecovery = await call('/api/bootstrap', { cookie: customerCookie }); assert.equal(afterRecovery.data.activeAddress.deliveryAreaName, 'New active area');
  const deleted = await call(`/api/admin/delivery-areas/${encodeURIComponent(replacement.data.area.id)}`, { method: 'DELETE', cookie: adminCookie }); assert.equal(deleted.status, 200);
  assert.equal((await call('/api/addresses', { cookie: customerCookie })).data.addresses.length, 3, 'area deletion does not delete saved addresses');

  const legacyStore = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const oldFallback = legacyStore.deliveryAreas.find(area => area.id === areaId);
  oldFallback.isDemoFallback = true; oldFallback.isActive = true;
  await fs.writeFile(storePath, JSON.stringify(legacyStore, null, 2));
  await stopServer(); await startServer();
  const afterMigration = await call('/api/bootstrap', { cookie: customerCookie });
  assert.equal(afterMigration.status, 200); assert.equal(afterMigration.data.deliveryAreas.some(area => area.id === areaId), false, 'legacy wildcard demo area is deactivated on migration');
  assert.equal(afterMigration.data.addresses.length, 3, 'migration preserves saved customer addresses');
  const preservedOrder = await call(`/api/orders/${historicOrderId}`, { cookie: customerCookie });
  assert.equal(preservedOrder.status, 200); assert.equal(preservedOrder.data.order.total, 301, 'migration preserves historical order snapshots');
});
