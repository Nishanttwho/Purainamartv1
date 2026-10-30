import test from 'node:test';
import assert from 'node:assert/strict';
import { createMongoCodOrder } from '../lib/mongodb-cod-checkout.mjs';

function makeFixture({ stock = 2, cartItems = [{ productId: 'p1', quantity: 1, name: 'Test item' }] } = {}) {
  const docs = {
    carts: [{ ownerId: 'u1', items: structuredClone(cartItems) }],
    products: [{ id: 'p1', name: 'Test item', stock, isActive: true, variants: [] }],
    orders: [], coupons: [], rewards: [], notifications: [], notificationOutbox: [], shoppingPreferences: []
  };
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => match(row, part));
    if (key === '$expr') return true;
    const actual = row[key];
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(actual);
    if (value && typeof value === 'object' && '$gte' in value) return actual >= value.$gte;
    if (value && typeof value === 'object' && '$ne' in value) return actual !== value.$ne;
    if (value && typeof value === 'object' && '$exists' in value) return (key in row) === value.$exists;
    if (value && typeof value === 'object' && '$elemMatch' in value) return (actual || []).some(child => match(child, value.$elemMatch));
    return actual === value;
  });
  const db = { collection(name) { return {
    async findOne(filter) { return structuredClone(docs[name].find(row => match(row, filter)) || null); },
    find(filter) { return { toArray: async () => structuredClone(docs[name].filter(row => match(row, filter))) }; },
    async updateOne(filter, update) {
      const row = docs[name].find(candidate => match(candidate, filter));
      if (!row) return { modifiedCount: 0 };
      for (const [path, amount] of Object.entries(update.$inc || {})) {
        if (path === 'stock') row.stock += amount;
        else if (path.startsWith('variants.')) throw new Error('Array filter fixture not needed here.');
        else row[path] = Number(row[path] || 0) + amount;
      }
      if (update.$set) Object.assign(row, structuredClone(update.$set));
      if (update.$push) for (const [path, value] of Object.entries(update.$push)) (row[path] ||= []).push(structuredClone(value));
      return { modifiedCount: 1 };
    },
    async countDocuments(filter) { return docs[name].filter(row => match(row, filter)).length; },
    async insertOne(row) { if (name === 'orders' && docs.orders.some(item => item.userId === row.userId && item.idempotencyKey === row.idempotencyKey)) throw Object.assign(new Error('duplicate key'), { code: 11000 }); docs[name].push(structuredClone(row)); },
    async insertMany(rows) { docs[name].push(...structuredClone(rows)); },
    async deleteOne(filter) { const at = docs[name].findIndex(row => match(row, filter)); if (at < 0) return { deletedCount: 0 }; docs[name].splice(at, 1); return { deletedCount: 1 }; }
  }; } };
  const client = { startSession: () => ({
    async withTransaction(fn) {
      const snapshot = structuredClone(docs);
      try { await fn(); } catch (error) { for (const key of Object.keys(docs)) docs[key] = snapshot[key]; throw error; }
    },
    async endSession() {}
  }) };
  return { db, client, docs };
}

function buildOrder({ userId, products }) {
  return { order: { id: 'o1', idempotencyKey: 'checkout-request-key-0001', userId, items: products.map(product => ({ id: product.id, name: product.name, price: 10, quantity: 1 })), paymentMethod: 'Cash on delivery', paymentStatus: 'Pay on delivery' } };
}

test('Mongo COD checkout deducts stock, persists order and clears cart in one session', async () => {
  const fixture = makeFixture();
  const result = await createMongoCodOrder({ ...fixture, userId: 'u1', idempotencyKey: 'checkout-request-key-0001', buildOrder });
  assert.equal(result.status, 201);
  assert.equal(fixture.docs.products[0].stock, 1);
  assert.equal(fixture.docs.orders.length, 1);
  assert.equal(fixture.docs.carts.length, 0);
});

test('Mongo COD checkout rejects insufficient stock and leaves no partial order or cart mutation', async () => {
  const fixture = makeFixture({ stock: 0 });
  const result = await createMongoCodOrder({ ...fixture, userId: 'u1', idempotencyKey: 'checkout-request-key-0001', buildOrder });
  assert.equal(result.status, 409);
  assert.equal(fixture.docs.products[0].stock, 0);
  assert.equal(fixture.docs.orders.length, 0);
  assert.equal(fixture.docs.carts.length, 1);
});

test('Mongo COD checkout replays an existing idempotency key without another deduction', async () => {
  const fixture = makeFixture();
  fixture.docs.orders.push({ id: 'prior', idempotencyKey: 'checkout-request-key-0001', userId: 'u1' });
  const result = await createMongoCodOrder({ ...fixture, userId: 'u1', idempotencyKey: 'checkout-request-key-0001', buildOrder });
  assert.equal(result.status, 200);
  assert.equal(result.body.idempotentReplay, true);
  assert.equal(fixture.docs.products[0].stock, 2);
});

test('Mongo COD checkout enforces per-customer coupon limits transactionally', async () => {
  const fixture = makeFixture();
  fixture.docs.coupons.push({ code: 'FIRST', isActive: true, minimum: 0, maxRedemptionsPerCustomer: 1 });
  fixture.docs.couponRedemptions = [{ couponCode: 'FIRST', userId: 'u1', orderId: 'old-order' }];
  const result = await createMongoCodOrder({ ...fixture, userId: 'u1', idempotencyKey: 'checkout-coupon-request-0001', buildOrder: ({ userId, products }) => ({ couponCode: 'FIRST', order: { id: 'new-order', idempotencyKey: 'checkout-coupon-request-0001', userId, couponCode: 'FIRST', subtotal: 10, discount: 2, items: products.map(product => ({ ...product, quantity: 1 })), paymentMethod: 'Cash on delivery', paymentStatus: 'Pay on delivery' } }) });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /maximum number of times/);
  assert.equal(fixture.docs.products[0].stock, 2);
  assert.equal(fixture.docs.orders.length, 0);
  assert.equal(fixture.docs.coupons[0].redemptionCount, undefined);
});

test('Mongo COD reward with remaining redemptions stays available and records the order', async () => {
  const fixture = makeFixture();
  fixture.docs.rewards.push({ id: 'reward-1', userId: 'u1', status: 'available', redemptionCount: 0, redemptionLimit: 2 });
  const now = new Date('2026-10-30T00:00:00.000Z');
  const result = await createMongoCodOrder({ ...fixture, now, userId: 'u1', idempotencyKey: 'checkout-reward-request-001', buildOrder: ({ userId, products }) => ({ rewardId: 'reward-1', order: { id: 'reward-order', idempotencyKey: 'checkout-reward-request-001', userId, items: products.map(product => ({ ...product, quantity: 1 })), paymentMethod: 'Cash on delivery', paymentStatus: 'Pay on delivery' } }) });
  assert.equal(result.status, 201);
  assert.equal(fixture.docs.rewards[0].status, 'available');
  assert.equal(fixture.docs.rewards[0].redemptionCount, 1);
  assert.deepEqual(fixture.docs.rewards[0].redemptionHistory, [{ orderId: 'reward-order', redeemedAt: now, status: 'redeemed' }]);
});
