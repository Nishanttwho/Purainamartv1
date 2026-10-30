import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validatePricingVariants, toMoneyCents } from './product-pricing.mjs';

export const catalogueHash = value => crypto.createHash('sha256').update(value).digest('hex');
const demo = row => /demo listing|sample product|placeholder|test product/i.test([row.name, row.description, row.detail].join(' '));
const sameSourceFields = (source, target) => Boolean(target && Object.entries(source).every(([key, value]) => isDeepStrictEqual(value, target[key])));

export async function inspectCatalogueImages(record, publicDir) {
  const references = [...new Set([record.image, record.thumbnail, record.thumbnailSource, ...(Array.isArray(record.images) ? record.images : [])].filter(Boolean))];
  const results = [];
  for (const reference of references) {
    if (typeof reference !== 'string' || !reference.startsWith('/assets/')) {
      results.push({ reference, status: 'unverified_remote_or_invalid_reference' }); continue;
    }
    let file;
    try { file = path.resolve(publicDir, '.' + decodeURIComponent(reference)); } catch { results.push({ reference, status: 'invalid_reference' }); continue; }
    const assets = path.resolve(publicDir, 'assets');
    if (!file.startsWith(assets + path.sep)) { results.push({ reference, status: 'outside_assets' }); continue; }
    try {
      const resolved = await fs.realpath(file);
      if (!resolved.startsWith(await fs.realpath(assets) + path.sep)) throw new Error('outside assets');
      const data = await fs.readFile(resolved);
      if (!data.length) throw new Error('empty image');
      results.push({ reference, status: 'present', bytes: data.length, sha256: catalogueHash(data) });
    } catch { results.push({ reference, status: 'missing_or_unreadable' }); }
  }
  return results;
}

export async function planCatalogueImport(store, { verifiedProductIds = [], publicDir }) {
  const products = Array.isArray(store.products) ? store.products : [], categories = Array.isArray(store.categories) ? store.categories : [];
  const verified = new Set(verifiedProductIds), selectedProducts = [], excludedProducts = [], blockers = [], warnings = [];
  for (const [name, rows] of [['products', products], ['categories', categories]]) {
    const seen = new Set();
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) blockers.push(`${name}: missing or duplicate ID`);
      seen.add(row.id);
    }
  }
  const categoriesById = new Map(categories.map(row => [row.id, row]));
  for (const product of products) {
    const issues = [];
    if (!String(product.name || '').trim()) issues.push('missing name');
    if (!String(product.description || '').trim()) issues.push('missing description');
    if (!String(product.image || '').trim()) issues.push('missing primary image');
    if (!categoriesById.has(product.category)) issues.push('category does not exist');
    if (typeof product.price !== 'number' || toMoneyCents(product.price) == null || product.price <= 0) issues.push('invalid price');
    if (!Number.isSafeInteger(product.stock) || product.stock < 0) issues.push('invalid stock');
    if (product.saleType && product.saleType !== 'legacy') {
      const pricing = validatePricingVariants(product.saleType, product.measurementUnit, product.variants);
      if (pricing.error) issues.push(pricing.error);
    } else if (product.variants?.length) issues.push('variants without packed/loose sale type');
    if (product.mrp != null && (typeof product.mrp !== 'number' || product.mrp < product.price)) issues.push('invalid MRP');
    const images = await inspectCatalogueImages(product, publicDir);
    if (images.some(row => row.status !== 'present')) issues.push('image references need verification');
    const reason = demo(product) ? 'Explicit demo/test/placeholder marker in the original record' : !verified.has(product.id) ? 'Authenticity not verified; development seed origin is not proof of a genuine listing' : issues.length ? 'Incomplete or invalid original record: ' + issues.join('; ') : null;
    if (reason) excludedProducts.push({ id: product.id, name: product.name, price: product.price, reason, issues, images });
    else selectedProducts.push({ document: structuredClone(product), images, authenticity: 'User explicitly confirmed the saved listing as genuine in this chat' });
    if (product.saleType === 'loose' && product.variants?.some(row => row.stock > product.stock)) warnings.push({ id: product.id, issue: 'One or more tier stock ceilings exceed shared stock; source values are not changed' });
  }
  for (const id of verified) if (!products.some(row => row.id === id)) blockers.push(`Verified product ${id} is absent from the source`);
  const selectedCategoryIds = new Set();
  function includeCategory(id, chain = new Set()) {
    if (chain.has(id)) { blockers.push('Category parent cycle'); return; }
    const category = categoriesById.get(id);
    if (!category) { blockers.push(`Missing related category ${id}`); return; }
    if (selectedCategoryIds.has(id)) return;
    if (category.parentId) includeCategory(category.parentId, new Set([...chain, id]));
    selectedCategoryIds.add(id);
  }
  for (const product of selectedProducts) includeCategory(product.document.category);
  const selectedCategories = [];
  for (const id of selectedCategoryIds) {
    const category = categoriesById.get(id), images = await inspectCatalogueImages(category, publicDir);
    if (!String(category.name || '').trim()) blockers.push(`Category ${id} has no name`);
    if (images.some(row => row.status !== 'present')) blockers.push(`Category ${id} has an unverified image`);
    selectedCategories.push({ document: structuredClone(category), images });
  }
  const excludedCategories = categories.filter(row => !selectedCategoryIds.has(row.id)).map(row => ({ id: row.id, name: row.name, reason: row.id === 'all' ? 'Virtual All filter; not a product category relationship' : 'No verified selected product refers to this category' }));
  return { selectedProducts, selectedCategories, excludedProducts, excludedCategories, blockers, warnings, sourceCounts: { products: products.length, categories: categories.length } };
}

