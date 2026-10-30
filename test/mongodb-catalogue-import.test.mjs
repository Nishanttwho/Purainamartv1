import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planCatalogueImport, importCatalogueInsertOnly, inspectCatalogueTarget } from '../lib/mongodb-catalogue-import.mjs';
import { fakeMongo } from './support/fake-mongo.mjs';

const publicDir = path.resolve(import.meta.dirname, '../public');
const product = { id: 'verified', name: 'Verified fixture', description: 'Synthetic data for importer tests only', category: 'pantry', price: 62, stock: 10000, saleType: 'loose', measurementUnit: 'g', image: '/assets/customer/puraina/p123-basmati-rice-loose-detail-v1.jpg', variants: [{ id: 'portion', label: '500 g', quantityBase: 500, unit: 'g', price: 31, mrp: null, stock: 10000, isActive: true }] };
const category = { id: 'pantry', name: 'Staples', image: '/assets/customer/zepto-home/categories/staples.webp' };
const input = () => ({ products: [structuredClone(product)], categories: [structuredClone(category)] });
const plan = () => planCatalogueImport(input(), { verifiedProductIds: ['verified'], publicDir });
const target = seed => { const mongo = fakeMongo(seed); mongo.db.databaseName = 'purainamart'; return mongo; };

test('catalogue plan requires positive authenticity and rejects explicit demos even when allowlisted', async () => {
  const store = input(); store.products.push({ ...product, id: 'demo', description: 'Demo listing for local browsing.' }, { ...product, id: 'uncertain' });
  const original = structuredClone(store);
  const selection = await planCatalogueImport(store, { verifiedProductIds: ['verified','demo'], publicDir });
  assert.deepEqual(selection.selectedProducts.map(row => row.document.id), ['verified']);
  assert.deepEqual(selection.selectedProducts[0].document, product);
  assert.deepEqual(selection.selectedCategories[0].document, category);
  assert.equal(selection.excludedProducts.length, 2);
  assert.match(selection.excludedProducts.find(row => row.id === 'demo').reason, /demo/);
  assert.match(selection.excludedProducts.find(row => row.id === 'uncertain').reason, /Authenticity/);
  assert.deepEqual(store, original);
});
test('catalogue plan excludes missing images, invalid variants and broken category references', async () => {
  for (const patch of [{ image: '/assets/not-present-import-test.jpg' }, { category: 'absent' }, { variants: [] }]) {
    const store = input(); Object.assign(store.products[0], patch);
    const selection = await planCatalogueImport(store, { verifiedProductIds: ['verified'], publicDir });
    assert.equal(selection.selectedProducts.length, 0); assert.equal(selection.excludedProducts.length, 1);
  }
});
test('catalogue import preserves payloads and repeats with zero inserts', async () => {
  const f = target(), selected = await plan();
  const first = await importCatalogueInsertOnly(f.db, f.client, selected);
  assert.deepEqual(first.inserted, { categories: ['pantry'], products: ['verified'] });
  assert.deepEqual(f.docs.products, [product]); assert.deepEqual(f.docs.categories, [category]);
  const before = structuredClone(f.docs);
  const again = await importCatalogueInsertOnly(f.db, f.client, selected);
  assert.deepEqual(again.inserted, { products: [], categories: [] }); assert.deepEqual(f.docs, before);
  assert.ok(f.operations.filter(row => row.operation === 'updateOne').every(row => ['products','categories'].includes(row.name)));
  assert.ok(!f.operations.some(row => row.operation.startsWith('delete')));
});
test('catalogue import leaves existing differing and unrelated records exactly unchanged', async () => {
  const prior = { ...product, price: 70, stock: 50, customField: 'preserve me' }, other = { id: 'unrelated', name: 'Untouched' };
  const f = target({ products: [prior, other], categories: [category], orders: [{ id: 'order-untouched' }] });
  const before = structuredClone(f.docs);
  const result = await importCatalogueInsertOnly(f.db, f.client, await plan());
  assert.deepEqual(result.inserted, { products: [], categories: [] }); assert.deepEqual(f.docs, before);
  assert.equal(result.keptExistingProducts[0].action, 'keep_existing_different');
});
test('catalogue import rejects wrong database and category conflicts before writing', async () => {
  const f = target({ categories: [{ ...category, name: 'Different category' }] }), selected = await plan();
  await assert.rejects(importCatalogueInsertOnly(f.db, f.client, selected), /category differs/);
  assert.ok(!f.operations.some(row => row.operation === 'updateOne'));
  f.db.databaseName = 'other';
  await assert.rejects(inspectCatalogueTarget(f.db, selected), /exactly purainamart/);
  await assert.rejects(importCatalogueInsertOnly(f.db, f.client, selected), /exactly purainamart/);
});
test('catalogue import rolls category insertion back when the product write fails and tolerates callback replay', async () => {
  const f = target(), selected = await plan();
  f.failNext('products','updateOne');
  await assert.rejects(importCatalogueInsertOnly(f.db, f.client, selected), /Injected/);
  assert.equal(f.docs.categories?.length || 0, 0); assert.equal(f.docs.products?.length || 0, 0);
  f.retryNextTransaction();
  const result = await importCatalogueInsertOnly(f.db, f.client, selected);
  assert.equal(result.inserted.products.length, 1); assert.equal(f.docs.products.length, 1); assert.equal(f.docs.categories.length, 1);
});
