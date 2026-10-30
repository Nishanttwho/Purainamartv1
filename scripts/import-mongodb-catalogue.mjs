import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { mongoConnectionOptions } from '../lib/mongodb.mjs';
import { catalogueHash, planCatalogueImport, inspectCatalogueTarget, importCatalogueInsertOnly } from '../lib/mongodb-catalogue-import.mjs';

const root = path.resolve(import.meta.dirname, '..');
const option = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const mode = process.argv.includes('--import') ? 'import' : process.argv.includes('--inspect-target') ? 'inspect-target' : 'dry-run';
const source = path.resolve(root, option('--file') || 'data/store.json');
const output = path.resolve(root, option('--report-dir') || 'tmp/catalogue-import-20261030');
const verifiedProductIds = (option('--verified-product-ids') || '').split(',').map(value => value.trim()).filter(Boolean);
const markdown = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const targetSummary = target => ({ ...target, actions: Object.fromEntries(Object.entries(target.actions).map(([name, rows]) => [name, rows.map(({ existing, ...row }) => ({ ...row, ...(existing ? { existingRecordHash: catalogueHash(JSON.stringify(existing)) } : {}) }))])) });
let client;

async function main() {
  if (!output.startsWith(root + path.sep)) throw new Error('Report output must be inside this workspace');
  if (!verifiedProductIds.length) throw new Error('Explicit verified product IDs are required');
  const input = await fs.readFile(source), sourceHash = catalogueHash(input);
  const plan = await planCatalogueImport(JSON.parse(input), { verifiedProductIds, publicDir: path.join(root, 'public') });
  const selectionHash = catalogueHash(JSON.stringify({ verifiedProductIds, products: plan.selectedProducts, categories: plan.selectedCategories }));
  const config = mongoConnectionOptions(); // Parses the database name without connecting.
  const report = { mode: 'dry-run', source: path.relative(root, source), sourceHash, selectionHash, verifiedProductIds, authenticityEvidence: 'Human confirmation in this chat: I confirm both saved listings are genuine (p123 and p125, 2026-10-30). Development seed origin alone is not accepted as authenticity evidence.', target: { database: config.dbName, connected: false }, ...plan };
  await fs.mkdir(output, { recursive: true });
  const reportPath = path.join(output, 'dry-run.json');
  if (mode === 'dry-run') {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'selected-catalogue.json'), JSON.stringify({ products: plan.selectedProducts.map(row => row.document), categories: plan.selectedCategories.map(row => row.document) }, null, 2) + '\n');
    const lines = ['# PurainaMart catalogue import dry run', '', 'Database: **purainamart** (URI database name verified; no connection or writes during this source dry run).', '', 'Source: `' + report.source + '`. Source SHA-256: `' + sourceHash + '`.', '', '## Selection evidence', '', 'The 22 p101–p122 records contain an explicit demo marker. The preserved server also auto-seeded p123, p124 and p125 in development. The user explicitly confirmed the saved p123 and p125 listings, including their prices, descriptions, images and 10,000 g stock, as genuine. p124 remains unverified and is excluded. The previous catalogue importer selected p123/p125, but that selection alone is not treated as proof.', '', 'No fields have been invented or normalized. Full original product/category payloads are in selected-catalogue.json. Additional source fields, including saved ratings, are retained exactly; those ratings were auto-populated by the old application.', '', '## Products selected', '', '| ID | Original name | Price | Shared stock | Category | Variants |', '|---|---|---:|---:|---|---|'];
    for (const { document: row } of plan.selectedProducts) lines.push(`| ${row.id} | ${markdown(row.name)} | ₹${row.price}/kg | ${row.stock} g | ${row.category} | ${row.variants.map(v => `${v.id}: ${v.label}, ₹${v.price}, stock ${v.stock} g`).join('; ')} |`);
    lines.push('', '## Products excluded', '', '| ID | Name | Reason |', '|---|---|---|');
    for (const row of plan.excludedProducts) lines.push(`| ${row.id} | ${markdown(row.name)} | ${markdown(row.reason)} |`);
    lines.push('', '## Categories', '', ...plan.selectedCategories.map(({ document: row }) => `- Selected: **${row.id} — ${row.name}**. Original category fields are preserved.`), ...plan.excludedCategories.map(row => `- Excluded: ${row.id} — ${row.name}: ${row.reason}.`), '', '## Image references and completeness', '');
    for (const { document, images } of [...plan.selectedProducts, ...plan.selectedCategories]) {
      lines.push(`- ${document.id}: ${images.length} distinct local image references.`);
      for (const image of images) lines.push(`  - ${image.reference}: ${image.status}${image.bytes ? ` (${image.bytes} bytes)` : ''}.`);
    }
    const bad = [...plan.selectedProducts, ...plan.selectedCategories, ...plan.excludedProducts].flatMap(row => row.images).filter(row => row.status !== 'present');
    lines.push('', `Missing/unverified referenced images across the inspected product catalogue: **${bad.length}**.`, 'The selected loose products intentionally have null MRP; no reference price has been invented. All required selected names, descriptions, prices, units, stock, variant IDs and category references are present.', ...plan.warnings.map(row => `- ${row.id}: ${row.issue}.`), '', '## Write policy', '', 'Only products and their required categories are eligible. Existing records will never be updated or deleted. Missing records use $setOnInsert under unique ID indexes in one transaction. Existing differing products are reported and retained. A conflicting category stops the import. The source hash and selection/image hashes must still match this dry run before connection or import.', '', `Selected: **${plan.selectedProducts.length} products, ${plan.selectedCategories.length} categories**. Excluded: **${plan.excludedProducts.length} products**. Blockers: **${plan.blockers.length}**.`, ...plan.blockers.map(value => `- ${value}`), '');
    await fs.writeFile(path.join(output, 'dry-run.md'), lines.join('\n'));
    console.log(JSON.stringify({ mode, targetDatabase: config.dbName, selectedProducts: plan.selectedProducts.map(({ document }) => ({ id: document.id, name: document.name, price: document.price, stock: document.stock })), selectedCategories: plan.selectedCategories.map(row => row.document.id), excludedProducts: plan.excludedProducts.map(({ id, name, reason }) => ({ id, name, reason })), blockers: plan.blockers, report: path.relative(root, path.join(output, 'dry-run.md')) }, null, 2));
    return;
  }
  const reviewed = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (reviewed.sourceHash !== sourceHash || reviewed.selectionHash !== selectionHash || reviewed.target.database !== 'purainamart') throw new Error('Source, selection or images changed since the dry run');
  if (plan.blockers.length || plan.selectedProducts.length !== verifiedProductIds.length) throw new Error('Resolve dry-run blockers before connecting');
  if (mode === 'import' && option('--confirm-target') !== 'purainamart') throw new Error('Import requires --confirm-target=purainamart');
  client = new MongoClient(config.uri, { ...config.options, maxPoolSize: 1, appName: 'purainamart-catalogue-import' });
  await client.connect();
  const db = client.db(config.dbName);
  await db.command({ ping: 1 });
  const topology = await db.command({ hello: 1 });
  const target = await inspectCatalogueTarget(db, plan);
  await fs.writeFile(path.join(output, 'target-dry-run.json'), JSON.stringify({ ...targetSummary(target), transactionTopology: Boolean(topology.setName || topology.msg === 'isdbgrid') }, null, 2) + '\n');
  console.log(JSON.stringify({ mode: 'target-dry-run', ...targetSummary(target) }, null, 2));
  if (mode === 'inspect-target') return;
  if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('A replica set or sharded cluster is required');
  if (target.actions.categories.some(row => row.action === 'keep_existing_different')) throw new Error('Conflicting category; no import performed');
  for (const name of ['categories', 'products']) {
    let indexes;
    try { indexes = await db.collection(name).listIndexes().toArray(); } catch (error) { if (error.code !== 26) throw error; indexes = []; }
    if (!indexes.some(index => index.unique && Object.keys(index.key).length === 1 && index.key.id === 1)) await db.collection(name).createIndex({ id: 1 }, { unique: true, name: `${name}_id_unique` });
  }
  const result = await importCatalogueInsertOnly(db, client, plan);
  const repeated = await importCatalogueInsertOnly(db, client, plan);
  if (repeated.inserted.products.length || repeated.inserted.categories.length) throw new Error('Repeat import unexpectedly inserted records');
  const after = await inspectCatalogueTarget(db, plan);
  if (after.actions.products.some(row => row.action === 'insert') || after.actions.categories.some(row => row.action === 'insert')) throw new Error('Post-import verification found missing selected records');
  const sourceUnchanged = catalogueHash(await fs.readFile(source)) === sourceHash;
  if (!sourceUnchanged) throw new Error('Source file changed during import');
  const final = { ...result, verifiedAt: new Date().toISOString(), sourceUnchanged, beforeCounts: target.counts, after: targetSummary(after), idempotencyCheck: { insertedProducts: repeated.inserted.products.length, insertedCategories: repeated.inserted.categories.length, updatedRecords: 0, deletedRecords: 0 } };
  await fs.writeFile(path.join(output, 'import-result.json'), JSON.stringify(final, null, 2) + '\n');
  console.log(JSON.stringify(final, null, 2));
}
try { await main(); }
catch (error) { console.error(JSON.stringify({ event: 'catalogue_operation_failed', name: error.name, code: error.code || 'VALIDATION_OR_IO', message: error.name === 'Error' && !error.code ? error.message : 'Operation failed; no success is claimed. Connection details and credentials are withheld.' })); process.exitCode = 1; }
finally { await client?.close(); }
