import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BSON } from 'mongodb';

// Verification only: no initialization, workers, index creation, or commits.
export function rollbackGuard(client, database) {
  const sessions = new WeakSet(), collections = new Map();
  const startSession = client.startSession.bind(client);
  client.startSession = (...args) => {
    const session = startSession(...args);
    sessions.add(session);
    session.commitTransaction = async () => { throw new Error('Verification transactions must never commit'); };
    return session;
  };
  const reads = new Set(['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'listIndexes', 'distinct']);
  const writes = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'bulkWrite']);
  const db = new Proxy(database, { get(target, name) {
    if (name === 'collection') return collectionName => {
      if (!collections.has(collectionName)) {
        const collection = target.collection(collectionName);
        collections.set(collectionName, new Proxy(collection, { get(object, method) {
          if (reads.has(method)) return object[method].bind(object);
          if (method === 'aggregate') return (pipeline, options) => {
            assert.ok(!/"\$(out|merge)"\s*:/.test(JSON.stringify(pipeline)), 'Write aggregation forbidden');
            return object.aggregate(pipeline, options);
          };
          if (writes.has(method)) return (...args) => {
            const session = args.at(-1)?.session;
            assert.ok(session && sessions.has(session) && session.inTransaction(), 'Every write requires an active rollback-only session');
            return object[method](...args);
          };
          if (typeof object[method] === 'function') return () => { throw new Error('Unsupported verification collection operation'); };
          return object[method];
        } }));
      }
      return collections.get(collectionName);
    };
    if (name === 'command') return command => {
      assert.deepEqual(Object.keys(command), ['ping']);
      return target.command(command);
    };
    if (name === 'listCollections') return target.listCollections.bind(target);
    if (typeof target[name] === 'function') return () => { throw new Error('Database administration forbidden during verification'); };
    return target[name];
  } });
  return db;
}

// Store only digests and counts; never retain customer records or credentials.
export async function databaseSnapshot(db) {
  const result = {};
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    if (name.startsWith('system.')) continue;
    const count = await db.collection(name).estimatedDocumentCount();
    assert.ok(count <= 10000, 'Verification snapshot exceeds the bounded small-database budget');
    const hash = crypto.createHash('sha256');
    let documents = 0;
    for await (const row of db.collection(name).find({}).sort({ _id: 1 })) {
      hash.update(BSON.EJSON.stringify(row, { relaxed: false }));
      documents++;
    }
    result[name] = { count: documents, sha256: hash.digest('hex') };
  }
  return result;
}
