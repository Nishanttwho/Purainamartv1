import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { MIGRATION_VERSION } from '../lib/postgres-store.mjs';
import { configurePostgresPool, normalizePostgresConnectionString } from '../lib/postgres-config.mjs';
import { cloudinaryConfig, isCloudinaryImageUrl } from '../lib/cloudinary.mjs';
import { validatePricingVariants } from '../lib/product-pricing.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const importing = args.includes('--import');
if (dryRun === importing) throw new Error('Choose exactly one mode: --dry-run or --import.');
const argument = name => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || null;
const idSet = (value, fallback) => new Set(String(value || fallback).split(',').map(id => id.trim()).filter(Boolean));
const selectedProductIds = idSet(argument('--product-ids'), 'p123,p125');
const selectedCategoryIds = idSet(argument('--category-ids'), 'all,pantry');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceFile = path.resolve(argument('--file') || path.join(root, 'data', 'store.json'));
const store = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const publicDir = path.join(root, 'public');
const cloud = cloudinaryConfig();
const demoProduct = product => /Demo listing for local browsing\.?$/i.test(String(product?.description || '').trim());
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const categories = Array.isArray(store.categories) ? store.categories : [];
const products = Array.isArray(store.products) ? store.products : [];
const categoryIds = new Set(categories.map(row => String(row?.id || '')));
const errors = [];
const skipped = [];
const duplicateCategoryIds = categories.map(row => row?.id).filter((id, index, all) => !id || all.indexOf(id) !== index);
const duplicateProductIds = products.map(row => row?.id).filter((id, index, all) => !id || all.indexOf(id) !== index);
if (duplicateCategoryIds.length) errors.push({ type: 'duplicate_category_ids', ids: [...new Set(duplicateCategoryIds)] });
if (duplicateProductIds.length) errors.push({ type: 'duplicate_product_ids', ids: [...new Set(duplicateProductIds)] });

const candidates = [];
for (const [position, product] of products.entries()) {
  if (!selectedProductIds.has(String(product?.id || ''))) {
    skipped.push({ id: product?.id || null, name: product?.name || null, reason: 'not in the selected catalogue IDs' });
    continue;
  }
  if (demoProduct(product)) {
    skipped.push({ id: product.id || null, name: product.name || null, reason: 'explicit local demo listing' });
    continue;
  }
  const reasons = [];
  if (!product?.id || !String(product.id).trim()) reasons.push('missing product ID');
  if (!product?.name || !String(product.name).trim()) reasons.push('missing product name');
  if (!categoryIds.has(String(product?.category || ''))) reasons.push('category does not exist in source');
  const price = Number(product?.price), mrp = product?.mrp == null || product.mrp === '' ? null : Number(product.mrp), stock = Number(product?.stock);
  if (!Number.isFinite(price) || price < 0) reasons.push('invalid price');
  if (mrp != null && (!Number.isFinite(mrp) || mrp < price)) reasons.push('MRP is invalid or below price');
  if (mrp == null && product?.saleType !== 'loose') reasons.push('MRP is required for a non-loose product');
  if (!Number.isInteger(stock) || stock < 0 || stock > 2147483647) reasons.push('invalid product stock');
  const image = String(product?.image || '');
  if (image.startsWith('/assets/') && !image.includes('..')) {
    const imagePath = path.resolve(publicDir, `.${image}`);
    if (!imagePath.startsWith(path.join(publicDir, 'assets') + path.sep) || !fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) reasons.push('local image file is missing');
  } else if (!isCloudinaryImageUrl(image, cloud?.cloudName || null)) reasons.push('image must be an existing /assets file or a valid Cloudinary URL');
  if (product?.saleType) {
    const pricing = validatePricingVariants(product.saleType, product.measurementUnit, product.variants);
    if (pricing.error) reasons.push(`invalid pricing variants: ${pricing.error}`);
    if (product.saleType === 'loose' && Array.isArray(product.variants) && product.variants.some(row => Number(row.stock) > stock)) reasons.push('a loose variant stock exceeds product base stock');
  } else if (Array.isArray(product?.variants) && product.variants.length) reasons.push('variants require a saleType');
  if (reasons.length) {
    skipped.push({ id: product?.id || null, name: product?.name || null, reason: reasons.join('; ') });
    continue;
  }
  candidates.push({ position, data: product });
}

