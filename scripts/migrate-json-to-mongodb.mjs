import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLegacyStoreToMongo } from '../lib/mongodb-migration.mjs';
import { getMongoClient, getMongoDb, closeMongo, mongoConnectionOptions } from '../lib/mongodb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const sourcePath = path.resolve(root, option('--file') || 'data/store.json');
const importing = process.argv.includes('--import');
const confirmed = option('--confirm-target');
const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const report = mapLegacyStoreToMongo(source);
const counts = Object.fromEntries(Object.entries(report.collections).map(([name, rows]) => [name, rows.length]));
console.log(JSON.stringify({ mode: importing ? 'import' : 'dry-run', source: path.relative(root, sourcePath), counts, skipped: report.skipped, validation: report.validation, blockers: report.blockers, importable: report.importable }, null, 2));

if (!importing) process.exit(0);
if (!report.importable) throw new Error('Migration stopped before connecting: resolve all dry-run blockers and select an authoritative non-demo source.');
if (confirmed !== 'purainamart') throw new Error('Import requires --confirm-target=purainamart.');
const config = mongoConnectionOptions();
if (config.dbName !== 'purainamart') throw new Error('Migration stopped: target database must be exactly purainamart.');

let session;
try {
const db = await getMongoDb();
const client = await getMongoClient();
const hello = await db.command({ hello: 1 });
if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Migration stopped: MongoDB transactions require a replica set or sharded cluster.');
const keyFor = (name, row) => {
  if (['carts','wishlists','shoppingPreferences'].includes(name)) return { ownerId: row.ownerId };
  if (name === 'addresses') return { customerId: row.customerId, id: row.id };
  if (name === 'settings') return { key: row.key };
  if (name === 'coupons') return { code: row.code };
  if (name === 'notificationPreferences') return { ownerType: row.ownerType, ownerId: row.ownerId };
  return { id: row.id };
};
session = client.startSession();
  await session.withTransaction(async () => {
    for (const [name, rows] of Object.entries(report.collections)) {
      if (!rows.length) continue;
      const operations = rows.map(document => ({ updateOne: { filter: keyFor(name, document), update: { $setOnInsert: document }, upsert: true } }));
      await db.collection(name).bulkWrite(operations, { ordered: true, session });
    }
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
  console.log(JSON.stringify({ event: 'migration_import_complete', database: 'purainamart', mode: 'insert-only-upsert', collections: Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)) }));
} finally {
  try { await session?.endSession(); } finally { await closeMongo(); }
}
