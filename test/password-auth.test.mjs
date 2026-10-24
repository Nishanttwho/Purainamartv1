import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { hashPassword, verifyPassword } from '../lib/password.mjs';

const root = path.resolve(import.meta.dirname, '..');
let tempDir, storePath, port, child, adminCookie, areaId, registeredUserId, initialOrderId;
const base = () => `http://127.0.0.1:${port}`;

async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
async function startServer(extraEnv = {}) {
  port = await freePort();
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'development', APP_TEST_AUTH: '', PORT: String(port), STORE_PATH: storePath, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 15000;
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
async function call(route, { method = 'GET', body, cookie, origin = false } = {}) {
  const response = await fetch(`${base()}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(origin ? { origin: base() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie'), csp: response.headers.get('content-security-policy'), hsts: response.headers.get('strict-transport-security') };
}
const validPassword = 'maple-river-cloud-77';
async function adminLogin() {
  const response = await call('/api/admin/auth/login', { method: 'POST', body: { phone: '9990000001', password: 'admin-super-secret-phrase' } });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.cookie;
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zepto-password-auth-'));
  storePath = path.join(tempDir, 'isolated-store.json');
  const adminHash = await hashPassword('admin-super-secret-phrase');
  await startServer({ ADMIN_PHONE: '9990000001', ADMIN_NAME: 'Test Admin', ADMIN_PASSWORD_HASH: adminHash });
  adminCookie = await adminLogin();
  const area = await call('/api/admin/delivery-areas', { method: 'POST', cookie: adminCookie, body: { name: 'Auth Test Area', pinCodes: [], deliveryCharge: 19, minimumOrder: 0, freeDeliveryThreshold: null, etaMinMinutes: 12, etaMaxMinutes: 20 } });
  assert.equal(area.status, 201); areaId = area.data.area.id;
});

after(async () => { await stopServer(); if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); });

test('Argon2id hashes use per-password salt and reject incorrect password', async () => {
  const first = await hashPassword(validPassword), second = await hashPassword(validPassword);
  assert.match(first, /^argon2id\$65536\$3\$1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(validPassword, first), true);
  assert.equal(await verifyPassword('incorrect-password', first), false);
});

test('customer registration, password login, password update, and account data remain linked', async () => {
  const registered = await call('/api/auth/register', { method: 'POST', body: { phone: '9444444001', name: 'Password Customer', password: validPassword, confirmPassword: validPassword } });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  assert.ok(registered.cookie);
  assert.equal(JSON.stringify(registered.data).includes('passwordHash'), false);
  registeredUserId = registered.data.user.id;
  const state = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const savedUser = state.users.find(user => user.id === registeredUserId);
  assert.match(savedUser.passwordHash, /^argon2id\$/);
  assert.equal(JSON.stringify(savedUser).includes(validPassword), false);

  const wrong = await call('/api/auth/password/login', { method: 'POST', body: { phone: '9444444001', password: 'wrong-password-123' } });
  const noAccount = await call('/api/auth/password/login', { method: 'POST', body: { phone: '9444444002', password: 'wrong-password-123' } });
  assert.equal(wrong.status, 401); assert.equal(noAccount.status, 401); assert.equal(wrong.data.error, noAccount.data.error);
  const login = await call('/api/auth/password/login', { method: 'POST', body: { phone: '9444444001', password: validPassword } });
  assert.equal(login.status, 200); assert.equal(login.data.user.id, registeredUserId); assert.match(login.setCookie, /HttpOnly/i); assert.match(login.setCookie, /SameSite=Lax/i);

  const invalidRegistration = await call('/api/auth/register', { method: 'POST', body: { phone: '9444444003', name: 'A', password: 'short', confirmPassword: 'short' } });
  assert.equal(invalidRegistration.status, 400);
  const malformedPhone = await call('/api/auth/register', { method: 'POST', body: { phone: '12345678901234', name: 'Malformed Phone', password: validPassword, confirmPassword: validPassword } });
  assert.equal(malformedPhone.status, 400, 'arbitrary long strings must not be truncated into a valid phone');
  const duplicate = await call('/api/auth/register', { method: 'POST', body: { phone: '9444444001', name: 'Other Name', password: validPassword, confirmPassword: validPassword } });
  assert.equal(duplicate.status, 400); assert.equal(duplicate.data.error, invalidRegistration.data.error);

  const address = await call('/api/addresses', { method: 'POST', cookie: registered.cookie, body: { label: 'Home', recipientName: 'Password Customer', phone: '9444444001', line1: '12 Safe Lane', city: 'Test City', deliveryAreaId: areaId } });
  assert.equal(address.status, 201);
  assert.equal((await call('/api/products?q=avocado')).data.products[0].id, 'p101');
  await call('/api/cart/items', { method: 'POST', cookie: registered.cookie, body: { productId: 'p101', delta: 4 } });
  const appliedCoupon = await call('/api/coupons/apply', { method: 'POST', cookie: registered.cookie, body: { code: 'DEMO50' } });
  assert.equal(appliedCoupon.status, 200); assert.equal(appliedCoupon.data.cart.discount, 50);
  assert.equal(appliedCoupon.data.cart.total, appliedCoupon.data.cart.subtotal - appliedCoupon.data.cart.discount + appliedCoupon.data.cart.delivery + appliedCoupon.data.cart.platform);
  await call('/api/wishlist/toggle', { method: 'POST', cookie: registered.cookie, body: { productId: 'p102' } });
  const placed = await call('/api/orders', { method: 'POST', cookie: registered.cookie, body: { addressId: address.data.address.id, paymentMethod: 'cod' } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data)); initialOrderId = placed.data.order.id;
  assert.equal(placed.data.order.discount, 50); assert.equal(placed.data.order.couponCode, 'DEMO50');
  assert.equal(placed.data.order.total, placed.data.order.subtotal - placed.data.order.discount + placed.data.order.delivery + placed.data.order.platform);

  const badChange = await call('/api/auth/password/set', { method: 'POST', cookie: registered.cookie, body: { currentPassword: 'wrong-password-123', newPassword: 'new-maple-river-password', confirmPassword: 'new-maple-river-password' } });
  assert.equal(badChange.status, 401);
  const changed = await call('/api/auth/password/set', { method: 'POST', cookie: registered.cookie, body: { currentPassword: validPassword, newPassword: 'new-maple-river-password', confirmPassword: 'new-maple-river-password' } });
  assert.equal(changed.status, 200);
  const logout = await call('/api/auth/logout', { method: 'POST', cookie: registered.cookie }); assert.equal(logout.status, 200);
  assert.equal((await call('/api/orders', { cookie: registered.cookie })).status, 401);
  const updatedLogin = await call('/api/auth/password/login', { method: 'POST', body: { phone: '9444444001', password: 'new-maple-river-password' } });
  assert.equal(updatedLogin.status, 200); assert.equal(updatedLogin.data.user.id, registeredUserId);
  assert.equal((await call('/api/orders', { cookie: updatedLogin.cookie })).data.orders[0].id, initialOrderId);
  assert.deepEqual((await call('/api/wishlist', { cookie: updatedLogin.cookie })).data.items.map(item => item.id), ['p102']);
  assert.equal((await call('/api/bootstrap', { cookie: updatedLogin.cookie })).data.addresses[0].line1, '12 Safe Lane');

  await stopServer();
  const expiredStore = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const expiredSid = decodeURIComponent(updatedLogin.cookie.split('=')[1]);
  expiredStore.sessions[expiredSid].expiresAt = Date.now() - 1;
  await fs.writeFile(storePath, JSON.stringify(expiredStore, null, 2));
  await startServer({ ADMIN_PHONE: '9990000001', ADMIN_NAME: 'Test Admin', ADMIN_PASSWORD_HASH: await hashPassword('admin-super-secret-phrase') });
  assert.equal((await call('/api/orders', { cookie: updatedLogin.cookie })).status, 401, 'expired sessions must no longer authenticate after a restart');
  const persistedAfterExpiry = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.ok(persistedAfterExpiry.orders.some(order => order.id === initialOrderId), 'session expiry must not affect the customer order');
});

test('customer authentication has bounded failed-attempt rate limit', async () => {
  for (let i = 0; i < 8; i++) {
    const attempt = await call('/api/auth/password/login', { method: 'POST', body: { phone: '9444444099', password: 'incorrect-password-123' } });
    assert.equal(attempt.status, 401);
  }
  const limited = await call('/api/auth/password/login', { method: 'POST', body: { phone: '9444444099', password: validPassword } });
  assert.equal(limited.status, 429);
});

test('Admin-created Rider must change initial/reset credentials and cannot use another session', async () => {
  const denied = await call('/api/admin/bootstrap'); assert.equal(denied.status, 401);
  const badAdmin = await call('/api/admin/auth/login', { method: 'POST', body: { phone: '9990000001', password: 'bad-admin-password' } }); assert.equal(badAdmin.status, 401);
  const created = await call('/api/admin/riders', { method: 'POST', cookie: adminCookie, body: { phone: '9444444010', name: 'Secure Rider', vehicle: 'Bike', password: 'rider-initial-secure-pass' } });
  assert.equal(created.status, 201, JSON.stringify(created.data)); assert.equal(created.data.rider.mustChangePassword, true); assert.equal('passwordHash' in created.data.rider, false);
  const riderLogin = await call('/api/rider/auth/login', { method: 'POST', body: { phone: '9444444010', password: 'rider-initial-secure-pass' } });
  assert.equal(riderLogin.status, 200); assert.match(riderLogin.setCookie, /HttpOnly/i);
  assert.equal((await call('/api/rider/bootstrap', { cookie: riderLogin.cookie })).data.needsPasswordChange, true);
  assert.equal((await call('/api/rider/status', { method: 'POST', cookie: riderLogin.cookie, body: { status: 'online' } })).status, 403);
  const changed = await call('/api/rider/auth/password', { method: 'POST', cookie: riderLogin.cookie, body: { newPassword: 'rider-updated-secure-passphrase', confirmPassword: 'rider-updated-secure-passphrase' } });
  assert.equal(changed.status, 200); assert.equal((await call('/api/rider/bootstrap', { cookie: riderLogin.cookie })).status, 200);
  assert.equal((await call('/api/admin/bootstrap', { cookie: riderLogin.cookie })).status, 401);

  const reset = await call(`/api/admin/riders/${created.data.rider.id}/reset-password`, { method: 'POST', cookie: adminCookie, body: {} });
  assert.equal(reset.status, 200); assert.ok(reset.data.temporaryPassword); assert.equal((await call('/api/rider/bootstrap', { cookie: riderLogin.cookie })).status, 401);
  const tempLogin = await call('/api/rider/auth/login', { method: 'POST', body: { phone: '9444444010', password: reset.data.temporaryPassword } });
  assert.equal(tempLogin.status, 200); assert.equal(tempLogin.data.rider.mustChangePassword, true);
  const tempText = JSON.stringify(JSON.parse(await fs.readFile(storePath, 'utf8')));
  assert.equal(tempText.includes(reset.data.temporaryPassword), false);
  const finalPassword = 'rider-final-safe-password';
  assert.equal((await call('/api/rider/auth/password', { method: 'POST', cookie: tempLogin.cookie, body: { newPassword: finalPassword, confirmPassword: finalPassword } })).status, 200);
  await call('/api/rider/auth/logout', { method: 'POST', cookie: tempLogin.cookie });
  assert.equal((await call('/api/rider/bootstrap', { cookie: tempLogin.cookie })).status, 401);
  const finalLogin = await call('/api/rider/auth/login', { method: 'POST', body: { phone: '9444444010', password: finalPassword } });
  assert.equal(finalLogin.status, 200);
  assert.equal((await call('/api/admin/dispatch-settings', { method: 'PATCH', cookie: adminCookie, body: { designatedRiderId: created.data.rider.id } })).status, 200);
  assert.equal((await call(`/api/admin/riders/${created.data.rider.id}`, { method: 'PATCH', cookie: adminCookie, body: { isActive: false } })).status, 200);
  assert.equal((await call('/api/rider/bootstrap', { cookie: finalLogin.cookie })).status, 401, 'deactivation revokes existing Rider session');
  assert.equal((await call('/api/admin/bootstrap', { cookie: adminCookie })).data.dispatchSettings.designatedRiderId, null);
  assert.equal((await call(`/api/admin/riders/${created.data.rider.id}`, { method: 'PATCH', cookie: adminCookie, body: { isActive: true } })).status, 200);
  assert.equal((await call('/api/rider/bootstrap', { cookie: finalLogin.cookie })).status, 401, 'reactivation does not revive a revoked Rider session');
  const reactivated = await call('/api/rider/auth/login', { method: 'POST', body: { phone: '9444444010', password: finalPassword } }); assert.equal(reactivated.status, 200);
  assert.equal((await call(`/api/admin/riders/${created.data.rider.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);
  assert.equal((await call('/api/rider/bootstrap', { cookie: reactivated.cookie })).status, 401, 'deletion revokes Rider sessions');
});

test('no public endpoint exposes old OTPs, rider demo phone, or Admin credentials', async () => {
  const adminConfig = await call('/api/admin/config');
  assert.equal(adminConfig.status, 401, 'Admin configuration status is private');
  assert.deepEqual((await call('/api/admin/config', { cookie: adminCookie })).data, { configured: true });
  const customerOtp = await call('/api/auth/request-otp', { method: 'POST', body: { phone: '9000000000' } });
  assert.notEqual(customerOtp.status, 200); assert.equal('demoCode' in customerOtp.data, false);
  const riderConfig = await call('/api/rider/config'); assert.equal(riderConfig.status, 404);
  assert.equal((await call('/api/rider/bootstrap')).status, 401);
  const storeText = JSON.stringify(JSON.parse(await fs.readFile(storePath, 'utf8')));
  assert.equal(storeText.includes('rider-initial-secure-pass'), false);
  assert.equal(storeText.includes('admin-super-secret-phrase'), false);
});

test('legacy passwordless customer records stay intact and cannot be claimed by phone-only registration', async () => {
  await stopServer();
  const data = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const legacy = { id: 'legacy-preserve-id', phone: '9444444020', name: 'Legacy Account', referralCode: 'KEEP123', createdAt: '2023-04-05T00:00:00.000Z' };
  data.users.push(legacy);
  data.addresses[legacy.id] = [{ id: 'legacy-address', label: 'Home', recipientName: legacy.name, phone: legacy.phone, line1: 'Existing address', city: 'Preserve City', deliveryAreaId: areaId }];
  data.carts[legacy.id] = { p101: 2 };
  data.wishlists[legacy.id] = ['p102'];
  data.orders.push({ id: 'legacy-order', displayId: 'ZP00000001', userId: legacy.id, items: [], subtotal: 0, discount: 0, delivery: 0, total: 0, status: 'Delivered', createdAt: '2023-04-05T00:00:00.000Z' });
  data.referrals.push({ id: 'legacy-referral', referrerUserId: legacy.id, referredUserId: 'preserved-other', status: 'pending' });
  data.rewards.push({ id: 'legacy-reward', userId: legacy.id, status: 'available' });
  await fs.writeFile(storePath, JSON.stringify(data, null, 2));
  await startServer({ ADMIN_PHONE: '9990000001', ADMIN_NAME: 'Test Admin', ADMIN_PASSWORD_HASH: await hashPassword('admin-super-secret-phrase') });
  const login = await call('/api/auth/password/login', { method: 'POST', body: { phone: legacy.phone, password: validPassword } }); assert.equal(login.status, 401);
  const claim = await call('/api/auth/register', { method: 'POST', body: { phone: legacy.phone, name: 'Attacker', password: validPassword, confirmPassword: validPassword } }); assert.equal(claim.status, 400);
  assert.equal((await call('/api/auth/password/set', { method: 'POST', body: { newPassword: validPassword, confirmPassword: validPassword } })).status, 401);
  const afterStore = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.deepEqual(afterStore.users.find(user => user.id === legacy.id), legacy);
  assert.deepEqual(afterStore.addresses[legacy.id], data.addresses[legacy.id]);
  assert.deepEqual(afterStore.carts[legacy.id], { p101: 2 }); assert.deepEqual(afterStore.wishlists[legacy.id], ['p102']);
  assert.ok(afterStore.orders.some(order => order.id === 'legacy-order'));
  assert.ok(afterStore.referrals.some(row => row.id === 'legacy-referral')); assert.ok(afterStore.rewards.some(row => row.id === 'legacy-reward'));
});

test('production requires a configured PostgreSQL DATABASE_URL before serving', async () => {
  await stopServer();
  const productionAdminHash = await hashPassword('prod-admin-security-phrase');
  await assert.rejects(() => startServer({ NODE_ENV: 'production', ADMIN_PHONE: '9880000001', ADMIN_PASSWORD_HASH: productionAdminHash }), /Production requires DATABASE_URL/);
});

test('production starts without fixture catalog, rejects cross-origin mutations and never completes simulated UPI', { skip: !process.env.DATABASE_URL }, async () => {
  await stopServer();
  storePath = path.join(tempDir, 'production-store.json');
  const productionAdminPassword = 'prod-admin-security-phrase';
  const productionAdminHash = await hashPassword(productionAdminPassword);
  const productionConfig = { NODE_ENV: 'production', HOST: '127.0.0.1', ADMIN_PHONE: '9880000001', ADMIN_NAME: 'Configured Admin', ADMIN_PASSWORD_HASH: productionAdminHash };
  await startServer(productionConfig);
  let store = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(store.products.length, 0); assert.equal(store.categories.length, 0); assert.equal(Object.keys(store.coupons).length, 0); assert.equal(store.riders.length, 0); assert.equal(store.deliveryAreas.length, 0);
  const preservedAccount = { id: 'production-preserved-customer', phone: '9880000099', name: 'Existing Customer', passwordHash: await hashPassword('preserved-account-secure-phrase'), referralCode: 'KEEP99', createdAt: '2024-04-02T00:00:00.000Z' };
  store.products.push({ id: 'marked-demo-product', name: 'Fixture Tomato', detail: '1 kg', category: 'fresh-food', price: 20, mrp: 25, stock: 10, description: 'Fixture Tomato delivered fresh to your door. Demo listing for local browsing.', isActive: true }, { id: 'kept-catalog-product', name: 'Configured Pear', detail: '1 piece', category: 'fresh-food', price: 30, mrp: 35, stock: 4, description: 'Store-managed listing', isActive: true });
  store.users.push(preservedAccount);
  store.sessions['legacy-otp-session'] = { userId: preservedAccount.id, createdAt: Date.now() - 1000, expiresAt: Date.now() + 86400_000 };
  store.carts[preservedAccount.id] = { 'marked-demo-product': 2 };
  store.wishlists[preservedAccount.id] = ['marked-demo-product'];
  store.addresses[preservedAccount.id] = [{ id: 'preserved-address', label: 'Home', recipientName: 'Existing Customer', phone: preservedAccount.phone, line1: 'Keep this address', city: 'Preserve City' }];
  store.orders.push({ id: 'preserved-production-order', displayId: 'ZP00009999', userId: preservedAccount.id, items: [], subtotal: 0, discount: 0, delivery: 0, total: 0, status: 'Delivered', createdAt: '2024-04-02T00:00:00.000Z' });
  store.coupons.DEMO50 = { code: 'DEMO50', label: '₹50 off your demo order', minimum: 299, discountType: 'fixed', discount: 50, isActive: true };
  store.coupons.KEEP10 = { code: 'KEEP10', label: 'Store configured offer', minimum: 0, discountType: 'fixed', discount: 10, isActive: true };
  store.notifications[preservedAccount.id] = [{ id: 'old-demo-offer', type: 'offer', title: 'A little something', message: 'Try DEMO50 for ₹50 off a sample order of ₹299 or more.', createdAt: '2024-04-02T00:00:00.000Z', readAt: null }, { id: 'preserved-order-notice', type: 'order', title: 'Order delivered', message: 'Your order was delivered.', createdAt: '2024-04-02T00:00:00.000Z', readAt: null }];
  store.riders.push({ id: 'legacy-otp-rider', phone: '9880000088', name: 'Legacy Rider', vehicle: 'Bike', isActive: true, status: 'offline' });
  store.riderSessions['legacy-otp-rider-session'] = { riderId: 'legacy-otp-rider', createdAt: Date.now() - 1000, expiresAt: Date.now() + 86400_000 };
  store.dispatchSettings = { designatedRiderId: 'legacy-otp-rider' };
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  await stopServer(); await startServer(productionConfig);
  store = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(store.products.find(row => row.id === 'marked-demo-product').isActive, false, 'marked fixture product is deactivated without deleting its record');
  assert.equal(store.products.find(row => row.id === 'kept-catalog-product').isActive, true);
  assert.equal(store.coupons.DEMO50.isActive, false, 'the specifically marked demo coupon is disabled in production');
  assert.equal(store.coupons.KEEP10.isActive, true);
  assert.ok(store.users.some(row => row.id === preservedAccount.id)); assert.ok(store.orders.some(row => row.id === 'preserved-production-order'));
  assert.deepEqual(store.carts[preservedAccount.id], { 'marked-demo-product': 2 }); assert.deepEqual(store.wishlists[preservedAccount.id], ['marked-demo-product']);
  assert.equal(store.sessions['legacy-otp-session'], undefined, 'pre-upgrade unauthenticated-method session is revoked');
  assert.equal(store.riderSessions['legacy-otp-rider-session'], undefined, 'legacy Rider OTP session is revoked');
  assert.equal(store.dispatchSettings.designatedRiderId, null, 'a Rider without password credentials cannot receive production dispatch');
  assert.equal((await call('/api/orders', { cookie: 'sid=legacy-otp-session' })).status, 401);
  assert.equal((await call('/api/rider/bootstrap', { cookie: 'rsid=legacy-otp-rider-session' })).status, 401);
  const existingLogin = await call('/api/auth/password/login', { method: 'POST', origin: true, body: { phone: preservedAccount.phone, password: 'preserved-account-secure-phrase' } });
  assert.equal(existingLogin.status, 200);
  const preservedNotifications = await call('/api/notifications', { cookie: existingLogin.cookie });
  assert.deepEqual(preservedNotifications.data.notifications.map(row => row.id), ['preserved-order-notice']);
  const preservedBootstrap = await call('/api/bootstrap', { cookie: existingLogin.cookie });
  assert.equal(preservedBootstrap.data.products.some(row => row.id === 'marked-demo-product'), false);
  assert.equal(preservedBootstrap.data.products.some(row => row.id === 'kept-catalog-product'), true);
  assert.equal(preservedBootstrap.data.coupons.some(row => row.code === 'DEMO50'), false);
  assert.ok(store.notifications[preservedAccount.id].some(row => row.id === 'old-demo-offer'), 'hidden fixture notification is preserved in storage');
  const health = await call('/api/health'); assert.equal(health.data.mode, 'production'); assert.equal(health.data.payments.online, false); assert.match(health.hsts, /max-age=/); assert.match(health.csp, /frame-ancestors 'none'/);
  assert.equal(Object.hasOwn(health.data.authConfigured || {}, 'admin'), false, 'the public health endpoint does not reveal Admin credential status');
  const unauthenticatedConfig = await call('/api/admin/config'); assert.equal(unauthenticatedConfig.status, 401);
  const config = await call('/api/admin/config', { cookie: adminCookie }); assert.deepEqual(config.data, { configured: true });
  for (const route of ['/api/auth/request-otp', '/api/rider/auth/request-otp', '/api/admin/auth/request-otp']) {
    const otp = await call(route, { method: 'POST', origin: true, body: { phone: '9880000011' } });
    assert.notEqual(otp.status, 200, `${route} must not be a production authentication bypass`);
    assert.equal('testCode' in otp.data, false);
  }
  const blockedCsrf = await call('/api/auth/register', { method: 'POST', body: { phone: '9880000011', name: 'Production User', password: validPassword, confirmPassword: validPassword } }); assert.equal(blockedCsrf.status, 403);
  const admin = await call('/api/admin/auth/login', { method: 'POST', origin: true, body: { phone: '9880000001', password: productionAdminPassword } }); assert.equal(admin.status, 200); adminCookie = admin.cookie;
  assert.match(admin.setCookie, /Secure/i);
  const area = await call('/api/admin/delivery-areas', { method: 'POST', origin: true, cookie: adminCookie, body: { name: 'Configured Area', pinCodes: [], deliveryCharge: 21, minimumOrder: 0, freeDeliveryThreshold: null, etaMinMinutes: 15, etaMaxMinutes: 25 } }); assert.equal(area.status, 201);
  const category = await call('/api/admin/categories', { method: 'POST', origin: true, cookie: adminCookie, body: { name: 'Fresh food', id: 'fresh-food' } }); assert.equal(category.status, 201);
  const product = await call('/api/admin/products', { method: 'POST', origin: true, cookie: adminCookie, body: { name: 'Configured Apple', category: category.data.category.id, price: 30, mrp: 35, stock: 4 } }); assert.equal(product.status, 201);
  const customer = await call('/api/auth/register', { method: 'POST', origin: true, body: { phone: '9880000011', name: 'Production User', password: validPassword, confirmPassword: validPassword } }); assert.equal(customer.status, 201); const customerCookie = customer.cookie;
  assert.match(customer.setCookie, /Secure/i);
  const address = await call('/api/addresses', { method: 'POST', origin: true, cookie: customerCookie, body: { label: 'Home', recipientName: 'Production User', phone: '9880000011', line1: '1 Config Lane', city: 'Production City', deliveryAreaId: area.data.area.id } }); assert.equal(address.status, 201);
  await call('/api/cart/items', { method: 'POST', origin: true, cookie: customerCookie, body: { productId: product.data.product.id, delta: 1 } });
  const badPayment = await call('/api/orders', { method: 'POST', origin: true, cookie: customerCookie, body: { addressId: address.data.address.id, paymentMethod: 'anything' } });
  assert.equal(badPayment.status, 400);
  const simulated = await call('/api/orders', { method: 'POST', origin: true, cookie: customerCookie, body: { addressId: address.data.address.id, paymentMethod: 'upi' } });
  assert.equal(simulated.status, 503); assert.match(simulated.data.error, /Online payment is not configured/);
  const cod = await call('/api/orders', { method: 'POST', origin: true, cookie: customerCookie, body: { addressId: address.data.address.id, paymentMethod: 'cod' } });
  assert.equal(cod.status, 201); assert.equal(cod.data.order.paymentStatus, 'Pay on delivery'); assert.notEqual(cod.data.order.paymentStatus, 'Paid');
  assert.equal(cod.data.order.status, 'Order received');
  assert.equal(cod.data.order.timeline.find(step => step.label === 'Being packed').complete, false);
  assert.equal(cod.data.order.timeline.find(step => step.label === 'Ready for pickup').complete, false);
  const customerOrderRoute = `/api/orders/${cod.data.order.id}`;
  assert.equal((await call(customerOrderRoute, { cookie: admin.cookie })).status, 401, 'admin credentials are not a customer session');
  const receivedByCustomer = await call(customerOrderRoute, { cookie: customerCookie });
  assert.equal(receivedByCustomer.status, 200); assert.equal(receivedByCustomer.data.order.status, 'Order received');
  const orderAdminRoute = `/api/admin/orders/${cod.data.order.id}/status`;
  assert.equal((await call(orderAdminRoute, { method: 'PATCH', origin: true, cookie: customerCookie, body: { status: 'Ready for pickup' } })).status, 401);
  const packing = await call(orderAdminRoute, { method: 'PATCH', origin: true, cookie: admin.cookie, body: { status: 'Being packed' } });
  assert.equal(packing.status, 200); assert.equal(packing.data.order.status, 'Being packed');
  const ready = await call(orderAdminRoute, { method: 'PATCH', origin: true, cookie: admin.cookie, body: { status: 'Ready for pickup' } });
  assert.equal(ready.status, 200); assert.ok(ready.data.order.readyAt);
  const customerSeesReady = await call(customerOrderRoute, { cookie: customerCookie });
  assert.equal(customerSeesReady.data.order.status, 'Ready for pickup');
  assert.equal(customerSeesReady.data.order.timeline.find(step => step.label === 'Ready for pickup').complete, true);
  const otherCustomer = await call('/api/auth/register', { method: 'POST', origin: true, body: { phone: '9880000012', name: 'Other Customer', password: validPassword, confirmPassword: validPassword } });
  assert.equal(otherCustomer.status, 201);
  assert.equal((await call(customerOrderRoute, { cookie: otherCustomer.cookie })).status, 404, 'a different customer cannot read this order');
  const available = await call('/api/rider/bootstrap'); assert.equal(available.status, 401, 'rider operations must require rider authentication');
  const customerLogout = await call('/api/auth/logout', { method: 'POST', origin: true, cookie: customerCookie, body: {} });
  assert.match(customerLogout.setCookie, /Secure/i); assert.equal((await call(customerOrderRoute, { cookie: customerCookie })).status, 401);
  const logout = await call('/api/admin/auth/logout', { method: 'POST', origin: true, cookie: admin.cookie, body: {} });
  assert.equal(logout.status, 200, JSON.stringify(logout.data)); assert.match(logout.setCookie || '', /Secure/i); assert.equal((await call('/api/admin/bootstrap', { cookie: admin.cookie })).status, 401);
});
