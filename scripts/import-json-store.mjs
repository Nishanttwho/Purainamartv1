import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { assertPostgresSchema, writePostgresStore } from '../lib/postgres-store.mjs';
import { configurePostgresPool, normalizePostgresConnectionString } from '../lib/postgres-config.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const importing = args.includes('--import');
if (dryRun === importing) throw new Error('Choose exactly one mode: --dry-run or --import.');
const valueAfter = flag => { const found = args.find(arg => arg.startsWith(`${flag}=`)); return found?.slice(flag.length + 1) || null; };
const file = path.resolve(valueAfter('--file') || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data', 'store.json'));
const store = JSON.parse(await fs.readFile(file, 'utf8'));
const legacySessionCounts = {};
for (const [key, ownerKey, duration] of [['sessions','userId',7 * 86400_000],['riderSessions','riderId',7 * 86400_000],['adminSessions','adminId',8 * 3600_000]]) {
  const now = Date.now(); legacySessionCounts[key] = 0;
  for (const [sessionId, value] of Object.entries(store[key] || {})) if (typeof value === 'string') { store[key][sessionId] = { [ownerKey]: value, createdAt: now, expiresAt: now + duration }; legacySessionCounts[key]++; }
}
const lists = ['users','categories','products','riders','deliveryAreas','orders','referrals','rewards','referralEvents'];
const counts = Object.fromEntries(lists.map(key => [key, Array.isArray(store[key]) ? store[key].length : 0]));
counts.addresses = Object.values(store.addresses || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
counts.coupons = Object.keys(store.coupons || {}).length;
counts.sessions = Object.keys(store.sessions || {}).length + Object.keys(store.riderSessions || {}).length + Object.keys(store.adminSessions || {}).length;
counts.notifications = Object.values(store.notifications || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
counts.carts = Object.keys(store.carts || {}).length;
counts.wishlists = Object.values(store.wishlists || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);

const duplicates = [];
function scanDuplicateRows(rows, label, getId = row => row?.id) {
  const seen = new Set();
  for (const row of rows || []) { const id = getId(row); if (!id) { duplicates.push(`${label}: missing ID`); continue; } if (seen.has(String(id))) duplicates.push(`${label}: ${id}`); seen.add(String(id)); }
}
for (const key of lists) scanDuplicateRows(store[key], key);
scanDuplicateRows(Object.values(store.coupons || {}), 'coupons', row => row?.code);
scanDuplicateRows(Object.values(store.addresses || {}).flat(), 'addresses');
scanDuplicateRows(Object.values(store.notifications || {}).flat(), 'notifications');

const userIds = new Set((store.users || []).map(row => row.id));
const riderIds = new Set((store.riders || []).map(row => row.id));
const orderIds = new Set((store.orders || []).map(row => row.id));
const rewardIds = new Set((store.rewards || []).map(row => row.id));
const categoryIds = new Set((store.categories || []).map(row => row.id));
const productIds = new Set((store.products || []).map(row => row.id));
const invalid = [];
const check = (condition, label, id) => { if (!condition) invalid.push(`${label}: ${id || '(missing)'}`); };
for (const product of store.products || []) check(categoryIds.has(product.category), 'product category', product.id);
for (const product of store.products || []) {
  const price = Number(product.price), mrp = Number(product.mrp), stock = Number(product.stock);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(mrp) || mrp < price || !Number.isInteger(stock) || stock < 0) invalid.push(`product values/constraints: ${product.id}`);
}
for (const area of store.deliveryAreas || []) if (!Number.isFinite(Number(area.deliveryCharge)) || Number(area.deliveryCharge) < 0 || !Number.isFinite(Number(area.minimumOrder)) || Number(area.minimumOrder) < 0 || area.freeDeliveryThreshold != null && (!Number.isFinite(Number(area.freeDeliveryThreshold)) || Number(area.freeDeliveryThreshold) < 0)) invalid.push(`delivery area values/constraints: ${area.id}`);
const userPhones = new Map(), userEmails = new Map(), riderPhones = new Map();
for (const user of store.users || []) {
  for (const [map,value,label] of [[userPhones,user.phone,'customer phone'],[userEmails,String(user.email || '').toLowerCase(), 'customer email']]) if (value) { if (map.has(value)) invalid.push(`duplicate ${label}: ${map.get(value)} and ${user.id}`); else map.set(value,user.id); }
}
for (const rider of store.riders || []) if (rider.phone) { if (riderPhones.has(rider.phone)) invalid.push(`duplicate rider phone: ${riderPhones.get(rider.phone)} and ${rider.id}`); else riderPhones.set(rider.phone,rider.id); }
for (const [userId, rows] of Object.entries(store.addresses || {})) { check(userIds.has(userId), 'address owner', userId); for (const row of rows || []) check(Boolean(row.id), 'address id', userId); }
for (const order of store.orders || []) {
  check(userIds.has(order.userId), 'order customer', order.id); if (order.riderId) check(riderIds.has(order.riderId), 'order rider', order.id);
  for (const field of ['subtotal','discount','delivery','platform','total']) if (!Number.isFinite(Number(order[field] ?? 0)) || Number(order[field] ?? 0) < 0) invalid.push(`order amount constraint: ${order.id}/${field}`);
  if (order.idempotencyKey && (store.orders || []).some(other => other !== order && other.userId === order.userId && other.idempotencyKey === order.idempotencyKey)) invalid.push(`duplicate checkout idempotency key: ${order.userId}/${order.idempotencyKey}`);
}
for (const coupon of Object.values(store.coupons || {})) if (!Number.isFinite(Number(coupon.minimum ?? 0)) || Number(coupon.minimum ?? 0) < 0 || !Number.isFinite(Number(coupon.discount ?? 0)) || Number(coupon.discount ?? 0) < 0 || !['fixed','percentage'].includes(coupon.discountType || 'fixed') || coupon.discountType === 'percentage' && Number(coupon.discount) > 100) invalid.push(`coupon values/constraints: ${coupon.code || '(missing code)'}`);
for (const referral of store.referrals || []) { check(userIds.has(referral.referrerUserId), 'referral referrer', referral.id); check(userIds.has(referral.referredUserId), 'referral referred customer', referral.id); if (referral.qualifyingOrderId) check(orderIds.has(referral.qualifyingOrderId), 'referral qualifying order', referral.id); if (referral.rewardId) check(rewardIds.has(referral.rewardId), 'referral reward', referral.id); }
scanDuplicateRows(store.referrals || [], 'referred customer', row => row?.referredUserId);
for (const reward of store.rewards || []) { check(userIds.has(reward.userId), 'reward customer', reward.id); for (const key of ['qualifyingOrderId','orderId']) if (reward[key]) check(orderIds.has(reward[key]), `reward ${key}`, reward.id); }
scanDuplicateRows((store.rewards || []).filter(row => row?.qualifyingOrderId), 'reward qualifying order', row => row?.qualifyingOrderId);
for (const userId of Object.keys(store.notifications || {})) check(userIds.has(userId), 'notification owner', userId);
for (const userId of Object.keys(store.notificationWelcome || {})) check(userIds.has(userId), 'notification preference owner', userId);
for (const [sessionId, session] of Object.entries(store.sessions || {})) if (session?.userId) check(userIds.has(session.userId), 'customer session owner', sessionId);
for (const [sessionId, session] of Object.entries(store.riderSessions || {})) if (session?.riderId) check(riderIds.has(session.riderId), 'rider session owner', sessionId);
for (const event of store.referralEvents || []) if (event.userId) check(userIds.has(event.userId), 'referral event customer', event.id);
for (const [ownerId, cart] of Object.entries(store.carts || {})) for (const [productId, quantity] of Object.entries(cart || {})) {
  if (!productIds.has(productId)) invalid.push(`cart product reference: ${ownerId} -> ${productId}`);
  if (!Number.isInteger(Number(quantity)) || Number(quantity) < 1 || Number(quantity) > 10) invalid.push(`cart quantity constraint: ${ownerId} -> ${productId}`);
}
for (const [ownerId, ids] of Object.entries(store.wishlists || {})) for (const productId of ids || []) if (productId !== 'guest' && !productIds.has(productId)) invalid.push(`wishlist product reference: ${ownerId} -> ${productId}`);
for (const [ownerId, addressId] of Object.entries(store.selectedDeliveryAddresses || {})) if (!(store.addresses?.[ownerId] || []).some(row => row.id === addressId)) invalid.push(`selected address: ${ownerId} -> ${addressId}`);
if (store.dispatchSettings?.designatedRiderId && !riderIds.has(store.dispatchSettings.designatedRiderId)) invalid.push(`designated rider: ${store.dispatchSettings.designatedRiderId}`);

const suspectedDemo = {
  products: (store.products || []).filter(row => /Demo listing for local browsing\.?$/i.test(String(row.description || '').trim())).map(row => row.id),
  coupons: Object.entries(store.coupons || {}).filter(([code,row]) => code === 'DEMO50' || /demo/i.test(String(row.label || ''))).map(([code]) => code),
  simulatedPaymentOrders: (store.orders || []).filter(row => /demo|simulat/i.test(`${row.paymentMethod || ''} ${row.paymentStatus || ''}`)).map(row => row.id),
  demoRiders: (store.riders || []).filter(row => /demo rider/i.test(String(row.name || ''))).map(row => row.id),
  offerNotifications: Object.entries(store.notifications || {}).flatMap(([userId,rows]) => rows.filter(row => row.type === 'offer' && /demo50|sample order/i.test(`${row.title || ''} ${row.message || ''}`)).map(row => `${userId}/${row.id}`))
};
const review = [
  ...suspectedDemo.products.map(id => `demo product ${id}`), ...suspectedDemo.coupons.map(id => `demo coupon ${id}`),
  ...suspectedDemo.simulatedPaymentOrders.map(id => `simulated payment order ${id}`), ...suspectedDemo.demoRiders.map(id => `demo rider ${id}`),
  ...(store.users || []).filter(row => !row.phone && !row.email).map(row => `customer ${row.id} has no phone/email identity`),
  ...(store.orders || []).filter(row => !row.deliveryArea && !row.address?.deliveryAreaId).map(row => `order ${row.id} has no delivery-area snapshot`)
];

console.log(JSON.stringify({ file, counts, normalizedLegacySessions: legacySessionCounts, duplicateIds: duplicates, invalidRelationships: invalid, suspectedDemo, recordsRequiringReview: review }, null, 2));
if (!importing) process.exitCode = duplicates.length || invalid.length ? 2 : 0;
else {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the intended database; no import was performed.');
  if (duplicates.length || invalid.length) throw new Error('Import stopped: resolve duplicate IDs and invalid relationships reported by the dry run.');
  if (review.length && !args.includes('--include-suspected-demo-records')) throw new Error('Import stopped: inspect records requiring review; rerun with --include-suspected-demo-records only after review.');
  const confirmation = valueAfter('--confirm-target');
  if (!confirmation) throw new Error('Import stopped. Supply --confirm-target=<database-name> after confirming the target.');
  const pool = configurePostgresPool(new Pool({ connectionString: normalizePostgresConnectionString(process.env.DATABASE_URL), max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 }));
  try {
    await assertPostgresSchema(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [1718343473]);
      const identity = await client.query('SELECT current_database() AS database');
      if (identity.rows[0].database !== confirmation) throw new Error(`Import stopped: connected database "${identity.rows[0].database}" does not match the confirmed target.`);
      await writePostgresStore(client, store, { replace: false });
      await client.query('COMMIT');
      console.log(`Imported/upserted ${Object.values(counts).reduce((sum,count) => sum+count,0)} source records into confirmed database "${identity.rows[0].database}". Existing target-only rows were preserved; simulated payment states were imported unchanged.`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}
