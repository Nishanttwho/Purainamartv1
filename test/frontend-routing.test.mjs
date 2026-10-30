import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromUrl, urlForState, createPageRouter } from '../public/router.js';
import { paginatedRequest } from '../public/pagination.js';
import { fixture } from './support/api-fixture.mjs';

test('customer routes preserve nested IDs and search terms', () => {
  for (const path of ['/', '/cart', '/account', '/referral', '/orders', '/checkout', '/products/p1', '/orders/o1', '/categories/pantry', '/rewards/r1/checkout', '/search?q=rice']) assert.equal(urlForState(routeFromUrl(path)), path);
});

function fakeWindow() {
  const entries = [{ url: '/', state: null }], handlers = {};
  let position = 0;
  const win = { location: new URL('http://localhost/'), scrollY: 0, scrollTo() {}, addEventListener: (name, fn) => { handlers[name] = fn; }, removeEventListener: name => { delete handlers[name]; } };
  const apply = () => { win.location = new URL(entries[position].url, 'http://localhost'); };
  win.history = { get state() { return entries[position].state; }, replaceState(state, _, url) { entries[position] = { state, url }; apply(); }, pushState(state, _, url) { entries.splice(++position); entries.push({ state, url }); apply(); }, back() { if (position) { position--; apply(); return handlers.popstate(); } }, forward() { if (position < entries.length - 1) { position++; apply(); return handlers.popstate(); } } };
  return win;
}
test('router restores Back and Forward and invalidates slow restoration after a new navigation', async () => {
  const win = fakeWindow(); let state = { view: 'home' }, finish, currentRequest;
  const router = createPageRouter({ window: win, readState: () => state, onNavigate: async (route, current) => { state = route; router.sync(state); if (route.view === 'orders') { currentRequest = current; await new Promise(resolve => { finish = resolve; }); } } });
  state = { view: 'cart' }; router.sync(state);
  state = { view: 'account' }; router.sync(state);
  await win.history.back(); assert.equal(state.view, 'cart');
  await win.history.forward(); assert.equal(state.view, 'account');
  win.history.pushState({}, '', '/orders'); const pending = router.restore();
  state = { view: 'home' }; router.sync(state);
  assert.equal(currentRequest(), false); finish(); await pending;
  assert.equal(win.location.pathname, '/'); router.dispose();
});

test('pagination follows bounded pages, deduplicates IDs and preserves response metadata', async () => {
  const calls = [], rows = Array.from({ length: 401 }, (_, id) => ({ id: String(id) }));
  const result = await paginatedRequest(async input => { const url = new URL(input, 'http://localhost'); calls.push(url); const offset = Number(url.searchParams.get('offset')); return { products: rows.slice(offset, offset + 200), count: 401 }; }, '/api/products?q=rice');
  assert.equal(result.products.length, 401); assert.equal(result.count, 401);
  assert.deepEqual(calls.map(url => url.searchParams.get('offset')), ['0','200','400']);
  assert.ok(calls.every(url => url.searchParams.get('q') === 'rice'));
});
test('pagination merges nested admin and rider histories and leaves writes untouched', async () => {
  let n = 0;
  const result = await paginatedRequest(async () => ({ referralRewards: { rewards: Array.from({ length: n++ ? 1 : 200 }, (_, i) => ({ id: `${n}-${i}` })) } }), '/api/admin/bootstrap');
  assert.equal(result.referralRewards.rewards.length, 201);
  let calls = 0;
  await paginatedRequest(async (url, options) => { calls++; assert.equal(url, '/api/orders'); assert.equal(options.method, 'POST'); return {}; }, '/api/orders', { method: 'POST' });
  assert.equal(calls, 1);
});
test('actual mock API pagination exposes catalogue and orders beyond the first page', async t => {
  const products = Array.from({ length: 205 }, (_, i) => ({ id: `p${i}`, name: `Product ${i}`, category: 'pantry', price: 10, stock: 10, isActive: true }));
  const f = await fixture(t, { products });
  const result = await paginatedRequest(async url => (await f.call(url)).data, '/api/products');
  assert.equal(result.products.length, 205);
  assert.equal(new Set(result.products.map(row => row.id)).size, 205);
});
test('HTTP server supports direct pages, refresh assets, HEAD and conditional caching', async t => {
  const f = await fixture(t);
  for (const route of ['/', '/cart', '/account', '/referral', '/orders', '/checkout', '/products/p1', '/orders/o1', '/categories/pantry', '/rewards/r1/checkout', '/admin', '/rider']) {
    const response = await f.call(route); assert.equal(response.status, 200, route); assert.match(response.headers.get('content-type'), /text\/html/);
  }
  const asset = await f.call('/app.js'); assert.equal(asset.status, 200);
  assert.equal((await f.call('/app.js', { headers: { 'if-none-match': asset.headers.get('etag') } })).status, 304);
  assert.equal((await f.call('/cart', { method: 'HEAD' })).data, '');
  assert.equal((await f.call('/missing.js')).status, 404);
  assert.equal((await f.call('/api/missing')).status, 404);
  for (const path of ['/unknown-document', '/bad%']) {
    const response = await fetch(f.base + path, { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/');
  }
  assert.equal((await f.call('/..%2fserver.mjs')).status, 403);
  assert.equal((await f.call('/app.js', { method: 'POST' })).status, 405);
});
test('notification pagination honors offsets and retains the total unread count', async t => {
  const notifications = Array.from({ length: 205 }, (_, i) => ({ id: `n${i}`, userId: 'u1', title: 'Notice', createdAt: '2026-01-01', readAt: null }));
  const f = await fixture(t, { notifications });
  const result = await paginatedRequest(async url => (await f.call(url)).data, '/api/notifications');
  assert.equal(result.notifications.length, 205); assert.equal(result.unread, 205);
});
test('saved addresses and wishlist selections are not truncated by internal query page sizes', async t => {
  const products = Array.from({ length: 205 }, (_, i) => ({ id: `p${i}`, name: `Product ${i}`, category: 'pantry', price: 10, stock: 10 }));
  const addresses = Array.from({ length: 101 }, (_, i) => ({ id: `a${i}`, customerId: 'u1', line1: 'Test street', city: 'Test City', deliveryAreaId: 'area1' }));
  const f = await fixture(t, { products, addresses, wishlists: [{ ownerId: 'u1', productIds: products.map(row => row.id) }] });
  assert.equal((await f.call('/api/addresses')).data.addresses.length, 101);
  assert.equal(f.operations.filter(row => row.name === 'deliveryAreas' && row.operation === 'findOne').length, 1);
  await f.call('/api/addresses');
  assert.equal(f.operations.filter(row => row.name === 'deliveryAreas' && row.operation === 'findOne').length, 2, 'related reads are cached only within one request');
  assert.equal((await f.call('/api/wishlist')).data.items.length, 205);
});