for (const item of candidates) if (!selectedCategoryIds.has(String(item.data.category))) errors.push({ type: 'missing_import_category', id: item.data.category });
const selectedCategories = categories.map((data, position) => ({ position, data })).filter(row => selectedCategoryIds.has(String(row.data?.id || '')));
for (const id of selectedCategoryIds) if (!categoryIds.has(id)) errors.push({ type: 'missing_selected_category', id });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for a target-aware catalogue dry run.');
const pool = configurePostgresPool(new Pool({ connectionString: normalizePostgresConnectionString(process.env.DATABASE_URL), max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000, statement_timeout: 12000, application_name: 'purainamart-catalogue-import' }));
let client;
let inTransaction = false;
try {
  client = await pool.connect();
  if (importing) {
    await client.query('BEGIN');
  } else {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  inTransaction = true;
  if (importing) await client.query('SELECT pg_advisory_xact_lock($1)', [1718343473]);
  const target = await client.query("SELECT current_database() AS database, COALESCE((SELECT max(version) FROM schema_migrations),0)::int AS version");
  const databaseName = target.rows[0].database;
  const schemaVersion = Number(target.rows[0].version);
  if (importing && databaseName !== argument('--confirm-target')) throw new Error('Import stopped: --confirm-target must exactly match the connected database name.');

  const categoryRows = selectedCategories.length
    ? await client.query('SELECT id, position, data FROM categories WHERE id = ANY($1::text[])', [selectedCategories.map(row => String(row.data.id))])
    : { rows: [] };
  const productRows = candidates.length
    ? await client.query('SELECT id, position, category_id, name, price::text, mrp::text, stock, is_active, rank, data FROM products WHERE id = ANY($1::text[])', [candidates.map(row => String(row.data.id))])
    : { rows: [] };
  const existingCategories = new Map(categoryRows.rows.map(row => [row.id, row]));
  const existingProducts = new Map(productRows.rows.map(row => [row.id, row]));
  const actions = { insertCategories: [], unchangedCategories: [], conflictingCategories: [], insertProducts: [], unchangedProducts: [], conflictingProducts: [] };
  for (const item of selectedCategories) {
    const id = String(item.data.id), old = existingCategories.get(id);
    if (!old) actions.insertCategories.push({ id, name: item.data.name || null });
    else if (String(old.data?.name || '') === String(item.data.name || '')) actions.unchangedCategories.push({ id, name: item.data.name || null });
    else actions.conflictingCategories.push({ id, name: item.data.name || null });
  }
  for (const item of candidates) {
    const data = item.data, id = String(data.id), old = existingProducts.get(id);
    const matches = old && stable(old.data) === stable(data)
      && Number(old.position) === item.position && old.category_id === String(data.category)
      && old.name === String(data.name) && Number(old.price) === Number(data.price)
      && (old.mrp == null ? data.mrp == null : Number(old.mrp) === Number(data.mrp))
      && Number(old.stock) === Number(data.stock) && old.is_active === (data.isActive !== false)
      && Number(old.rank) === Number(data.rank || 0);
    if (!old) actions.insertProducts.push({ id, name: data.name });
    else if (matches) actions.unchangedProducts.push({ id, name: data.name });
    else actions.conflictingProducts.push({ id, name: data.name });
  }

  const report = {
    mode: dryRun ? 'dry-run' : 'import',
    target: { databaseName, currentMigration: schemaVersion, requiredMigration: MIGRATION_VERSION },
    source: { file: sourceFile, categories: categories.length, products: products.length, eligibleProducts: candidates.length },
    actions: { ...actions, updatedCategories: [], updatedProducts: [] },
    skipped: { products: skipped, categories: categories.filter(row => !selectedCategoryIds.has(String(row?.id || ''))).map(row => ({ id: row.id, name: row.name, reason: 'not in the selected catalogue IDs' })) },
    validationErrors: errors,
    writesOnly: ['categories', 'products'],
    otherTablesTouched: false
  };
  console.log(JSON.stringify(report, null, 2));

  if (dryRun) {
    await client.query('ROLLBACK'); inTransaction = false;
    if (errors.length || actions.conflictingCategories.length || actions.conflictingProducts.length) process.exitCode = 2;
  } else {
    if (schemaVersion !== MIGRATION_VERSION) throw new Error(`Import stopped: schema migration ${MIGRATION_VERSION} is required first.`);
    if (errors.length || actions.conflictingCategories.length || actions.conflictingProducts.length) throw new Error('Import stopped: resolve validation errors or ID conflicts before writing.');
    const categoryPayload = selectedCategories.filter(row => !existingCategories.has(String(row.data.id))).map(row => ({ id: String(row.data.id), position: row.position, data: row.data }));
    const productPayload = candidates.filter(row => !existingProducts.has(String(row.data.id))).map(row => ({ id: String(row.data.id), position: row.position, data: row.data }));
    if (categoryPayload.length) await client.query(`
      INSERT INTO categories(id,position,data)
      SELECT item->>'id',(item->>'position')::integer,item->'data'
      FROM jsonb_array_elements($1::jsonb) AS e(item)
      ON CONFLICT(id) DO NOTHING
    `, [JSON.stringify(categoryPayload)]);
    if (productPayload.length) await client.query(`
      INSERT INTO products(id,position,category_id,name,price,mrp,stock,is_active,rank,data)
      SELECT item->>'id',(item->>'position')::integer,d->>'category',d->>'name',
        (d->>'price')::numeric,NULLIF(d->>'mrp','')::numeric,(d->>'stock')::integer,
        COALESCE((d->>'isActive')::boolean,true),COALESCE((d->>'rank')::integer,0),d
      FROM jsonb_array_elements($1::jsonb) AS e(item)
      CROSS JOIN LATERAL (SELECT e.item->'data' AS d) source
      ON CONFLICT(id) DO NOTHING
    `, [JSON.stringify(productPayload)]);
    const verifyCategories = selectedCategories.length ? await client.query('SELECT id,data FROM categories WHERE id = ANY($1::text[])', [selectedCategories.map(row => String(row.data.id))]) : { rows: [] };
    const verifyProducts = candidates.length ? await client.query('SELECT id,data FROM products WHERE id = ANY($1::text[])', [candidates.map(row => String(row.data.id))]) : { rows: [] };
    const verifiedCategories = new Map(verifyCategories.rows.map(row => [row.id, row.data]));
    const verifiedProducts = new Map(verifyProducts.rows.map(row => [row.id, row.data]));
    if (selectedCategories.some(row => stable(verifiedCategories.get(String(row.data.id))) !== stable(row.data)) || candidates.some(row => stable(verifiedProducts.get(String(row.data.id))) !== stable(row.data))) throw new Error('Import stopped: a concurrent ID conflict was detected; transaction rolled back.');
    await client.query('COMMIT'); inTransaction = false;
    console.log(JSON.stringify({ result: 'committed', insertedCategories: categoryPayload.length, insertedProducts: productPayload.length, updatedRecords: 0, unrelatedTablesChanged: false }));
  }
} catch (error) {
  if (inTransaction) { try { await client.query('ROLLBACK'); } catch {} }
  throw error;
} finally {
  client?.release();
  await pool.end();
}
