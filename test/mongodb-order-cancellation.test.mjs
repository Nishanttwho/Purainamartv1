import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelMongoCodOrder } from '../lib/mongodb-order-cancellation.mjs';

function fixture({ owner = 'u1', status = 'Order received', stock = 2, marker = false } = {}) {
  const order = { id: 'o1', userId: owner, status, paymentMethod: 'Cash on delivery', paymentStatus: 'Pay on delivery', items: [{ id: 'p1', saleType: 'packed', quantity: 2 }], ...(marker ? { inventoryRestockedAt: 'previously-restored' } : {}) };
  const docs = { orders: [order], products: [{ id: 'p1', stock }], notifications: [], referrals: [] };
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$exists' in value) return (key in row) === value.$exists;
    return row[key] === value;
  });
  const db = { collection: name => ({
    find: query => ({ toArray: async () => structuredClone(docs[name].filter(row => matches(row, query))) }),
    findOne: async query => structuredClone(docs[name].find(row => matches(row, query)) || null),
    async updateOne(query, update) {
      const row = docs[name].find(item => matches(item, query));
      if (!row) return { modifiedCount: 0 };
      if (update.$set) Object.assign(row, structuredClone(update.$set));
      for (const [key, amount] of Object.entries(update.$inc || {})) row[key] += amount;
      return { modifiedCount: 1 };
    },
    async insertMany(rows) { docs[name].push(...structuredClone(rows)); }
  }) };
  const client = { startSession: () => ({
    async withTransaction(fn) { const before = structuredClone(docs); try { await fn(); } catch (error) { for (const key of Object.keys(docs)) docs[key] = before[key]; throw error; } },
    async endSession() {}
  }) };
  return { db, client, docs };
}

test('customer cancellation restores inventory once and writes notification in the transaction', async () => {
  const f = fixture();
  const result = await cancelMongoCodOrder({ ...f, orderId: 'o1', customerId: 'u1', buildNotifications: async order => [{ userId: order.userId, orderId: order.id }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.order.status, 'Cancelled');
  assert.ok(result.body.order.inventoryRestockedAt);
  assert.equal(f.docs.products[0].stock, 4);
  assert.equal(f.docs.notifications.length, 1);
});

test('customer cannot cancel another customer order or restore its inventory', async () => {
  const f = fixture({ owner: 'u2' });
  const result = await cancelMongoCodOrder({ ...f, orderId: 'o1', customerId: 'u1' });
  assert.equal(result.status, 404);
  assert.equal(f.docs.products[0].stock, 2);
});

test('invalid cancellation states and already-restored inventory do not restock', async () => {
  const fulfilled = fixture({ status: 'Picked up' });
  assert.equal((await cancelMongoCodOrder({ ...fulfilled, orderId: 'o1', customerId: 'u1' })).status, 409);
  assert.equal(fulfilled.docs.products[0].stock, 2);
  const restored = fixture({ marker: true });
  const result = await cancelMongoCodOrder({ ...restored, orderId: 'o1', customerId: 'u1' });
  assert.equal(result.status, 200);
  assert.equal(restored.docs.products[0].stock, 2);
});
