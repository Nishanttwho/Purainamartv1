// Opt-in, live-database audit. Reads .env through Node's --env-file flag.
// Cart writes are ALWAYS aborted; this script never installs indexes or runs workers.
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { mongoConnectionOptions } from '../lib/mongodb.mjs';
import assert from 'node:assert/strict';
import { rollbackGuard, databaseSnapshot } from './performance-safety.mjs';
const baseline = process.argv.includes('--baseline');
const moduleRoot = baseline ? '../tmp/performance-baseline/lib/' : '../lib/';
const { MongoRepository, transactionOptions } = await import(moduleRoot+'mongo-repository.mjs');
const { handleCustomerApi } = await import(moduleRoot+'api-customer.mjs');
const { handleAdminApi } = await import(moduleRoot+'api-admin.mjs');
const { handleRiderApi } = await import(moduleRoot+'api-rider.mjs');

const label = process.argv[2];
if (!['before', 'after'].includes(label)) throw new Error('Specify before or after. This audit uses the configured database.');
if (label === 'before' && !baseline) throw new Error('Use --baseline with extracted original modules; never overwrite the historical baseline.');
const config = mongoConnectionOptions();
const client = new MongoClient(config.uri, { ...config.options, monitorCommands: true });
let commands = [];
client.on('commandSucceeded', event => commands.push({ command: event.commandName, ms: event.duration }));
const report = { label, measuredAt: new Date().toISOString(), environment: 'Local Node process to the existing configured MongoDB; not deployed HTTP timings', database: config.dbName, repetitions: 5, routes: {}, queries: {}, assets: {} };
report.source = baseline ? {revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),indexes:'Current installed indexes retained for controlled code comparison'} : {revision:'Modified working tree',indexes:'Current installed indexes'};
const round = value => Math.round(value * 100) / 100;
const stats = rows => ({ medianMs: round([...rows].sort((a,b)=>a-b)[Math.floor(rows.length/2)]), minMs: round(Math.min(...rows)), maxMs: round(Math.max(...rows)) });
function planStages(plan) { const result=[];function visit(value){if(!value||typeof value!=='object')return;if(value.stage)result.push({stage:value.stage,...(value.indexName?{index:value.indexName}:{})});for(const [key,child] of Object.entries(value))if(!['filter','indexBounds','slotBasedPlan'].includes(key))if(Array.isArray(child))child.forEach(visit);else visit(child);}visit(plan);return result; }
try {
  const start = performance.now(); await client.connect();
  const db = rollbackGuard(client, client.db(config.dbName)); await db.command({ ping: 1 });
  report.connectAndPingMs = round(performance.now() - start);
  const before = await databaseSnapshot(db);
  const repo = new MongoRepository(db, client);
  const [user, admin, rider, product] = await Promise.all([
    db.collection('users').findOne({ blockedAt: null }), db.collection('admins').findOne({}),
    db.collection('riders').findOne({ isActive: { $ne: false }, mustChangePassword: { $ne: true } }),
    db.collection('products').findOne({ isActive: { $ne: false }, stock: { $gt: 0 } })
  ]);
  report.available = { customer: Boolean(user), admin: Boolean(admin), rider: Boolean(rider), product: Boolean(product) };
  const context = route => ({ route: route.split('?')[0], url: new URL(route, 'http://localhost'), method: 'GET', body: {}, user, admin, rider, ownerId: user?.id || 'guest:performance-read-only', production: process.env.NODE_ENV === 'production', headers: {}, status: 200 });
  const routes = ['/api/bootstrap', ...(label==='after'?['/api/bootstrap?compact=1&limit=24']:[]), '/api/products?limit=24', '/api/cart', ...(user ? ['/api/orders?limit=20', '/api/addresses', '/api/coupons'] : []), ...(admin ? ['/api/admin/bootstrap', '/api/admin/bootstrap?view=overview&limit=25', '/api/admin/products?limit=25', '/api/admin/customers?limit=25'] : []), ...(rider ? ['/api/rider/bootstrap?limit=20'] : [])];
  for (const route of routes) {
    const durations = [], queryCounts = [], queryMs = []; let bytes;
    for (let i = 0; i < report.repetitions; i++) {
      commands = []; const start = performance.now(), ctx = context(route);
      const result = await repo.context.run({ documents: new Map(), readCache: new Map() }, () => route.startsWith('/api/admin/') ? handleAdminApi(repo, ctx) : route.startsWith('/api/rider/') ? handleRiderApi(repo, ctx) : handleCustomerApi(repo, ctx));
      durations.push(performance.now() - start); queryCounts.push(commands.length); queryMs.push(commands.reduce((sum,row)=>sum+row.ms,0)); bytes = Buffer.byteLength(JSON.stringify(result));
    }
    report.routes[route] = { ...stats(durations), queryCounts, databaseCommandMs: stats(queryMs), responseBytes: bytes };
    console.log(JSON.stringify({ route, ...report.routes[route] }));
  }
  if (user && product) {
    const variant = product.variants?.find(row => row.isActive !== false && row.stock >= (product.saleType === 'loose' ? row.quantityBase : 1));
    if (!product.variants?.length || variant) {
      for (const [name, quantity] of [['cart-add-rollback', 1], ['cart-quantity-rollback', 2], ...(label==='after'?[['cart-compact-rollback',2]]:[])]) {
        const times = [], counts = [];
        for (let i=0;i<report.repetitions;i++) {
          const session = client.startSession(); session.startTransaction(transactionOptions);
          try {
            commands=[]; const start=performance.now();
            await repo.context.run({ session, documents: new Map() }, async () => {
              const ctx = context('/api/cart/items'); ctx.method = 'POST'; ctx.body = { productId: product.id, variantId: variant?.id || null, quantity };
              if(name==='cart-compact-rollback')ctx.url.searchParams.set('offers','0');
              await handleCustomerApi(repo, ctx); await repo.flush();
            });
            times.push(performance.now()-start); counts.push(commands.length);
          } finally { await session.abortTransaction(); await session.endSession(); }
        }
        report.routes[name] = { ...stats(times), queryCounts: counts, aborted: true };
        console.log(JSON.stringify({ route: name, ...report.routes[name] }));
      }
    }
  }
  for (const [name, collection, filter, sort] of [
    ['catalogue', 'products', { isActive: { $ne: false }, stock: { $gt: 0 }, $or: [{ 'variants.0': { $exists: false } }, { variants: { $elemMatch: { isActive: { $ne: false }, stock: { $gt: 0 } } } }] }, { position: 1, rank: 1, id: 1 }],
    ['admin-products', 'products', {}, { createdAt: -1, id: 1 }],
    ['customer-orders', 'orders', { userId: user?.id || 'absent' }, { createdAt: -1, id: 1 }]
  ]) {
    const plan = await db.collection(collection).find(filter).sort(sort).limit(25).explain('executionStats');
    const s=plan.executionStats;
    report.queries[name] = { executionTimeMillis:s.executionTimeMillis, returned:s.nReturned, documentsExamined:s.totalDocsExamined, keysExamined:s.totalKeysExamined, stages:planStages(plan.queryPlanner.winningPlan) };
  }
  for (const file of ['app.js','admin.js','rider-app.js','styles.css','puraina-commerce.css','index.html',...(label==='after'?['account-views.js','api-client.js','cart-controller.js']:[])]) {
    const data=baseline ? execFileSync('git',['show','HEAD:public/'+file]) : await fs.readFile(new URL('../public/'+file,import.meta.url));
    report.assets[file]={bytes:data.length,gzipBytes:gzipSync(data).length,brotliBytes:brotliCompressSync(data).length};
  }
  const after = await databaseSnapshot(db);
  assert.deepEqual(after, before, 'Database changed during the audit');
  report.databaseSafety = { unchanged: true, collections: Object.keys(before).length, snapshot: after };
  await fs.mkdir(new URL('../performance/',import.meta.url),{recursive:true});
  await fs.writeFile(new URL('../performance/'+(baseline?'remeasured-before':label)+'.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log('Audit saved; all mutation transactions aborted. No records or configuration persisted.');
} catch (error) { console.error(JSON.stringify({ error: error.name, code: error.code || null, message: 'Audit failed; connection details and document data are withheld.' })); process.exitCode=1; }
finally { await client.close(); }
