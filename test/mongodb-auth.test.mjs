import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomer, createDurableSession, deleteDurableSession, findCustomerByPhone, hashSessionId, resolveDurableSession } from '../lib/mongodb-auth.mjs';

function memoryDb() {
  const docs = { users: [], admins: [], riders: [], sessions: [] };
  return {
    docs,
    collection(name) {
      return {
        async insertOne(document) { docs[name].push(structuredClone(document)); return { insertedId: docs[name].length }; },
        async findOne(filter) {
          const found = docs[name].find(row => Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && '$gt' in value ? row[key] > value.$gt : row[key] === value));
          return found ? structuredClone(found) : null;
        },
        async deleteOne(filter) {
          const index = docs[name].findIndex(row => Object.entries(filter).every(([key, value]) => row[key] === value));
          if (index < 0) return { deletedCount: 0 };
          docs[name].splice(index, 1);
          return { deletedCount: 1 };
        }
      };
    }
  };
}

test('durable sessions store only a hash and resolve to an authorized customer', async () => {
  const db = memoryDb(), token = 'opaque-session-identifier-0123456789';
  await createCustomer(db, { id: 'customer-1', phone: '0000000000', passwordHash: 'argon-hash' });
  assert.equal((await findCustomerByPhone(db, '0000000000')).id, 'customer-1');
  await createDurableSession(db, { sessionId: token, ownerId: 'customer-1', authMethod: 'password', expiresAt: Date.now() + 60_000 });
  assert.equal(db.docs.sessions[0].idHash, hashSessionId(token));
  assert.equal(JSON.stringify(db.docs.sessions[0]).includes(token), false);
  const resolved = await resolveDurableSession(db, { sessionId: token, allowAuthMethods: ['password'] });
  assert.equal(resolved.owner.id, 'customer-1');
  assert.equal(await resolveDurableSession(db, { sessionId: token, allowAuthMethods: ['google'] }), null);
  assert.equal((await deleteDurableSession(db, { sessionId: token })).deletedCount, 1);
  assert.equal(await resolveDurableSession(db, { sessionId: token }), null);
});

test('expired sessions and blocked customers cannot be resolved', async () => {
  const db = memoryDb();
  await createCustomer(db, { id: 'blocked', phone: '0000000001', blockedAt: new Date().toISOString() });
  const token = 'opaque-session-identifier-9876543210';
  await createDurableSession(db, { sessionId: token, ownerId: 'blocked', authMethod: 'password', expiresAt: Date.now() + 60_000 });
  assert.equal(await resolveDurableSession(db, { sessionId: token }), null);
  await assert.rejects(createDurableSession(db, { sessionId: token, ownerId: 'blocked', authMethod: 'password', expiresAt: Date.now() - 1 }), /expiry/);
});
