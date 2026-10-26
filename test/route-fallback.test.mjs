import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
let tempDir, port, child;
const base = () => `http://127.0.0.1:${port}`;
before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'purainamart-routes-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), STORE_PATH: path.join(tempDir, 'store.json'), DATABASE_URL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { try { if ((await fetch(`${base()}/api/health`)).ok) return; } catch {} if (child.exitCode !== null) throw new Error('Isolated route test server exited early'); await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Isolated route test server did not start');
});
after(async () => { if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]); } if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); });

test('health endpoints, bootstrap and unconfigured Google OAuth return finite responses', async () => {
  const healthResponse = await fetch(base() + '/api/health');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok', mode: 'development', database: 'not_configured', authConfigured: { google: false }, payments: { cod: true, online: false } });

  const readyResponse = await fetch(base() + '/api/health/ready');
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), { status: 'ready', database: 'not_configured', ready: true });

  const bootstrapResponse = await fetch(base() + '/api/bootstrap');
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.ok(Array.isArray(bootstrap.categories));
  assert.ok(Array.isArray(bootstrap.products));

  const googleResponse = await fetch(base() + '/api/auth/google/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(googleResponse.status, 503);
  assert.equal((await googleResponse.json()).code, 'GOOGLE_AUTH_NOT_CONFIGURED');
});

test('unknown document routes redirect home while valid portals, API responses, assets and traversal protections remain', async () => {
  for (const route of ['/', '/rider', '/admin']) { const response = await fetch(base() + route, { redirect: 'manual' }); assert.equal(response.status, 200, `${route} remains available`); assert.match(response.headers.get('content-type') || '', /text\/html/); }
  for (const route of ['/this-route-does-not-exist', '/bad%']) { const response = await fetch(base() + route, { redirect: 'manual' }); assert.equal(response.status, 302, `${route} returns to the homepage`); assert.equal(response.headers.get('location'), '/'); }
  const missingAsset = await fetch(base() + '/missing-style.css', { redirect: 'manual' }); assert.equal(missingAsset.status, 404);
  const missingApi = await fetch(base() + '/api/not-a-real-endpoint', { redirect: 'manual' }); assert.equal(missingApi.status, 404); assert.equal(missingApi.headers.get('location'), null); assert.equal((await missingApi.json()).code, 'NOT_FOUND');
  const traversal = await fetch(base() + '/..%2fserver.mjs', { redirect: 'manual' }); assert.equal(traversal.status, 403);
});
