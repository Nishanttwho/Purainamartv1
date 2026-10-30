import test from 'node:test';
import assert from 'node:assert/strict';
import { closeMongo, initializeMongo, withMongoTransaction } from '../lib/mongodb.mjs';

function fakeClientClass() {
  const calls = { transactionOptions: null, started: 0, ended: 0, callbackRuns: 0 };
  class FakeClient {
    constructor() {}
    async connect() {}
    db() {
      return {
        async command(command) { return command.hello ? { setName: 'test-repl' } : { ok: 1 }; },
        listCollections() { return { async hasNext() { return false; } }; },
        async createCollection() {},
        collection() { return { async createIndex() {} }; }
      };
    }
    startSession() {
      calls.started++;
      return {
        async withTransaction(callback, options) {
          calls.transactionOptions = options;
          calls.callbackRuns++;
          return callback();
        },
        async endSession() { calls.ended++; }
      };
    }
    async close() {}
  }
  return { FakeClient, calls };
}

test('Mongo transaction wrapper requests snapshot reads and majority writes, and always ends sessions', async t => {
  const { FakeClient, calls } = fakeClientClass();
  await initializeMongo({ env: { MONGODB_URI: 'mongodb://localhost/purainamart' }, MongoClientClass: FakeClient, logger: { info() {}, error() {} } });
  t.after(() => closeMongo());

  assert.equal(await withMongoTransaction(async (_db, session) => session === undefined ? 'missing-session' : 'committed'), 'committed');
  assert.deepEqual(calls.transactionOptions, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
  assert.equal(calls.started, 1);
  assert.equal(calls.ended, 1);

  await assert.rejects(withMongoTransaction(async () => { throw new Error('transaction failure'); }), /transaction failure/);
  assert.equal(calls.started, 2);
  assert.equal(calls.ended, 2);
});
