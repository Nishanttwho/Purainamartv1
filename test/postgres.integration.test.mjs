import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { postgresTestTargetSafety } from '../lib/postgres-test-safety.mjs';
import { configurePostgresPool, normalizePostgresConnectionString } from '../lib/postgres-config.mjs';
import { hashPassword } from '../lib/password.mjs';

const root = path.resolve(import.meta.dirname, '..');
const rawTestDatabaseUrl = process.env.POSTGRES_TEST_DATABASE_URL || '';
let databaseUrl = '';
if (rawTestDatabaseUrl) {
  let parsedTestUrl;
  try { parsedTestUrl = new URL(rawTestDatabaseUrl); }
  catch { throw new Error('POSTGRES_TEST_DATABASE_URL must be a valid PostgreSQL URL targeting neondb_test; no connection was attempted.'); }
  const parsedDatabaseName = decodeURIComponent(parsedTestUrl.pathname.replace(/^\/+/, ''));
  if (!['postgres:', 'postgresql:'].includes(parsedTestUrl.protocol) || parsedDatabaseName !== 'neondb_test') {
    throw new Error('POSTGRES_TEST_DATABASE_URL must target exactly neondb_test; no connection was attempted.');
  }
  databaseUrl = normalizePostgresConnectionString(rawTestDatabaseUrl);
}
const targetSafety = postgresTestTargetSafety(process.env);
const databaseName = targetSafety.databaseName;
const hasTestDatabaseUrl = Boolean(process.env.POSTGRES_TEST_DATABASE_URL);

