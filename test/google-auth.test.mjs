import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
