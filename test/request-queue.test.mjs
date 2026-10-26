import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSerialRequestQueue, enqueueWithDeadline } from '../lib/serial-request-queue.mjs';

test('a timed-out queued mutation is skipped when it reaches the queue head', async () => {
  const queue = createSerialRequestQueue();
  let releaseBlocker;
  const blocker = queue.enqueue(() => new Promise(resolve => { releaseBlocker = resolve; }));
  let responded = false;
  let mutationRan = false;
  const expiredRequest = enqueueWithDeadline(queue, () => { mutationRan = true; }, {
    timeoutMs: 15,
    onTimeout: () => { responded = true; }
  });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(responded, true, 'the timeout response is issued while the request is waiting');
  releaseBlocker();
  await Promise.all([blocker, expiredRequest]);
  assert.equal(mutationRan, false, 'an expired POST cannot execute after its timeout response');
  assert.equal(queue.depth, 0);
});

test('the request queue recovers after a failed operation', async () => {
  const queue = createSerialRequestQueue();
  await assert.rejects(queue.enqueue(() => { throw new Error('isolated queue failure'); }), /isolated queue failure/);
  const next = await queue.enqueue(metrics => metrics);
  assert.equal(next.queueDepthAtStart, 0);
  assert.equal(Number.isFinite(next.queueWaitMs), true);
});

test('homepage first render does not wait on referral validation or protected deep-link requests', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const source = await fs.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const start = source.indexOf('async function bootstrap()');
  const end = source.indexOf('\nfunction showStoreLoadError', start);
  const bootstrap = source.slice(start, end);
  const renderAt = bootstrap.indexOf('  render();');
  const referralAt = bootstrap.indexOf("api('/api/referrals/validate?");
  assert.ok(renderAt >= 0 && referralAt > renderAt, 'render runs before the optional referral request');
  assert.doesNotMatch(bootstrap, /await\s+api\('\/api\/referrals\/validate/);
  assert.doesNotMatch(bootstrap, /await\s+handleNotificationHash\(true\)/);

  const homeClick = source.slice(source.indexOf("if (button.dataset.view === 'home')"), source.indexOf("if (button.dataset.view === 'referrals')"));
  assert.match(homeClick, /setView\('home'\)/);
  assert.doesNotMatch(homeClick, /api\(/, 'logo navigation is rendering/navigation only, not a hidden data reload');
});

test('frontend GETs time out visibly while mutations are not client-aborted', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const [customer, admin] = await Promise.all([
    fs.readFile(path.join(root, 'public', 'app.js'), 'utf8'),
    fs.readFile(path.join(root, 'public', 'admin.js'), 'utf8')
  ]);
  for (const source of [customer, admin]) {
    assert.match(source, /isReadOnly = String\(options\.method \|\| 'GET'\)/);
    assert.match(source, /controller\.abort\(\)/);
    assert.match(source, /signal: controller\.signal/);
    assert.match(source, /The server took too long to respond/);
  }
  assert.match(customer, /authRequestSucceeded\) showStoreLoadError\(error\)/);
  assert.match(customer, /if \(authError\) authError\.textContent = error\.message/);
  assert.match(customer, /finally \{\s*if \(submitButton\?\.isConnected\) \{ submitButton\.disabled = false;/);
  assert.match(admin, /note\.textContent = error\.message/);
  assert.match(admin, /Signed in, but the Admin dashboard could not load:/);
  assert.match(admin, /finally \{\s*if \(button\?\.isConnected\) \{ button\.disabled = false;/);
});

test('database APIs have bounded queue waits, independent health checks, phase timings and safe errors', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const server = await fs.readFile(path.join(root, 'server.mjs'), 'utf8');
  const healthDispatch = server.indexOf("['/api/health', '/api/health/ready']");
  const queueDispatch = server.indexOf("if (usePostgres && req.url?.startsWith('/api/'))");
  assert.ok(healthDispatch >= 0 && healthDispatch < queueDispatch, 'health probes bypass the request queue');
  for (const timing of ['queueWaitMs', 'poolConnectMs', 'advisoryLockWaitMs', 'readStoreSnapshotMs', 'handlerMs', 'writeStoreMs', 'commitMs']) assert.ok(server.includes(timing), `missing ${timing}`);
  assert.match(server, /API_QUEUE_WAIT_TIMEOUT_MS/);
  assert.match(server, /PG_STATEMENT_TIMEOUT_MS/);
  assert.match(server, /PG_LOCK_TIMEOUT_MS/);
  assert.match(server, /PG_IDLE_TX_TIMEOUT_MS/);
  const failureLog = server.slice(server.indexOf("console.error('PostgreSQL request failed'"), server.indexOf('try { if (client) await client.query', server.indexOf("console.error('PostgreSQL request failed'")));
  assert.doesNotMatch(failureLog, /error\.message/);
});

test('failed product and category image requests have local or icon fallbacks', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const app = await fs.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /data-fallback-emoji=/);
  assert.match(app, /product-placeholder\.png/);
  assert.match(app, /data-fallback-icon=/);
  assert.match(app, /category-photo-fallback/);
  assert.match(app, /image\.matches\('\.hero-fruit-image'\)/);
});