async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
function safeChildDiagnostics(value) {
  return String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgresql://[REDACTED]')
    .replace(/("(?:[^"]*(?:password|secret|token|authorization|cookie|database.?url|api.?key)[^"]*)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function captureChildOutput(child) {
  child.diagnostics = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', chunk => { child.diagnostics[stream] += chunk; });
  }
}
function childFailure(child) {
  const status = `exitCode=${child.exitCode ?? 'running'}, signal=${child.signalCode || 'none'}`;
  const diagnostics = safeChildDiagnostics(`stdout:\n${child.diagnostics?.stdout || '(empty)'}\nstderr:\n${child.diagnostics?.stderr || '(empty)'}`);
  return `${status}\n${diagnostics}`;
}
function redactDiagnosticValue(value) {
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? safeChildDiagnostics(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /password|secret|token|authorization|cookie|database.?url|api.?key/i.test(key) ? '[REDACTED]' : redactDiagnosticValue(child)
  ]));
}
async function waitForServer(base, child) {
  const startedAt = Date.now(), deadline = startedAt + 20000;
  let lastReadiness = 'no readiness response received';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`PostgreSQL-backed app exited during startup after ${Date.now() - startedAt} ms (${childFailure(child)}).`);
    try {
      const response = await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1800) });
      const body = await response.text();
      lastReadiness = `HTTP ${response.status}: ${safeChildDiagnostics(body).slice(0, 1000)}`;
      if (response.ok) {
        const result = JSON.parse(body);
        if (result.ready === true && result.database === 'connected') return;
      }
    } catch (error) { lastReadiness = `${error.name}: ${error.message}`; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out starting PostgreSQL-backed app after ${Date.now() - startedAt} ms. Readiness: ${lastReadiness}. Child: ${childFailure(child)}`);
}
async function api(base, route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('PostgreSQL application flows, durable sessions, transactions, rider permissions, and idempotent checkout', { skip: !hasTestDatabaseUrl ? targetSafety.reason : false }, async t => {
  assert.equal(targetSafety.enabled, true, `PostgreSQL test safety checks failed: ${targetSafety.reason || 'unknown target'}`);
  assert.equal(process.env.NODE_ENV, 'test', 'the integration runner itself must use NODE_ENV=test');
  assert.equal(process.env.POSTGRES_TEST_CONFIRM_DATABASE, databaseName, 'the explicitly confirmed database name must match the test URL');
  assert.equal(new URL(databaseUrl).pathname.replace(/^\//, ''), 'neondb_test', 'integration tests are restricted to neondb_test');
  assert.notEqual(process.env.PGSSL, 'disable', 'Neon test connections must keep TLS enabled');
  const schema = `zepto_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 });
  let child = null, appPool = null, fixtureDir = null;
  let schemaCreated = false;
  const scopedUrl = new URL(databaseUrl);
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    configurePostgresPool(adminPool, schema);
    const testEnv = { ...process.env, DATABASE_URL: scopedUrl.toString(), PG_SCHEMA: schema };
    assert.equal(new URL(testEnv.DATABASE_URL).pathname.replace(/^\//, ''), databaseName, 'the spawned app DATABASE_URL maps to the isolated test database');
    const migrate = spawnSync(process.execPath, ['scripts/migrate-postgres.mjs'], { cwd: root, env: testEnv, encoding: 'utf8', timeout: 60000 });
    assert.equal(migrate.status, 0, `schema migration succeeds in the isolated test schema: ${migrate.stderr}`);
    await adminPool.query(`INSERT INTO "${schema}".categories(id,position,data) VALUES('constraint-test',0,'{"id":"constraint-test","name":"Constraint test"}'::jsonb)`);
    await assert.rejects(adminPool.query(`INSERT INTO "${schema}".products(id,position,category_id,name,price,mrp,stock,is_active,rank,data) VALUES('packed-null-mrp',0,'constraint-test','Invalid packed item',10,NULL,1,true,0,'{"saleType":"packed"}'::jsonb)`), /products_mrp_required_for_non_loose/);
    await assert.rejects(adminPool.query(`INSERT INTO "${schema}".products(id,position,category_id,name,price,mrp,stock,is_active,rank,data) VALUES('below-reference-mrp',0,'constraint-test','Invalid reference MRP',10,9,1,true,0,'{}'::jsonb)`), /products_mrp_check/);
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zepto-pg-import-'));
    const fixturePath = path.join(fixtureDir, 'source-store.json');
    const fixture = {
      users: [{ id: 'migration-customer', phone: '9100000010', name: 'Migration Test Customer', referralCode: 'MIGRATE10', createdAt: new Date().toISOString() }],
      sessions: { 'migration-session-secret-test-0001': { userId: 'migration-customer', authMethod: 'password', createdAt: Date.now(), expiresAt: Date.now() + 3600000 } },
      challenges: {}, adminSessions: {}, adminChallenges: {}, riders: [{ id: 'migration-rider', phone: '9000000002', name: 'Isolated PostgreSQL Rider', vehicle: 'Bike', passwordHash: await hashPassword('rider-initial-test-passphrase'), mustChangePassword: false, status: 'offline', isActive: true }], riderSessions: {}, riderChallenges: {},
      categories: [{ id: 'all', name: 'All' }, { id: 'test-category', name: 'Test category' }, { id: 'pantry', name: 'Staples' }],
      products: [{ id: 'p101', name: 'Postgres Test Product', detail: '1 item', category: 'test-category', price: 79, mrp: 99, stock: 9, isActive: true, rank: 0 }],
      deliveryAreas: [{ id: 'import-area', name: 'Imported Test Area', deliveryCharge: 20, minimumOrder: 0, freeDeliveryThreshold: 250, etaMinMinutes: 10, etaMaxMinutes: 20, isActive: true }],
      addresses: {}, carts: { guest: {} }, wishlists: { guest: [] }, appliedCoupon: {}, coupons: {}, notifications: {}, notificationWelcome: {}, selectedDeliveryAreas: {}, selectedDeliveryAddresses: {},
      orders: [{ id: 'import-simulated-order', displayId: 'ZPIMPORT01', userId: 'migration-customer', items: [], address: { label: 'Home', line1: 'Historic address', city: 'Test City' }, paymentMethod: 'Demo UPI', paymentStatus: 'Demo payment complete (simulated)', subtotal: 0, discount: 0, delivery: 0, platform: 0, total: 0, status: 'Delivered', createdAt: new Date().toISOString(), timeline: [] }],
      referrals: [], rewards: [], referralEvents: [], referralCampaign: { enabled: false }, dispatchSettings: { designatedRiderId: 'migration-rider' }
    };
    await fs.writeFile(fixturePath, JSON.stringify(fixture));
    for (let run = 0; run < 2; run++) {
      const imported = spawnSync(process.execPath, ['scripts/import-json-store.mjs','--import',`--file=${fixturePath}`,`--confirm-target=${databaseName}`,'--include-suspected-demo-records'], { cwd: root, env: testEnv, encoding: 'utf8' });
      assert.equal(imported.status, 0, `repeatable source import succeeds (run ${run + 1}): ${imported.stderr}`);
    }
    const importCheck = await adminPool.query(`SELECT (SELECT count(*) FROM "${schema}".app_users WHERE id='migration-customer')::int AS users,(SELECT count(*) FROM "${schema}".orders WHERE id='import-simulated-order')::int AS orders,(SELECT payment_status FROM "${schema}".orders WHERE id='import-simulated-order') AS payment_status`);
    assert.deepEqual(importCheck.rows[0], { users: 1, orders: 1, payment_status: 'Demo payment complete (simulated)' });
    const catalogueFixture = {
      users: [{ id: 'catalogue-must-not-import' }], orders: [{ id: 'catalogue-order-must-not-import' }],
      categories: [{ id: 'all', name: 'All' }, { id: 'test-category', name: 'Test category' }, { id: 'catalogue-only-category', name: 'Catalogue only' }, { id: 'unused-category', name: 'Unused' }],
      products: [
        { id: 'catalogue-packed', name: 'Catalogue packed item', detail: '1 pack', category: 'catalogue-only-category', price: 25, mrp: 30, stock: 5, isActive: true, image: '/assets/customer/zepto-home/products/p101-avocado.jpeg' },
        { id: 'catalogue-loose', name: 'Catalogue loose item', detail: 'Loose', category: 'test-category', price: 62, mrp: null, stock: 1000, isActive: true, saleType: 'loose', measurementUnit: 'g', image: '/assets/customer/puraina/p123-basmati-rice-loose-detail-v1.jpg', variants: [{ id: 'catalogue-loose-500', label: '500 g', quantityBase: 500, unit: 'g', price: 31, mrp: null, stock: 1000, isActive: true }] },
        { id: 'catalogue-bad-stock', name: 'Invalid loose stock', category: 'test-category', price: 10, mrp: null, stock: 500, isActive: true, saleType: 'loose', measurementUnit: 'g', image: '/assets/customer/puraina/p123-basmati-rice-loose-detail-v1.jpg', variants: [{ id: 'catalogue-too-much', label: '1 kg', quantityBase: 1000, unit: 'g', price: 10, mrp: null, stock: 1000, isActive: true }] },
        { id: 'catalogue-demo', name: 'Demo placeholder', category: 'test-category', price: 10, mrp: 10, stock: 1, isActive: true, image: '/assets/customer/zepto-home/products/p101-avocado.jpeg', description: 'Demo listing for local browsing.' }
      ]
    };
    await fs.writeFile(fixturePath, JSON.stringify(catalogueFixture));
    const catalogueIds = ['catalogue-packed','catalogue-loose','catalogue-bad-stock','catalogue-demo'];
    const categoryIds = ['all','test-category','catalogue-only-category','unused-category'];
    const catalogueDryRun = spawnSync(process.execPath, ['scripts/import-catalogue.mjs', '--dry-run', `--file=${fixturePath}`, `--product-ids=${catalogueIds.join(',')}`, `--category-ids=${categoryIds.join(',')}`], { cwd: root, env: testEnv, encoding: 'utf8' });
    assert.equal(catalogueDryRun.status, 0, `${catalogueDryRun.stderr}\n${catalogueDryRun.stdout}`);
    const dryReport = JSON.parse(catalogueDryRun.stdout);
    assert.deepEqual(dryReport.actions.insertCategories.map(row => row.id).sort(), ['catalogue-only-category', 'unused-category']);
    assert.deepEqual(dryReport.actions.unchangedCategories.map(row => row.id).sort(), ['all', 'test-category']);
    assert.deepEqual(dryReport.actions.insertProducts.map(row => row.id), ['catalogue-packed', 'catalogue-loose']);
    assert.deepEqual(dryReport.actions.updatedProducts, []);
    assert.deepEqual(dryReport.skipped.products.map(row => row.id), ['catalogue-bad-stock', 'catalogue-demo']);
    assert.equal(dryReport.otherTablesTouched, false);
    for (let run = 0; run < 2; run++) {
      const catalogueImport = spawnSync(process.execPath, ['scripts/import-catalogue.mjs', '--import', `--file=${fixturePath}`, `--product-ids=${catalogueIds.join(',')}`, `--category-ids=${categoryIds.join(',')}`, `--confirm-target=${databaseName}`], { cwd: root, env: testEnv, encoding: 'utf8' });
      assert.equal(catalogueImport.status, 0, `catalogue-only import succeeds (run ${run + 1}): ${catalogueImport.stderr}`);
    }
    const catalogueCheck = await adminPool.query(`SELECT (SELECT count(*) FROM "${schema}".app_users)::int AS users,(SELECT count(*) FROM "${schema}".orders)::int AS orders,(SELECT count(*) FROM "${schema}".categories WHERE id IN ('all','test-category','catalogue-only-category','unused-category'))::int AS categories,(SELECT count(*) FROM "${schema}".products WHERE id IN ('catalogue-packed','catalogue-loose'))::int AS products,(SELECT mrp FROM "${schema}".products WHERE id='catalogue-loose') AS loose_mrp,(SELECT count(*) FROM "${schema}".products WHERE id IN ('catalogue-bad-stock','catalogue-demo'))::int AS skipped_products`);
    assert.deepEqual(catalogueCheck.rows[0], { users: 1, orders: 1, categories: 4, products: 2, loose_mrp: null, skipped_products: 0 });
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...testEnv, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(port), STORE_PATH: path.join(os.tmpdir(), `zepto-json-must-not-be-used-${randomUUID()}.json`) }, stdio: ['ignore','pipe','pipe'] });
    captureChildOutput(child);
    await waitForServer(base, child);
    const adminChallenge = await api(base, '/api/admin/auth/request-otp', { method: 'POST', body: { phone: '9000000001' } }); assert.equal(adminChallenge.status, 200);
    const adminLogin = await api(base, '/api/admin/auth/verify-otp', { method: 'POST', body: { challengeId: adminChallenge.data.challengeId, code: adminChallenge.data.testCode } }); assert.equal(adminLogin.status, 200); const adminCookie = adminLogin.cookie;
    const areaId = (await adminPool.query(`SELECT id FROM "${schema}".delivery_areas WHERE id='import-area'`)).rows[0].id;
    assert.equal((await api(base, '/api/admin/products/p101', { method: 'PATCH', cookie: adminCookie, body: { price: 79, stock: 9 } })).status, 200);
    const looseAfterSnapshotWrite = await adminPool.query(`SELECT data->>'mrp' AS mrp,mrp::text AS indexed_mrp FROM "${schema}".products WHERE id='catalogue-loose'`);
    assert.equal(looseAfterSnapshotWrite.rows[0].mrp, null, 'full-store snapshot writes preserve a loose product with no MRP');
    assert.equal(looseAfterSnapshotWrite.rows[0].indexed_mrp, null);
    const coupon = await api(base, '/api/admin/coupons', { method: 'POST', cookie: adminCookie, body: { code: 'PGTEST10', discountType: 'fixed', discount: 10, minimum: 50, label: 'PostgreSQL integration test' } }); assert.equal(coupon.status, 201);
    const customerCookie = 'sid=migration-session-secret-test-0001';
    assert.equal((await api(base, '/api/orders', { cookie: customerCookie })).data.orders.length, 1, 'imported customer session survives startup');
    const savedAddress = await api(base, '/api/addresses', { method: 'POST', cookie: customerCookie, body: { label: 'Home', recipientName: 'Migration Test Customer', phone: '9100000010', line1: '1 Test Street', city: 'Test City', deliveryAreaId: areaId } }); assert.equal(savedAddress.status, 201);
    await api(base, '/api/cart/items', { method: 'POST', cookie: customerCookie, body: { productId: 'p101', delta: 1 } });
    assert.equal((await api(base, '/api/coupons/apply', { method: 'POST', cookie: customerCookie, body: { code: 'PGTEST10' } })).status, 200);
    const orderBody = { addressId: savedAddress.data.address.id, paymentMethod: 'cod', idempotencyKey: 'postgres-checkout-test-key-0001' };
    const [placedA, placedB] = await Promise.all([api(base, '/api/orders', { method: 'POST', cookie: customerCookie, body: orderBody }), api(base, '/api/orders', { method: 'POST', cookie: customerCookie, body: orderBody })]);
    const acceptedCheckoutStatuses = [placedA.status, placedB.status].every(status => [200,201].includes(status));
    const checkoutDiagnostic = safeChildDiagnostics(JSON.stringify({
      checkout: [
        { status: placedA.status, body: redactDiagnosticValue(placedA.data) },
        { status: placedB.status, body: redactDiagnosticValue(placedB.data) }
      ],
      server: {
        exitCode: child.exitCode,
        signal: child.signalCode,
        relevantLogs: [child.diagnostics.stdout, child.diagnostics.stderr]
          .join('\n').split(/\r?\n/)
          .filter(line => /error|fail|slow_postgres|queue_wait_timeout|advisory|checkout|\/api\/orders/i.test(line))
          .slice(-60)
          .map(line => safeChildDiagnostics(line))
      }
    }));
    if (!acceptedCheckoutStatuses) console.error('PostgreSQL concurrent checkout diagnostic:', checkoutDiagnostic);
    assert.ok(acceptedCheckoutStatuses, checkoutDiagnostic);
    assert.equal(placedA.data.order.id, placedB.data.order.id);
    assert.equal((await api(base, '/api/orders', { cookie: customerCookie })).data.orders.length, 2);
    assert.equal(placedA.data.order.discount, 10); assert.equal(placedA.data.order.total, 91);
    const storedProduct = await adminPool.query(`SELECT stock,price::text FROM "${schema}".products WHERE id='p101'`);
    assert.equal(storedProduct.rows[0].stock, 8); assert.equal(storedProduct.rows[0].price, '79.00');
    const rawSession = customerCookie.slice(4);
    const sessionRows = await adminPool.query(`SELECT id,data FROM "${schema}".app_sessions WHERE kind='customer'`);
    assert.ok(sessionRows.rows.some(row => row.id !== rawSession && /^[a-f0-9]{64}$/.test(row.id)));
    assert.equal((await api(base, '/api/rider/orders')).status, 401, 'customer credentials do not authorize rider access');
    const riderChallenge = await api(base, '/api/rider/auth/request-otp', { method: 'POST', body: { phone: '9000000002' } }); assert.equal(riderChallenge.status, 200);
    const riderLogin = await api(base, '/api/rider/auth/verify-otp', { method: 'POST', body: { challengeId: riderChallenge.data.challengeId, code: riderChallenge.data.testCode } }); assert.equal(riderLogin.status, 200); const riderCookie = riderLogin.cookie;
    const riderPasswordChange = await api(base, '/api/rider/auth/password', { method: 'POST', cookie: riderCookie, body: { currentPassword: 'rider-initial-test-passphrase', newPassword: 'rider-postgres-test-passphrase', confirmPassword: 'rider-postgres-test-passphrase' } });
    assert.equal(riderPasswordChange.status, 200, JSON.stringify(riderPasswordChange.data));
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
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...testEnv, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(restartPort) }, stdio: ['ignore','pipe','pipe'] });
    captureChildOutput(child);
    await waitForServer(`http://127.0.0.1:${restartPort}`, child);
    const recovered = await api(`http://127.0.0.1:${restartPort}`, '/api/orders', { cookie: customerCookie });
    assert.equal(recovered.status, 200); assert.equal(recovered.data.orders[0].status, 'Delivered', 'order and hashed customer session survive process restart');
    const productBeforeLogout = await adminPool.query(`SELECT stock,price::text FROM "${schema}".products WHERE id='p101'`);
    const logout = await api(`http://127.0.0.1:${restartPort}`, '/api/auth/logout', { method: 'POST', cookie: customerCookie, body: { deviceKey: '' } });
    assert.equal(logout.status, 200);
    const sessionId = createHash('sha256').update('migration-session-secret-test-0001').digest('hex');
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM "${schema}".app_sessions WHERE kind='customer' AND id=$1`, [sessionId])).rows[0].count, 0, 'logout invalidates only the hashed durable session row');
    assert.deepEqual((await adminPool.query(`SELECT stock,price::text FROM "${schema}".products WHERE id='p101'`)).rows, productBeforeLogout.rows, 'logout does not rewrite unrelated product data');
    assert.equal((await api(`http://127.0.0.1:${restartPort}`, '/api/orders', { cookie: customerCookie })).status, 401, 'the deleted durable session can no longer authorize requests');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
    await appPool?.end();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    await adminPool.end();
    if (schemaCreated) {
      // This suite may run longer than a pooler's idle connection lifetime.
      // Use a fresh connection for final cleanup instead of reusing adminPool's
      // potentially stale pooled socket. The generated schema name is local and
      // unique to this test run.
      const cleanupPool = new Pool({ connectionString: databaseUrl, max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 });
      try { await cleanupPool.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await cleanupPool.end(); }
    }
  }
});
