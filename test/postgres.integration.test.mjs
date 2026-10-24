import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { postgresTestTargetSafety } from '../lib/postgres-test-safety.mjs';

const root = path.resolve(import.meta.dirname, '..');
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL || '';
const targetSafety = postgresTestTargetSafety(process.env);
const databaseName = targetSafety.databaseName;
const enabled = targetSafety.enabled;

async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function waitForServer(base, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('PostgreSQL-backed app exited during startup.');
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out starting PostgreSQL-backed app.');
}
async function api(base, route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('PostgreSQL application flows, durable sessions, transactions, rider permissions, and idempotent checkout', { skip: !enabled ? targetSafety.reason : false }, async t => {
  const schema = `zepto_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 });
  let child = null, appPool = null, fixtureDir = null;
  let schemaCreated = false;
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set('options', `-csearch_path=${schema},public`);
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    const migrate = spawn(process.execPath, ['scripts/migrate-postgres.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: scopedUrl.toString() }, stdio: 'ignore' });
    const [migrationCode] = await once(migrate, 'exit'); assert.equal(migrationCode, 0, 'schema migration succeeds in the isolated test schema');
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zepto-pg-import-'));
    const fixturePath = path.join(fixtureDir, 'source-store.json');
    const fixture = {
      users: [{ id: 'migration-customer', phone: '9100000010', name: 'Migration Test Customer', referralCode: 'MIGRATE10', createdAt: new Date().toISOString() }],
      sessions: { 'migration-session-secret-test-0001': { userId: 'migration-customer', authMethod: 'password', createdAt: Date.now(), expiresAt: Date.now() + 3600000 } },
      challenges: {}, adminSessions: {}, adminChallenges: {}, riders: [{ id: 'migration-rider', phone: '9000000000', name: 'Isolated PostgreSQL Rider', vehicle: 'Bike', status: 'offline', isActive: true }], riderSessions: {}, riderChallenges: {},
      categories: [{ id: 'all', name: 'All' }, { id: 'test-category', name: 'Test category' }],
      products: [{ id: 'p101', name: 'Postgres Test Product', detail: '1 item', category: 'test-category', price: 79, mrp: 99, stock: 9, isActive: true, rank: 0 }],
      deliveryAreas: [{ id: 'import-area', name: 'Imported Test Area', deliveryCharge: 20, minimumOrder: 0, freeDeliveryThreshold: 250, etaMinMinutes: 10, etaMaxMinutes: 20, isActive: true }],
      addresses: {}, carts: { guest: {} }, wishlists: { guest: [] }, appliedCoupon: {}, coupons: {}, notifications: {}, notificationWelcome: {}, selectedDeliveryAreas: {}, selectedDeliveryAddresses: {},
      orders: [{ id: 'import-simulated-order', displayId: 'ZPIMPORT01', userId: 'migration-customer', items: [], address: { label: 'Home', line1: 'Historic address', city: 'Test City' }, paymentMethod: 'Demo UPI', paymentStatus: 'Demo payment complete (simulated)', subtotal: 0, discount: 0, delivery: 0, platform: 0, total: 0, status: 'Delivered', createdAt: new Date().toISOString(), timeline: [] }],
      referrals: [], rewards: [], referralEvents: [], referralCampaign: { enabled: false }, dispatchSettings: { designatedRiderId: 'migration-rider' }
    };
    await fs.writeFile(fixturePath, JSON.stringify(fixture));
    for (let run = 0; run < 2; run++) {
      const imported = spawnSync(process.execPath, ['scripts/import-json-store.mjs','--import',`--file=${fixturePath}`,`--confirm-target=${databaseName}`,'--include-suspected-demo-records'], { cwd: root, env: { ...process.env, DATABASE_URL: scopedUrl.toString() }, encoding: 'utf8' });
      assert.equal(imported.status, 0, `repeatable source import succeeds (run ${run + 1}): ${imported.stderr}`);
    }
    const importCheck = await adminPool.query(`SELECT (SELECT count(*) FROM "${schema}".app_users WHERE id='migration-customer')::int AS users,(SELECT count(*) FROM "${schema}".orders WHERE id='import-simulated-order')::int AS orders,(SELECT payment_status FROM "${schema}".orders WHERE id='import-simulated-order') AS payment_status`);
    assert.deepEqual(importCheck.rows[0], { users: 1, orders: 1, payment_status: 'Demo payment complete (simulated)' });
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(port), DATABASE_URL: scopedUrl.toString(), STORE_PATH: path.join(os.tmpdir(), `zepto-json-must-not-be-used-${randomUUID()}.json`) }, stdio: 'ignore' });
    await waitForServer(base, child);
    const adminChallenge = await api(base, '/api/admin/auth/request-otp', { method: 'POST', body: { phone: '9000000001' } }); assert.equal(adminChallenge.status, 200);
    const adminLogin = await api(base, '/api/admin/auth/verify-otp', { method: 'POST', body: { challengeId: adminChallenge.data.challengeId, code: adminChallenge.data.testCode } }); assert.equal(adminLogin.status, 200); const adminCookie = adminLogin.cookie;
    const areaId = (await adminPool.query(`SELECT id FROM "${schema}".delivery_areas WHERE id='import-area'`)).rows[0].id;
    assert.equal((await api(base, '/api/admin/products/p101', { method: 'PATCH', cookie: adminCookie, body: { price: 79, stock: 9 } })).status, 200);
    const coupon = await api(base, '/api/admin/coupons', { method: 'POST', cookie: adminCookie, body: { code: 'PGTEST10', discountType: 'fixed', discount: 10, minimum: 50, label: 'PostgreSQL integration test' } }); assert.equal(coupon.status, 201);
    const customerCookie = 'sid=migration-session-secret-test-0001';
    assert.equal((await api(base, '/api/orders', { cookie: customerCookie })).data.orders.length, 1, 'imported customer session survives startup');
    const savedAddress = await api(base, '/api/addresses', { method: 'POST', cookie: customerCookie, body: { label: 'Home', recipientName: 'Migration Test Customer', phone: '9100000010', line1: '1 Test Street', city: 'Test City', deliveryAreaId: areaId } }); assert.equal(savedAddress.status, 201);
    await api(base, '/api/cart/items', { method: 'POST', cookie: customerCookie, body: { productId: 'p101', delta: 1 } });
    assert.equal((await api(base, '/api/coupons/apply', { method: 'POST', cookie: customerCookie, body: { code: 'PGTEST10' } })).status, 200);
    const orderBody = { addressId: savedAddress.data.address.id, paymentMethod: 'cod', idempotencyKey: 'postgres-checkout-test-key-0001' };
    const [placedA, placedB] = await Promise.all([api(base, '/api/orders', { method: 'POST', cookie: customerCookie, body: orderBody }), api(base, '/api/orders', { method: 'POST', cookie: customerCookie, body: orderBody })]);
    assert.ok([placedA.status, placedB.status].every(status => [200,201].includes(status)));
    assert.equal(placedA.data.order.id, placedB.data.order.id);
    assert.equal((await api(base, '/api/orders', { cookie: customerCookie })).data.orders.length, 2);
    assert.equal(placedA.data.order.discount, 10); assert.equal(placedA.data.order.total, 91);
    const storedProduct = await adminPool.query(`SELECT stock,price::text FROM "${schema}".products WHERE id='p101'`);
    assert.equal(storedProduct.rows[0].stock, 8); assert.equal(storedProduct.rows[0].price, '79.00');
    const rawSession = customerCookie.slice(4);
    const sessionRows = await adminPool.query(`SELECT id,data FROM "${schema}".app_sessions WHERE kind='customer'`);
    assert.ok(sessionRows.rows.some(row => row.id !== rawSession && /^[a-f0-9]{64}$/.test(row.id)));
    assert.equal((await api(base, '/api/rider/orders')).status, 401, 'customer credentials do not authorize rider access');
    const riderChallenge = await api(base, '/api/rider/auth/request-otp', { method: 'POST', body: { phone: '9000000000' } }); assert.equal(riderChallenge.status, 200);
    const riderLogin = await api(base, '/api/rider/auth/verify-otp', { method: 'POST', body: { challengeId: riderChallenge.data.challengeId, code: riderChallenge.data.testCode } }); assert.equal(riderLogin.status, 200); const riderCookie = riderLogin.cookie;
    assert.equal((await api(base, '/api/rider/auth/password', { method: 'POST', cookie: riderCookie, body: { newPassword: 'rider-postgres-test-passphrase', confirmPassword: 'rider-postgres-test-passphrase' } })).status, 200);
    assert.equal((await api(base, '/api/rider/bootstrap', { cookie: riderCookie })).status, 200, 'password setup retains the hashed-session-backed cookie');
    assert.equal((await api(base, '/api/rider/status', { method: 'POST', cookie: riderCookie, body: { status: 'online' } })).status, 200);
    const inbox = await api(base, '/api/rider/orders', { cookie: riderCookie }); assert.ok(inbox.data.availableOrders.some(order => order.id === placedA.data.order.id));
    const accept = await api(base, `/api/rider/orders/${placedA.data.order.id}/accept`, { method: 'POST', cookie: riderCookie }); assert.equal(accept.status, 200);
    for (const action of ['pickup','out_for_delivery']) assert.equal((await api(base, `/api/rider/orders/${placedA.data.order.id}`, { method: 'POST', cookie: riderCookie, body: { action } })).status, 200);
    assert.equal((await api(base, `/api/rider/orders/${placedA.data.order.id}/payment`, { method: 'POST', cookie: riderCookie, body: { method: 'cash', confirmed: true } })).status, 200);
    assert.equal((await api(base, `/api/rider/orders/${placedA.data.order.id}`, { method: 'POST', cookie: riderCookie, body: { action: 'delivered' } })).status, 200);
    assert.equal((await api(base, `/api/orders/${placedA.data.order.id}`, { cookie: customerCookie })).data.order.status, 'Delivered');
    const adminView = await api(base, '/api/admin/bootstrap', { cookie: adminCookie }); assert.ok(adminView.data.orders.some(order => order.id === placedA.data.order.id));
    appPool = new Pool({ connectionString: scopedUrl.toString(), max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true } });
    const transaction = await appPool.connect();
    try {
      const stockBefore = (await transaction.query(`SELECT stock FROM "${schema}".products WHERE id='p101'`)).rows[0].stock;
      await transaction.query('BEGIN');
      await assert.rejects(transaction.query(`UPDATE "${schema}".products SET stock=-1 WHERE id='p101'`), /products_stock_check/);
      await transaction.query('ROLLBACK');
      assert.equal((await transaction.query(`SELECT stock FROM "${schema}".products WHERE id='p101'`)).rows[0].stock, stockBefore, 'constraint failure rollback preserves inventory');
    } finally { transaction.release(); }
    const previousChild = child; previousChild.kill(); await once(previousChild, 'exit'); child = null;
    const restartPort = await freePort();
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(restartPort), DATABASE_URL: scopedUrl.toString() }, stdio: 'ignore' });
    await waitForServer(`http://127.0.0.1:${restartPort}`, child);
    const recovered = await api(`http://127.0.0.1:${restartPort}`, '/api/orders', { cookie: customerCookie });
    assert.equal(recovered.status, 200); assert.equal(recovered.data.orders[0].status, 'Delivered', 'order and hashed customer session survive process restart');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
    await appPool?.end();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
