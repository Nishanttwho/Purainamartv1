import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLegacyStoreToMongo, validateMappedMongoData } from '../lib/mongodb-migration.mjs';

test('legacy blank unique identities normalize and real conflicts fail before connecting', () => {
  const mapped = mapLegacyStoreToMongo({ users: [{ id: 'u1', email: '', googleSub: '' }, { id: 'u2', email: '  ' }] });
  assert.equal(mapped.importable, true);
  assert.equal('email' in mapped.collections.users[0], false);
  const conflict = mapLegacyStoreToMongo({ users: [{ id: 'u1', email: 'SAME@example.test' }, { id: 'u2', email: 'same@example.test' }] });
  assert.equal(conflict.importable, false);
  assert.ok(conflict.validation.duplicates.some(row => row.reason.includes('email')));
  assert.equal(JSON.stringify(conflict.validation).includes('example.test'), false);
});
test('invalid legacy schema values and missing identities block import without altering source', () => {
  const source = { riders: [{ id: 'r1', phone: '9000000000', isActive: 'yes' }], users: [{}] }, copy = structuredClone(source);
  const report = mapLegacyStoreToMongo(source);
  assert.equal(report.importable, false);
  assert.ok(report.validation.invalidFields.some(row => row.field === 'isActive'));
  assert.ok(report.validation.incompleteDocuments.some(row => row.reason === 'missing_id'));
  assert.deepEqual(source, copy);
});

test('legacy data maps to Mongo collections while sessions are deliberately omitted', () => {
  const mapped = mapLegacyStoreToMongo({
    users: [{ id: 'u1' }], categories: [{ id: 'c1', name: 'Fruit' }],
    products: [{ id: 'p1', category: 'c1', name: 'Pear', price: 2, stock: 3 }],
    sessions: { rawSessionSecret: { userId: 'u1' } }, carts: { u1: { p1: 2 } },
    variantCarts: { u1: { p1: { v1: 1 } } }, addresses: { u1: [{ id: 'a1' }] },
    orders: [{ id: 'o1', userId: 'u1', status: 'Delivered', items: [], paymentMethod: 'Legacy UPI', paymentStatus: 'Historical status' }],
    coupons: { C1: { code: 'C1' } },
  });
  assert.equal(mapped.collections.sessions.length, 0);
  assert.equal(mapped.skipped.sessionLikeRecords, 1);
  assert.deepEqual(mapped.collections.carts[0].items, [{ productId: 'p1', quantity: 2 }, { productId: 'p1', variantId: 'v1', quantity: 1 }]);
  assert.equal(mapped.collections.addresses[0].customerId, 'u1');
  assert.equal(mapped.collections.orders[0].paymentMethod, 'Legacy UPI');
  assert.equal(mapped.validation.valid, true);
});

test('suspected demo products are excluded and reported instead of imported as genuine catalogue records', () => {
  const mapped = mapLegacyStoreToMongo({
    categories: [{ id: 'c1', name: 'Fruit' }],
    products: [{ id: 'p1', category: 'c1', name: 'Demo listing for local browsing', price: 1, stock: 1 }]
  });
  assert.equal(mapped.collections.products.length, 0);
  assert.equal(mapped.skipped.suspectedDemoProducts, 1);
});

test('migration validation reports duplicate IDs and broken references without record contents', () => {
  const report = validateMappedMongoData({
    users: [], categories: [], products: [{ id: 'p1', categoryId: 'missing', name: 'Pear', price: 2, stock: 3 }],
    orders: [{ id: 'o1', userId: 'missing', status: 'Delivered', paymentMethod: 'Cash on delivery', paymentStatus: 'Collected', items: [] }, { id: 'o1', userId: 'missing', status: 'Delivered', paymentMethod: 'Cash on delivery', paymentStatus: 'Collected', items: [] }], addresses: [{ id: 'a1', customerId: 'missing' }]
  });
  assert.equal(report.valid, false);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.brokenCategoryReferences, 1);
  assert.equal(report.brokenOrderCustomers, 2);
  assert.equal(report.brokenAddressCustomers, 1);
  assert.equal(JSON.stringify(report).includes('missing'), false);
});