export function requireCatalogueTarget(db) {
  if (db.databaseName !== 'purainamart') throw new Error('Catalogue target must be exactly purainamart');
}
export async function inspectCatalogueTarget(db, plan, options = {}) {
  requireCatalogueTarget(db);
  const actions = {};
  for (const [name, selected] of [['categories', plan.selectedCategories], ['products', plan.selectedProducts]]) {
    actions[name] = [];
    for (const { document } of selected) {
      const existing = await db.collection(name).find({ id: document.id }, { ...options, projection: { _id: 0 } }).limit(2).toArray();
      if (existing.length > 1) throw new Error(`Duplicate target ${name} ID: ${document.id}`);
      const row = existing[0];
      const matches = sameSourceFields(document, row) && !(name === 'categories' && document.isActive !== false && row?.isActive === false);
      actions[name].push({ id: document.id, name: document.name, action: !row ? 'insert' : matches ? 'keep_existing_identical_source_fields' : 'keep_existing_different', existing: row || null });
    }
  }
  return { database: db.databaseName, counts: { products: await db.collection('products').countDocuments({}, options), categories: await db.collection('categories').countDocuments({}, options) }, actions };
}

export async function importCatalogueInsertOnly(db, client, plan) {
  requireCatalogueTarget(db);
  if (plan.blockers.length || !plan.selectedProducts.length) throw new Error('Catalogue selection is blocked or empty');
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const before = await inspectCatalogueTarget(db, plan, { session });
      if (before.actions.categories.some(row => row.action === 'keep_existing_different')) throw new Error('Existing category differs from the original; no records were changed');
      const inserted = { products: [], categories: [] };
      for (const [name, selected] of [['categories', plan.selectedCategories], ['products', plan.selectedProducts]]) {
        for (const { document } of selected) {
          const prior = before.actions[name].find(row => row.id === document.id);
          if (prior.existing) continue;
          const write = await db.collection(name).updateOne({ id: document.id }, { $setOnInsert: structuredClone(document) }, { session, upsert: true });
          const saved = await db.collection(name).findOne({ id: document.id }, { session, projection: { _id: 0 } });
          if (!sameSourceFields(document, saved)) throw new Error(`Concurrent ${name} conflict; transaction aborted`);
          if (write.upsertedCount) inserted[name].push(document.id);
        }
      }
      // Verify both newly inserted payloads and untouched pre-existing records.
      for (const name of ['categories', 'products']) for (const prior of before.actions[name]) {
        if (prior.existing) {
          const saved = await db.collection(name).findOne({ id: prior.id }, { session, projection: { _id: 0 } });
          if (!isDeepStrictEqual(prior.existing, saved)) throw new Error('An existing record changed during import; transaction aborted');
        }
      }
      return { database: db.databaseName, inserted, keptExistingProducts: before.actions.products.filter(row => row.existing).map(({ id, action }) => ({ id, action })), updatedRecords: 0, deletedRecords: 0 };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
  } finally { await session.endSession(); }
}
