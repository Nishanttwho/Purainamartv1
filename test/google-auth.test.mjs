import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createGoogleIdTokenVerifier, resolveGoogleCustomer } from '../lib/google-auth.mjs';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig', alg: 'RS256' };
const now = 1_800_000_000_000;
function token(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key-1', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'zepto-test-client', sub: 'google-user-7', email: 'verified@example.com', email_verified: true, name: 'Verified Customer', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600, ...overrides })).toString('base64url');
  const payload = `${header}.${claims}`;
  return `${payload}.${crypto.sign('RSA-SHA256', Buffer.from(payload), pair.privateKey).toString('base64url')}`;
}
function verifier() {
  return createGoogleIdTokenVerifier({ now: () => now, fetchImpl: async () => ({ ok: true, headers: new Headers({ 'cache-control': 'public, max-age=3600' }), json: async () => ({ keys: [publicJwk] }) }) });
}

test('Google verifier accepts a valid signature and verified matching identity', async () => {
  const claims = await verifier()(token(), 'zepto-test-client');
  assert.equal(claims.sub, 'google-user-7');
  assert.equal(claims.email, 'verified@example.com');
  assert.equal(claims.name, 'Verified Customer');
});

test('Google verifier rejects altered signatures, audience, issuer, expiry and unverified email', async t => {
  const checks = [
    ['signature', async () => { const value = token().split('.'); value[1] = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'zepto-test-client', sub: 'changed', email: 'verified@example.com', email_verified: true, exp: Math.floor(now / 1000) + 600 })).toString('base64url'); await verifier()(value.join('.'), 'zepto-test-client'); }],
    ['audience', async () => verifier()(token(), 'another-client')],
    ['issuer', async () => verifier()(token({ iss: 'https://attacker.example' }), 'zepto-test-client')],
    ['expiration', async () => verifier()(token({ exp: Math.floor(now / 1000) }), 'zepto-test-client')],
    ['unverified email', async () => verifier()(token({ email_verified: false }), 'zepto-test-client')]
  ];
  for (const [label, action] of checks) await t.test(label, async () => assert.rejects(action));
});

test('Google customer linking preserves existing customer data and never duplicates a verified identity', () => {
  const users = [{ id: 'existing-customer', phone: '9123456789', name: 'Existing name', email: 'verified@example.com', emailVerified: true, referralCode: 'KEEP123', createdAt: '2024-01-01', addresses: ['preserve'] }];
  const claims = { sub: 'google-user-7', email: 'VERIFIED@example.com', email_verified: true, name: 'Google Profile Name' };
  const first = resolveGoogleCustomer(users, claims, { createId: () => 'new-id', createReferralCode: () => 'NEW123' });
  assert.equal(first.isNewUser, false);
  assert.equal(users.length, 1);
  assert.equal(first.user.id, 'existing-customer');
  assert.equal(first.user.phone, '9123456789');
  assert.equal(first.user.name, 'Existing name');
  assert.deepEqual(first.user.addresses, ['preserve']);
  assert.equal(first.user.googleSub, 'google-user-7');
  const again = resolveGoogleCustomer(users, claims);
  assert.equal(again.isNewUser, false);
  assert.equal(users.length, 1);
});

test('Google customer creation uses verified profile data and rejects conflicting linked accounts', () => {
  const users = [];
  const created = resolveGoogleCustomer(users, { sub: 'new-sub', email: 'new@example.com', email_verified: true, name: 'New Customer' }, { createId: () => 'google-customer', createReferralCode: () => 'REF123', createdAt: () => '2026-01-01' });
  assert.equal(created.isNewUser, true);
  assert.deepEqual({ id: created.user.id, email: created.user.email, phone: created.user.phone, name: created.user.name, referralCode: created.user.referralCode }, { id: 'google-customer', email: 'new@example.com', phone: null, name: 'New Customer', referralCode: 'REF123' });
  users.push({ id: 'other', email: 'conflict@example.com', emailVerified: true, googleSub: 'other-sub' });
  assert.throws(() => resolveGoogleCustomer(users, { sub: 'new-sub', email: 'conflict@example.com', email_verified: true }), { code: 'GOOGLE_ACCOUNT_CONFLICT' });
});

