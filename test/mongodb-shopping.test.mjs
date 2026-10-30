import test from 'node:test';
import assert from 'node:assert/strict';
import { addMongoWishlistItem, deleteMongoAddress, listMongoAddresses, listMongoCart, mergeMongoGuestData, saveMongoAddress, setMongoCartQuantity } from '../lib/mongodb-shopping.mjs';

test('address reads, updates and deletes are always scoped to the customer owner', async () => {
  const calls = [];
  const db = { collection: name => {
    assert.equal(name, 'addresses');
    return {
      find: filter => { calls.push(['find', filter]); return { sort: () => ({ toArray: async () => [] }) }; },
      updateOne: async (filter, update, options) => { calls.push(['update', filter, update, options]); return { upsertedCount: 1 }; },
      deleteOne: async filter => { calls.push(['delete', filter]); return { deletedCount: 0 }; }
    };
  } };
  await listMongoAddresses(db, 'customer-a');
  await saveMongoAddress(db, 'customer-a', { id: 'address-1', line1: 'fixture' });
  await deleteMongoAddress(db, 'customer-a', 'address-1');
  assert.deepEqual(calls[0][1], { customerId: 'customer-a' });
  assert.deepEqual(calls[1][1], { customerId: 'customer-a', id: 'address-1' });
  assert.deepEqual(calls[2][1], { customerId: 'customer-a', id: 'address-1' });
  assert.equal(calls[1][2].$set.customerId, 'customer-a');
});

test('cart loading is owner-scoped and malformed product IDs cannot be written', async () => {
  const calls = [];
  const db = { collection: name => ({
    findOne: async filter => { calls.push([name, filter]); return null; }
  }) };
  assert.deepEqual(await listMongoCart(db, 'guest:opaque-id'), { ownerId: 'guest:opaque-id', version: 0, items: [] });
  assert.deepEqual(calls[0], ['carts', { ownerId: 'guest:opaque-id' }]);
  const invalid = await setMongoCartQuantity(db, 'customer-a', { productId: '../secret', quantity: 1 });
  assert.ok(invalid.error);
  assert.equal(calls.length, 1);
});

test('wishlist insertion requires an active product and uses owner-scoped atomic add', async () => {
  const calls = [];
  const db = { collection: name => ({
    findOne: async filter => { calls.push(['findOne', name, filter]); return name === 'products' ? { id: 'p1' } : { ownerId: 'customer-a', productIds: ['p1'] }; },
    updateOne: async (filter, update, options) => { calls.push(['updateOne', name, filter, update, options]); return { upsertedCount: 1 }; }
  }) };
  const result = await addMongoWishlistItem(db, 'customer-a', 'p1');
  assert.deepEqual(result.productIds, ['p1']);
  assert.deepEqual(calls[1], ['updateOne', 'wishlists', { ownerId: 'customer-a' }, calls[1][3], { upsert: true }]);
  assert.deepEqual(calls[1][3].$addToSet, { productIds: 'p1' });
});

test('login guest merge combines cart and wishlist while preserving a customer coupon choice', async () => {
  const rows = {
    carts: [
      { ownerId: 'customer-a', version: 2, items: [{ productId: 'p1', quantity: 2 }] },
      { ownerId: 'guest:visitor-123456789012345678901234', version: 1, items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }] }
    ],
    wishlists: [
      { ownerId: 'customer-a', productIds: ['p1'] },
      { ownerId: 'guest:visitor-123456789012345678901234', productIds: ['p1', 'p2'] }
    ],
    shoppingPreferences: [{ ownerId: 'customer-a', couponCode: 'CUSTOMER' }, { ownerId: 'guest:visitor-123456789012345678901234', areaId: 'area-1' }]
  };
  const db = { collection(name) {
    return {
      async findOne(filter) { return structuredClone(rows[name].find(row => Object.entries(filter).every(([key, value]) => row[key] === value)) || null); },
      async updateOne(filter, update, options = {}) {
        let row = rows[name].find(item => Object.entries(filter).every(([key, value]) => item[key] === value));
        if (!row && options.upsert) { row = { ...filter }; rows[name].push(row); }
        if (!row) return { matchedCount: 0 };
        Object.assign(row, update.$set || {});
        Object.assign(row, update.$setOnInsert || {});
        if (update.$inc) for (const [key, value] of Object.entries(update.$inc)) row[key] = (row[key] || 0) + value;
        return { matchedCount: 1, upsertedCount: 0 };
      },
      async deleteOne(filter) {
        const index = rows[name].findIndex(row => Object.entries(filter).every(([key, value]) => row[key] === value));
        if (index < 0) return { deletedCount: 0 };
        rows[name].splice(index, 1);
        return { deletedCount: 1 };
      }
    };
  } };

  await mergeMongoGuestData(db, 'customer-a', 'guest:visitor-123456789012345678901234');
  assert.deepEqual(rows.carts.find(row => row.ownerId === 'customer-a').items, [
    { productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 1 }
  ]);
  assert.deepEqual(rows.wishlists.find(row => row.ownerId === 'customer-a').productIds, ['p1', 'p2']);
  assert.equal(rows.shoppingPreferences.find(row => row.ownerId === 'customer-a').couponCode, 'CUSTOMER');
  assert.equal(rows.shoppingPreferences.find(row => row.ownerId === 'customer-a').areaId, 'area-1');
  assert.equal(rows.carts.some(row => row.ownerId.startsWith('guest:')), false);
  assert.equal(rows.wishlists.some(row => row.ownerId.startsWith('guest:')), false);
});
