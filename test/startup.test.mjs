import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startServer } from '../server.mjs';
import { fakeMongo } from './support/fake-mongo.mjs';

test('startup without MongoDB configuration exits clearly before opening a listener', () => {
  const child = spawnSync(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, MONGODB_URI: '', NODE_ENV: 'development' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /MONGODB_URI is required/); assert.doesNotMatch(child.stdout, /listening/);
});
test('startup mock: configured entrypoint serves frontend and closes its one Mongo client once', async t => {
  const f = fakeMongo(), env = { MONGODB_URI: 'mongodb://localhost/purainamart', PORT: '0' }; let opened = 0, closed = 0;
  const app = await startServer({ env, initialize: async () => { opened++; return f.db; }, getClient: async () => f.client, disconnect: async () => { closed++; }, logger: { info() {}, error() {} }, workers: false });
  t.after(() => app.shutdown());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/checkout`); assert.equal(response.status, 200); await response.text();
  await Promise.all([app.shutdown(), app.shutdown()]); assert.equal(opened, 1); assert.equal(closed, 1);
});
test('startup mock: bind failure closes the Mongo connection and stops workers', async t => {
  const f = fakeMongo(), options = { env: { MONGODB_URI: 'mongodb://localhost/purainamart', PORT: '0' }, initialize: async () => f.db, getClient: async () => f.client, disconnect: async () => {}, logger: { info() {}, error() {} } };
  const first = await startServer(options); t.after(() => first.shutdown()); let closed = 0;
  await assert.rejects(startServer({ ...options, env: { ...options.env, PORT: String(first.server.address().port) }, disconnect: async () => { closed++; } }), { code: 'EADDRINUSE' }); assert.equal(closed, 1);
});