let tempDir, server, port;
async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zepto-google-auth-'));
  port = await freePort();
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ...env } = process.env;
  server = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...env, NODE_ENV: 'test', APP_TEST_AUTH: '1', PORT: String(port), STORE_PATH: path.join(tempDir, 'store.json') }, stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error('Google auth test server exited early');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Google auth test server did not start');
});
after(async () => {
  if (server && server.exitCode === null) { server.kill(); await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]); }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('Google auth start fails clearly when OAuth credentials are missing', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/google/start`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}' });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'GOOGLE_AUTH_NOT_CONFIGURED');
  assert.match(body.error, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
});

test('guest sessions stay isolated and merge only into their own account while sign-out preserves account data', async () => {
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body, cookie) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { response, data: await response.json() };
  };
  const adminChallenge = await post('/api/admin/auth/request-otp', { phone: '9000000001' }); assert.equal(adminChallenge.response.status, 200);
  const adminLogin = await post('/api/admin/auth/verify-otp', { challengeId: adminChallenge.data.challengeId, code: adminChallenge.data.testCode }); assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get('set-cookie')?.split(';')[0];
  const createdArea = await post('/api/admin/delivery-areas', { name: 'Guest merge area', pinCodes: [], deliveryCharge: 15, minimumOrder: 0, freeDeliveryThreshold: null, etaMinMinutes: 10, etaMaxMinutes: 20 }, adminCookie);
  assert.equal(createdArea.response.status, 201);
  const guestArea = await post('/api/delivery-area/select', { areaId: createdArea.data.area.id }); assert.equal(guestArea.response.status, 200);
  const guestId = guestArea.response.headers.get('set-cookie')?.match(/(?:^|,\s*)gid=([^;,]+)/)?.[1]; assert.ok(guestId, 'the server assigns an isolated guest identifier');
  const guestCookie = `gid=${guestId}`;
  const cartAdd = await post('/api/cart/items', { productId: 'p101', delta: 4 }, guestCookie); assert.equal(cartAdd.response.status, 200);
  const saved = await post('/api/wishlist/toggle', { productId: 'p102' }, guestCookie); assert.equal(saved.response.status, 200);
  const coupon = await post('/api/coupons/apply', { code: 'DEMO50' }, guestCookie); assert.equal(coupon.response.status, 200);
  const guestView = await fetch(base + '/api/cart', { headers: { cookie: guestCookie } }); assert.equal((await guestView.json()).count, 4);
  const secondVisitor = await fetch(base + '/api/cart'); const secondVisitorData = await secondVisitor.json(); assert.equal(secondVisitorData.count, 0);
  const secondGuestId = secondVisitor.headers.get('set-cookie')?.match(/(?:^|,\s*)gid=([^;,]+)/)?.[1]; assert.ok(secondGuestId); assert.notEqual(secondGuestId, guestId);
  const secondGuestWishlist = await fetch(base + '/api/wishlist', { headers: { cookie: `gid=${secondGuestId}` } }); assert.deepEqual((await secondGuestWishlist.json()).items, []);
  const requested = await post('/api/auth/request-otp', { phone: '9123456700' }, guestCookie); assert.equal(requested.response.status, 200);
  const signedIn = await post('/api/auth/verify-otp', { challengeId: requested.data.challengeId, code: requested.data.testCode }, guestCookie); assert.equal(signedIn.response.status, 200);
  const sid = signedIn.response.headers.get('set-cookie')?.match(/(?:^|,\s*)sid=([^;,]+)/)?.[1]; const cookie = `sid=${sid}; gid=${guestId}`;
  const cartResponse = await fetch(base + '/api/cart', { headers: { cookie } }); const cart = await cartResponse.json();
  const wishlistResponse = await fetch(base + '/api/wishlist', { headers: { cookie } }); const wishlist = await wishlistResponse.json();
  const bootstrapResponse = await fetch(base + '/api/bootstrap', { headers: { cookie } }); const bootstrap = await bootstrapResponse.json();
  assert.equal(cart.count, 4);
  assert.equal(cart.activeCoupon.code, 'DEMO50');
  assert.equal(cart.discount, 50);
  assert.deepEqual(wishlist.items.map(item => item.id), ['p102']);
  assert.equal(bootstrap.selectedDeliveryAreaId, createdArea.data.area.id, 'the selected guest delivery area follows only this visitor into their account');
  await post('/api/auth/logout', {}, cookie);
  const afterLogout = await fetch(base + '/api/cart', { headers: { cookie: guestCookie } }); assert.equal((await afterLogout.json()).count, 0, 'sign-out shows an empty visitor cart without erasing the saved account cart');
  const accountAgain = await post('/api/auth/request-otp', { phone: '9123456700' }, guestCookie);
  const loggedInAgain = await post('/api/auth/verify-otp', { challengeId: accountAgain.data.challengeId, code: accountAgain.data.testCode }, guestCookie);
  const newSid = loggedInAgain.response.headers.get('set-cookie')?.match(/(?:^|,\s*)sid=([^;,]+)/)?.[1];
  const restoredCookie = `sid=${newSid}; gid=${guestId}`;
  const restored = await fetch(base + '/api/cart', { headers: { cookie: restoredCookie } }); const restoredCart = await restored.json(); assert.equal(restoredCart.count, 4, 'the account cart returns at the next sign-in'); assert.equal(restoredCart.activeCoupon.code, 'DEMO50');
  const restoredWishlist = await fetch(base + '/api/wishlist', { headers: { cookie: restoredCookie } }); assert.deepEqual((await restoredWishlist.json()).items.map(item => item.id), ['p102']);
  const restoredBootstrap = await fetch(base + '/api/bootstrap', { headers: { cookie: restoredCookie } }); assert.equal((await restoredBootstrap.json()).selectedDeliveryAreaId, createdArea.data.area.id);
});

test('Google auth start returns a short-lived HttpOnly state cookie and rejects callback state mismatch', async () => {
  const configuredPort = await freePort();
  const configuredStore = path.join(tempDir, 'configured-store.json');
  const configuredServer = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(configuredPort), STORE_PATH: configuredStore, GOOGLE_CLIENT_ID: 'test-web-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'server-only-test-secret' }, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${configuredPort}`;
  try {
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
      if (configuredServer.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'configured OAuth test server starts');
    const started = await fetch(`${origin}/api/auth/google/start`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    const config = await started.json();
    assert.equal(started.status, 200);
    assert.equal(config.clientId, 'test-web-client.apps.googleusercontent.com');
    assert.ok(config.state.length >= 32);
    assert.doesNotMatch(JSON.stringify(config), /server-only-test-secret/);
    const cookie = started.headers.get('set-cookie')?.split(';')[0];
    assert.match(started.headers.get('set-cookie') || '', /HttpOnly/);
    assert.match(started.headers.get('set-cookie') || '', /Max-Age=300/);
    const rejected = await fetch(`${origin}/api/auth/google/callback`, { method: 'POST', headers: { origin, cookie, 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'not-exchanged', state: 'incorrect-state-value' }) });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).code, 'GOOGLE_STATE_INVALID');
  } finally {
    if (configuredServer.exitCode === null) { configuredServer.kill(); await Promise.race([once(configuredServer, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]); }
  }
});

