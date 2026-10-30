import crypto from 'node:crypto';
import { hashPassword, verifyPassword, validPassword, isPasswordHash } from './password.mjs';
import { createDurableSession, hashSessionId } from './mongodb-auth.mjs';
import { mergeMongoGuestData } from './mongodb-shopping.mjs';
import { resolveGoogleCustomer, verifyGoogleIdToken } from './google-auth.mjs';
import { attributeReferral } from './mongo-referrals.mjs';
import { safeUser, safeRider, newId, nowIso } from './commerce.mjs';
import { fail } from './mongo-repository.mjs';
import { saveDevice } from './mongo-notifications.mjs';

export function cookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const at = item.indexOf('='); if (at < 0) continue;
    try { result[decodeURIComponent(item.slice(0, at).trim())] = decodeURIComponent(item.slice(at + 1)); } catch {}
  }
  return result;
}
export function originFor(req) {
  try {
    const origin = new URL(req.headers.origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const protocol = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    return origin.origin === req.headers.origin && origin.host.toLowerCase() === host.toLowerCase() && origin.protocol === protocol + ':' ? origin.origin : null;
  } catch { return null; }
}
export const sessionCookie = (name, value, req, seconds, production = false, path = '/') => `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${seconds}${production || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
export const normalizePhone = value => { const n = String(value || '').replace(/\D/g, ''); return n.length === 12 && n.startsWith('91') ? n.slice(2) : n; };
export const requireUser = ctx => ctx.user || fail(401, 'Sign in to continue', 'AUTH_REQUIRED');
export const requireAdmin = ctx => ctx.admin || fail(401, 'Sign in as an authorized administrator', 'ADMIN_AUTH_REQUIRED');
export function requireRider(ctx, allowPasswordChange = false) {
  const rider = ctx.rider || fail(401, 'Sign in with an authorized rider account', 'RIDER_AUTH_REQUIRED');
  if (rider.isActive === false) fail(403, 'This rider account is inactive.');
  if (!allowPasswordChange && rider.mustChangePassword) fail(403, 'Set a new password before using Rider operations.', 'PASSWORD_CHANGE_REQUIRED');
  return rider;
}
export async function resolveIdentity(repo, req, kind, { write = false } = {}) {
  const token = cookies(req)[{ customer: 'sid', rider: 'rsid', admin: 'asid' }[kind]];
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token || '')) return null;
  const session = await repo.collection('sessions').findOne({ kind, idHash: hashSessionId(token), expiresAt: { $gt: new Date() }, authMethod: { $in: kind === 'customer' ? ['password', 'google'] : ['password'] } }, repo.options());
  if (!session) return null;
  const collection = { customer: 'users', admin: 'admins', rider: 'riders' }[kind];
  const owner = await repo.one(collection, { id: session.ownerId });
  if (!owner || owner.blockedAt || owner.isActive === false) return null;
  if (write) await repo.update(collection, { id: owner.id }, { $inc: { authRevision: 1 } });
  return owner;
}
export function createAuthApi(repo, env) {
  const production = env.NODE_ENV === 'production';
  const adminPhone = normalizePhone(env.ADMIN_PHONE), adminPasswordHash = env.ADMIN_PASSWORD_HASH || '';
  const dummyPromise = hashPassword(crypto.randomBytes(32).toString('hex'));
  async function rateLimit(ctx, identity, failed = false, clear = false) {
    // Durable, cross-process throttling. Hash keys avoid storing raw IP/phone in
    // the throttle collection; expiry is enforced even before TTL cleanup.
    for (const [value, limit] of [[`phone:${identity}`, 8], [`ip:${ctx.req.socket.remoteAddress}`, 30]]) {
      const id = crypto.createHash('sha256').update(value).digest('hex');
      if (clear) { if (value.startsWith('phone:')) await repo.remove('authAttempts', { id }); continue; }
      const row = await repo.one('authAttempts', { id });
      const active = row && row.expiresAt > new Date();
      if (!failed && active && row.failures >= limit) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
      if (failed) await repo.update('authAttempts', { id }, { $set: { expiresAt: active ? row.expiresAt : new Date(Date.now() + 900000), failures: active ? row.failures + 1 : 1 } }, { upsert: true });
    }
  }
  async function session(ctx, owner, kind, authMethod) {
    const sessionId = crypto.randomBytes(32).toString('base64url'), seconds = kind === 'admin' ? 28800 : 604800;
    await createDurableSession(repo.db, { sessionId, ownerId: owner.id, kind, authMethod, expiresAt: Date.now() + seconds * 1000 }, repo.options());
    if (kind === 'customer' && /^guest:[A-Za-z0-9_-]{32,80}$/.test(ctx.guestOwner)) await mergeMongoGuestData(repo.db, owner.id, ctx.guestOwner, repo.options());
    ctx.headers['set-cookie'] = sessionCookie({ customer: 'sid', rider: 'rsid', admin: 'asid' }[kind], sessionId, ctx.req, seconds, production);
  }
  async function googleIdentity(ctx) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'Google sign-in is not configured.', 'GOOGLE_AUTH_NOT_CONFIGURED');
    const origin = originFor(ctx.req);
    if (!origin || ctx.req.headers['x-requested-with'] !== 'XMLHttpRequest') fail(403, 'Google sign-in request could not be validated.', 'INVALID_ORIGIN');
    const supplied = String(ctx.body.state || ''), stored = cookies(ctx.req).google_oauth_state || '';
    if (supplied.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(stored) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(stored))) fail(401, 'Google sign-in expired. Please try again.', 'GOOGLE_STATE_INVALID');
    if (!ctx.body.code || String(ctx.body.code).length > 4096) fail(400, 'Google did not return an authorization code.');
    let response;
    try { response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ code: ctx.body.code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: origin, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(12000) }); }
    catch { fail(502, 'Google sign-in is temporarily unavailable.', 'GOOGLE_PROVIDER_UNAVAILABLE'); }
    if (!response.ok) fail(401, 'Google could not verify this sign-in.', 'GOOGLE_CODE_REJECTED');
    try { return await verifyGoogleIdToken((await response.json()).id_token, env.GOOGLE_CLIENT_ID); }
    catch { fail(401, 'Google returned an invalid identity.', 'GOOGLE_ID_TOKEN_INVALID'); }
  }
  async function handle(ctx) {
    const { route, method, body, req } = ctx;
    if (route === '/api/auth/google/start' && method === 'POST') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'Google sign-in is not configured.', 'GOOGLE_AUTH_NOT_CONFIGURED');
      if (!originFor(req)) fail(403, 'Google sign-in must start from this application.', 'INVALID_ORIGIN');
      const state = crypto.randomBytes(32).toString('base64url');
      ctx.headers['set-cookie'] = sessionCookie('google_oauth_state', state, req, 300, production, '/api/auth/google');
      return { clientId: env.GOOGLE_CLIENT_ID, state };
    }
    if (route === '/api/auth/google/callback' && method === 'POST') {
      const identity = ctx.googleIdentity;
      const candidates = await repo.list('users', { $or: [{ googleSub: identity.sub }, { email: identity.email.trim().toLowerCase() }] }, { limit: 10 });
      let resolved;
      try { resolved = resolveGoogleCustomer(candidates, identity, { createReferralCode: () => `ZP${crypto.randomBytes(6).toString('hex').toUpperCase()}` }); }
      catch { fail(409, 'This email is already linked to another customer account.', 'GOOGLE_ACCOUNT_CONFLICT'); }
      const { user, isNewUser } = resolved;
      if (user.blockedAt) fail(403, 'This account is blocked. Contact PurainaMart support.');
      const referral = isNewUser ? await attributeReferral(repo, user, body.referralCode) : { status: 'existing_account' };
      if (isNewUser) await repo.insert('users', user);
      await session(ctx, user, 'customer', 'google');
      ctx.headers['set-cookie'] = [ctx.headers['set-cookie'], sessionCookie('google_oauth_state', '', req, 0, production, '/api/auth/google')];
      return { user: safeUser(user), referral };
    }
    if (route === '/api/auth/register' && method === 'POST') {
      const phone = normalizePhone(body.phone), name = String(body.name || '').trim(), password = String(body.password || '');
      const error = 'Unable to create an account. Check your details, or sign in if you already have an account.';
      if (!/^\d{10}$/.test(phone) || name.length < 2 || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name) || !validPassword(password) || body.confirmPassword !== password) fail(400, error);
      if (await repo.exists('users', { phone })) fail(400, error);
      const user = { id: newId(), phone, name, passwordHash: await hashPassword(password), referralCode: `ZP${crypto.randomBytes(6).toString('hex').toUpperCase()}`, createdAt: nowIso() };
      const referral = await attributeReferral(repo, user, body.referralCode);
      await repo.insert('users', user); await session(ctx, user, 'customer', 'password'); ctx.status = 201;
      return { user: safeUser(user), referral };
    }
    const loginKind = ({ '/api/auth/password/login': 'customer', '/api/admin/auth/login': 'admin', '/api/rider/auth/login': 'rider' })[route];
    if (loginKind && method === 'POST') {
      const phone = normalizePhone(body.phone);
      const collection = { customer: 'users', admin: 'admins', rider: 'riders' }[loginKind];
      let owner = loginKind === 'admin' ? phone === adminPhone && isPasswordHash(adminPasswordHash) ? { id: 'configured-admin', phone, name: env.ADMIN_NAME || 'Administrator', passwordHash: adminPasswordHash } : null : await repo.one(collection, { phone });
      const ok = await verifyPassword(String(body.password || ''), owner?.passwordHash || await dummyPromise);
      if (!/^\d{10}$/.test(phone) || !ok || !owner?.passwordHash || owner.isActive === false) fail(401, 'Unable to sign in with those credentials.');
      if (owner.blockedAt) fail(403, 'This account is blocked. Contact PurainaMart support.');
      if (loginKind === 'admin') await repo.update('admins', { id: owner.id }, { $set: owner }, { upsert: true });
      else await repo.update(collection, { id: owner.id }, { $inc: { authRevision: 1 } });
      await session(ctx, owner, loginKind, 'password');
      return { [loginKind === 'customer' ? 'user' : loginKind]: loginKind === 'customer' ? safeUser(owner) : loginKind === 'rider' ? safeRider(owner) : { id: owner.id, phone: owner.phone, name: owner.name } };
    }
    const logoutKind = ({ '/api/auth/logout': 'customer', '/api/admin/auth/logout': 'admin', '/api/rider/auth/logout': 'rider' })[route];
    if (logoutKind && method === 'POST') {
      const cookieName = { customer: 'sid', admin: 'asid', rider: 'rsid' }[logoutKind], token = cookies(req)[cookieName];
      if (token && /^[A-Za-z0-9_-]{32,100}$/.test(token)) await repo.remove('sessions', { kind: logoutKind, idHash: hashSessionId(token) });
      const owner = ctx[{ customer: 'user', admin: 'admin', rider: 'rider' }[logoutKind]];
      if (body.deviceKey && owner) await saveDevice(repo, logoutKind, owner.id, body, true);
      ctx.headers['set-cookie'] = sessionCookie(cookieName, '', req, 0, production);
      return { ok: true };
    }
    if (route === '/api/auth/session' && method === 'GET') return { user: safeUser(requireUser(ctx)) };
    if (route === '/api/admin/session' && method === 'GET') { const admin = requireAdmin(ctx); return { admin: { id: admin.id, name: admin.name, phone: admin.phone } }; }
    if (route === '/api/admin/config' && method === 'GET') { requireAdmin(ctx); return { configured: Boolean(adminPhone && isPasswordHash(adminPasswordHash)) }; }
    if (['/api/auth/password/set', '/api/rider/auth/password'].includes(route) && method === 'POST') {
      const rider = route.includes('/rider/'), owner = rider ? requireRider(ctx, true) : requireUser(ctx);
      const password = String(body.newPassword || '');
      if (!validPassword(password) || body.confirmPassword !== password) fail(400, 'Use matching passwords between 12 and 128 characters.');
      if (owner.passwordHash && !(rider && owner.mustChangePassword) && !await verifyPassword(String(body.currentPassword || ''), owner.passwordHash)) fail(401, 'Current password is incorrect.');
      if (!rider && !/^\d{10}$/.test(owner.phone || '')) fail(409, 'A verified mobile number is required for password sign-in.');
      owner.passwordHash = await hashPassword(password); owner.passwordChangedAt = nowIso();
      if (rider) owner.mustChangePassword = false;
      await repo.remove('sessions', { kind: rider ? 'rider' : 'customer', ownerId: owner.id });
      await session(ctx, owner, rider ? 'rider' : 'customer', 'password');
      return rider ? { rider: safeRider(owner) } : { ok: true };
    }
    return undefined;
  }
  return { handle, googleIdentity, rateLimit };
}
