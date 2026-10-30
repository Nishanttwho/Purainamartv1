import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readPostgresStore, writePostgresStore } from '../lib/postgres-store.mjs';

test('PostgreSQL session IDs are hashed at rest and remain stable across snapshot reloads', async () => {
  const raw = 'opaque-session-token-for-db-test';
  const expected = crypto.createHash('sha256').update(raw).digest('hex');
  const initial = { users: [{ id: 'u1' }], sessions: { [raw]: { userId: 'u1', authMethod: 'password', expiresAt: Date.now() + 10000 } }, riderSessions: {}, adminSessions: {}, variantCarts: { u1: { p1: { v1: 2 } } }, homepageBanners: [{ id: 'hero-promo', enabled: true, order: 0 }], homepageHeroFruitImage: 'https://res.cloudinary.com/demo/image/upload/fruit.png' };
  let savedState;const savedSettings={}; const variantCartWrites=[];
  const writeClient = { query: async (sql, params) => { if(sql.includes('write_store_snapshot'))savedState = JSON.parse(params[0]);if(sql.includes("VALUES('homepageBanners'"))savedSettings.homepageBanners=JSON.parse(params[0]);if(sql.includes("VALUES('homepageHeroFruitImage'"))savedSettings.homepageHeroFruitImage=JSON.parse(params[0]);if(sql.includes('INSERT INTO cart_variant_items'))variantCartWrites.push(params);return { rows: [] }; } };
  await writePostgresStore(writeClient, initial, { replace: false });
  assert.deepEqual(Object.keys(savedState.sessions), [expected]);
  assert.equal(initial.sessions[raw].userId, 'u1', 'database adapter does not mutate the live store');

  let readQueries = 0;
  const readClient = { query: async sql => { readQueries++; assert.match(sql, /WITH base AS MATERIALIZED/); return { rows: [{ state: { __initialized: true, users: [{ id: 'u1' }], sessions: savedState.sessions, riderSessions: {}, adminSessions: {}, categories: [], riders: [], deliveryAreas: [], products: [], orders: [], referrals: [], rewards: [], referralEvents: [], coupons: {}, addresses: {}, carts: {}, wishlists: {} }, state_bytes: 512, related_bytes: 256, related: { devices: [], preferences: [], templates: [], events: [], outbox: [], campaigns: [], logs: [], riderNotifications: [], variantCartRows: [{owner_id:'u1',product_id:'p1',variant_id:'v1',quantity:2}], settings: savedSettings } }] }; } };
  const restored = await readPostgresStore(readClient);
  assert.equal(readQueries, 1, 'the consistent store snapshot and related records use one PostgreSQL round trip');
  assert.deepEqual(Object.keys(restored.sessions), [`h:${expected}`]);
  assert.deepEqual(restored.variantCarts,{u1:{p1:{v1:2}}});
  assert.deepEqual(restored.homepageBanners,initial.homepageBanners,'promotional banner settings persist through the PostgreSQL settings table');
  assert.equal(restored.homepageHeroFruitImage,initial.homepageHeroFruitImage,'homepage hero fruit image persists through PostgreSQL application settings');
  let rewritten;
  await writePostgresStore({ query: async (sql, params) => { if (sql.includes('write_store_snapshot')) rewritten = JSON.parse(params[0]); return { rows: [] }; } }, restored);
  assert.deepEqual(Object.keys(rewritten.sessions), [expected], 'reloading and writing a session does not hash its ID twice');
  assert.equal(variantCartWrites[0][3],2,'variant cart count is stored in the dedicated PostgreSQL cart table');
});