test('referral links and QR generation require the configured canonical public URL', async () => {
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body, cookie) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { response, data: await response.json().catch(() => ({})) };
  };
  const patch = async (route, body, cookie) => {
    const response = await fetch(base + route, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { response, data: await response.json().catch(() => ({})) };
  };
  const adminChallenge = await post('/api/admin/auth/request-otp', { phone: '9000000001' });
  const admin = await post('/api/admin/auth/verify-otp', { challengeId: adminChallenge.data.challengeId, code: adminChallenge.data.testCode });
  const adminCookie = admin.response.headers.get('set-cookie')?.split(';')[0];
  const customerChallenge = await post('/api/auth/request-otp', { phone: '9123456799' });
  const customerLogin = await post('/api/auth/verify-otp', { challengeId: customerChallenge.data.challengeId, code: customerChallenge.data.testCode });
  const customerCookie = customerLogin.response.headers.get('set-cookie')?.split(';')[0];
  let qr = await fetch(base + '/api/referrals/qr', { headers: { cookie: customerCookie, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' } });
  assert.equal(qr.status, 409, 'disabled referral campaigns do not produce QR codes');
  const campaign = { enabled: true, minimumOrder: 1, firstOrderOnly: true, qualifyingStatus: 'Delivered', rewardType: 'free_product', rewardAmount: 50, freeProductId: 'p105', expiryDays: 30, redemptionLimit: 1, maxRewardsPerCustomer: 20, publicBaseUrl: '' };
  let changed = await patch('/api/admin/referrals/campaign', campaign, adminCookie); assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
  qr = await fetch(base + '/api/referrals/qr', { headers: { cookie: customerCookie, 'x-forwarded-host': 'attacker.example' } }); assert.equal(qr.status, 503, 'missing canonical URL fails safely');
  changed = await patch('/api/admin/referrals/campaign', { ...campaign, publicBaseUrl: 'https://purainamart.example/path' }, adminCookie); assert.equal(changed.response.status, 400, 'non-canonical paths are rejected');
  changed = await patch('/api/admin/referrals/campaign', { ...campaign, publicBaseUrl: 'https://purainamart.example' }, adminCookie); assert.equal(changed.response.status, 200);
  const dashboard = await fetch(base + '/api/referrals/me', { headers: { cookie: customerCookie } }); const data = await dashboard.json(); assert.equal(data.referralUrlBase, 'https://purainamart.example');
  qr = await fetch(base + '/api/referrals/qr', { headers: { cookie: customerCookie, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' } }); assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type') || '', /image\/svg\+xml/);
  const svg = await qr.text(); assert.doesNotMatch(svg, /attacker\.example/);
});
