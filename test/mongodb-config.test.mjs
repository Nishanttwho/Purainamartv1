import test from 'node:test';
import assert from 'node:assert/strict';
import { closeMongo, ensureMongoIndexes, initializeMongo, mongoConnectionOptions, mongoCollectionIndexes, mongoCollectionSchemas, mongoReady } from '../lib/mongodb.mjs';

const uri = 'mongodb://user:password@localhost:27017/purainamart?authSource=admin';

test('shutdown while connecting waits and closes the shared client exactly once', async () => {
  let finish, closes = 0;
  class PendingClient {
    async connect() { await new Promise(resolve => { finish = resolve; }); }
    db() { return { command: async command => command.hello ? { setName: 'mock' } : {}, listCollections: () => ({ hasNext: async () => false }), createCollection: async () => {}, collection: () => ({ createIndex: async () => {} }) }; }
    async close() { closes++; }
  }
  const pending = initializeMongo({ env: { MONGODB_URI: uri }, MongoClientClass: PendingClient, logger: {} });
  const firstClose = closeMongo(), secondClose = closeMongo();
  finish(); await Promise.all([pending, firstClose, secondClose]);
  assert.equal(closes, 1); assert.equal(mongoReady(), false);
});

test('Mongo URI must explicitly select the application database', () => {
  assert.equal(mongoConnectionOptions({ MONGODB_URI: uri }).dbName, 'purainamart');
  for (const invalid of [undefined, '', 'postgresql://localhost/purainamart', 'mongodb://localhost:27017/admin']) {
    assert.throws(() => mongoConnectionOptions({ MONGODB_URI: invalid }), error => !error.message.includes('password'));
  }
});

test('Mongo indexes are created from the centralized collection definitions', async () => {
  const created = [], collections = [];
  await ensureMongoIndexes({
    listCollections: () => ({ hasNext: async () => false }),
    createCollection: async (name, options) => { collections.push({ name, options }); },
    collection: name => ({ createIndex: async (keys, options) => { created.push({ name, keys, options }); return options.name; } })
  });
  assert.equal(collections.length, Object.keys(mongoCollectionSchemas).length);
  assert.equal(collections.find(row => row.name === 'orders').options.validator.$jsonSchema.properties.paymentMethod.bsonType, 'string');
  assert.equal(created.length, Object.values(mongoCollectionIndexes).reduce((sum, list) => sum + list.length, 0));
  assert.ok(created.some(index => index.name === 'orders' && index.options.name === 'orders_idempotency_unique'));
  assert.ok(created.some(index => index.name === 'sessions' && index.options.expireAfterSeconds === 0));
});

test('Mongo initialization is shared, pings before readiness, and closes cleanly', async () => {
  let connects = 0, closes = 0, pings = 0, indexCount = 0;
  class MockClient {
    constructor(receivedUri, options) { assert.equal(receivedUri, uri); assert.equal(options.maxPoolSize, 20); }
    async connect() { connects++; }
    db(name) {
      assert.equal(name, 'purainamart');
      return {
        command: async command => {
          if (command.ping) { pings++; return { ok: 1 }; }
          if (command.hello) return { ok: 1, setName: 'replica0' };
          throw new Error('unexpected command');
        },
        listCollections: () => ({ hasNext: async () => false }),
        createCollection: async () => {},
        collection: () => ({ createIndex: async () => { indexCount++; } })
      };
    }
    async close() { closes++; }
  }
  const [a, b] = await Promise.all([
    initializeMongo({ env: { MONGODB_URI: uri }, MongoClientClass: MockClient, logger: {} }),
    initializeMongo({ env: { MONGODB_URI: uri }, MongoClientClass: MockClient, logger: {} })
  ]);
  assert.strictEqual(a, b);
  assert.equal(connects, 1);
  assert.equal(pings, 1);
  assert.equal(indexCount, Object.values(mongoCollectionIndexes).reduce((sum, list) => sum + list.length, 0));
  assert.equal(mongoReady(), true);
  await closeMongo();
  assert.equal(closes, 1);
  assert.equal(mongoReady(), false);
});

test('Mongo initialization rejects standalone topology before creating indexes', async () => {
  let closed = 0, created = 0;
  class StandaloneClient {
    async connect() {}
    db() { return { command: async command => command.ping ? { ok: 1 } : { ok: 1, isWritablePrimary: true }, createCollection: async () => { created++; }, listCollections: () => ({ hasNext: async () => false }), collection: () => ({ createIndex: async () => {} }) }; }
    async close() { closed++; }
  }
  await assert.rejects(initializeMongo({ env: { MONGODB_URI: uri }, MongoClientClass: StandaloneClient, logger: {} }), /replica set or sharded cluster/);
  assert.equal(created, 0);
  assert.equal(closed, 1);
});
