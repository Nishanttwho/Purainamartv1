import test from 'node:test';
import assert from 'node:assert/strict';
import { createMongoCategory, createMongoProduct, deactivateMongoCategory, deactivateMongoProduct, listMongoCategories, listMongoProducts, updateMongoCategory, updateMongoProduct } from '../lib/mongodb-catalogue.mjs';

function collectionStub(rows, capture) {
  return {
    countDocuments: async () => rows.length,
    find(filter) {
      capture.filter = filter;
      const cursor = { sort(sort) { capture.sort = sort; return cursor; }, skip() { return cursor; }, limit() { return cursor; }, toArray: async () => rows }; return cursor;
    }
  };
}

test('catalogue product query limits to active, sellable inventory and maps frontend contract', async () => {
  const capture = {};
  const db = { collection: name => { assert.equal(name, 'products'); return collectionStub([{ _id: 'mongo-id', id: 'p1', name: 'Pear', stock: 2 }, { id: 'p2', data: { id: 'p2', name: 'Apple' } }], capture); } };
  const result = await listMongoProducts(db, { category: 'fruit' });
  assert.equal(capture.filter.isActive.$ne, false);
  assert.equal(capture.filter.category, 'fruit');
  assert.deepEqual(capture.filter.$or[1].variants.$elemMatch, { isActive: { $ne: false }, stock: { $gt: 0 } });
  assert.deepEqual(capture.sort, { position: 1, rank: 1, id: 1 });
  assert.deepEqual(result, { products: [{ id: 'p1', name: 'Pear', stock: 2 }, { id: 'p2', name: 'Apple' }], count: 2, offset: 0, limit: 100 });
});

test('catalogue search treats user input literally and preserves the all-category filter', async () => {
  const capture = {};
  const db = { collection: () => collectionStub([], capture) };
  await listMongoProducts(db, { search: 'x.*[y' });
  assert.equal(capture.filter.category, undefined);
  const term = capture.filter.$and[0].$or[0].name;
  assert.equal(term.test('x.*[y'), true);
  assert.equal(term.test('xxxxxxy'), false);
});

test('category query preserves active/all semantics and response shape', async () => {
  const capture = {};
  const db = { collection: name => { assert.equal(name, 'categories'); return collectionStub([{ _id: 'id', id: 'all' }, { id: 'fresh', isActive: true }], capture); } };
  const result = await listMongoCategories(db);
  assert.deepEqual(capture.filter, { $or: [{ id: 'all' }, { isActive: { $ne: false } }] });
  assert.deepEqual(result, { categories: [{ id: 'all' }, { id: 'fresh', isActive: true }] });
});

test('Mongo admin catalogue writes preserve category relationships and soft-delete products', async () => {
  const inserted = [], updated = [];
  const db = { collection: name => ({
    findOne: async filter => name === 'categories' && filter.id === 'fruit' ? { id: 'fruit', isActive: true } : null,
    insertOne: async document => inserted.push([name, structuredClone(document)]),
    findOneAndUpdate: async (filter, update, options) => { updated.push([name, filter, update, options]); return { value: { id: filter.id, ...update.$set } }; }
  }) };
  const product = await createMongoProduct(db, { id: 'p1', name: 'Pear', category: 'fruit', price: 10, stock: 4 });
  assert.equal(product.categoryId, undefined);
  assert.equal(inserted[0][1].categoryId, 'fruit');
  const changed = await updateMongoProduct(db, 'p1', { price: 11 });
  assert.equal(changed.price, 11);
  await deactivateMongoProduct(db, 'p1');
  assert.equal(updated.at(-1)[2].$set.isActive, false);
});

test('Mongo category operations protect the all category and active product relationships', async () => {
  let inserted;
  const db = { collection: name => ({
    findOne: async () => name === 'products' ? { id: 'p1' } : null,
    insertOne: async document => { inserted = document; },
    findOneAndUpdate: async (filter, update) => ({ value: { id: filter.id, ...update.$set } })
  }) };
  await createMongoCategory(db, { id: 'fruit', name: 'Fruit' });
  assert.equal(inserted.id, 'fruit');
  await assert.rejects(deactivateMongoCategory(db, 'fruit'), { code: 'CATEGORY_HAS_PRODUCTS' });
  await assert.rejects(updateMongoCategory(db, 'all', { name: 'Everything' }), /all-products/);
});
