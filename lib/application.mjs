import { startMediaCleanup } from './admin-media.mjs';
import crypto from 'node:crypto';
import { MongoRepository, fail, pageOptions } from './mongo-repository.mjs';
import { cookies, sessionCookie, originFor, normalizePhone, createAuthApi, resolveIdentity, requireUser, requireAdmin, requireRider } from './api-auth.mjs';
import { handleCustomerApi, checkoutApi, cancellationApi } from './api-customer.mjs';
import { handleAdminApi, orderForAdmin } from './api-admin.mjs';
import { handleRiderApi, riderOrderDetails } from './api-rider.mjs';
import { notificationList, saveDevice, preferences, savePreferences, startNotificationWorkers } from './mongo-notifications.mjs';
import { publicWebMessagingConfig } from './firebase-push.mjs';
import { jsonReply } from './http-performance.mjs';

export function securityHeaders(production = false) {
  return { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(self)', 'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://accounts.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://accounts.google.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://fcm.googleapis.com https://www.googleapis.com https://api.cloudinary.com; frame-src https://accounts.google.com" + (production ? '; upgrade-insecure-requests' : ''), ...(production ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}) };
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1000000) fail(413, 'Request body is too large.'); }
  if (!raw) return {};
  let parsed; try { parsed = JSON.parse(raw); } catch { fail(400, 'Request body must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Request body must be a JSON object.');
  return parsed;
}
export function createApplication({ db, client, env = process.env, publicDir, workers = true, logger = console }) {
  if (!db || !client) throw new TypeError('The application requires an initialized MongoDB database and client.');
  const repo = new MongoRepository(db, client), production = env.NODE_ENV === 'production', auth = createAuthApi(repo, env);
  const mediaWorker = workers ? startMediaCleanup(repo) : null;
  const worker = workers ? startNotificationWorkers(repo, { logger }) : null;
  const catalogueCache = new Map();
  async function hydrate(ctx, write = false) {
    // Session documents use SHA-256 token hashes and native BSON TTL dates.
    ctx.user = !ctx.route.startsWith('/api/admin/') && !ctx.route.startsWith('/api/rider/') ? await resolveIdentity(repo, ctx.req, 'customer', { write }) : null;
    ctx.admin = ctx.route.startsWith('/api/admin/') ? await resolveIdentity(repo, ctx.req, 'admin', { write }) : null;
    ctx.rider = ctx.route.startsWith('/api/rider/') ? await resolveIdentity(repo, ctx.req, 'rider', { write }) : null;
    ctx.ownerId = ctx.user?.id || ctx.guestOwner;
  }
  async function noticeApi(ctx) {
    const match = ctx.route.match(/^\/api\/(rider\/|admin\/)?notifications(?:\/(.*))?$/);
    if (!match) return undefined;
    const kind = match[1] === 'rider/' ? 'rider' : match[1] === 'admin/' ? 'admin' : 'customer', action = match[2] || '';
    if (kind === 'admin' && !['devices', 'devices/deactivate', 'preferences'].includes(action)) return undefined;
    const owner = kind === 'rider' ? requireRider(ctx) : kind === 'admin' ? requireAdmin(ctx) : requireUser(ctx);
    if (ctx.method === 'POST' && ['devices', 'devices/deactivate'].includes(action)) return saveDevice(repo, kind, owner.id, ctx.body, action.endsWith('/deactivate'));
    if (action === 'preferences' && ctx.method === 'GET') return { preferences: await preferences(repo, kind, owner.id) };
    if (action === 'preferences' && ctx.method === 'PATCH') return savePreferences(repo, kind, owner.id, ctx.body);
    if (!action && ctx.method === 'GET') return notificationList(repo, kind, owner.id, pageOptions(ctx.url));
    const collection = kind === 'rider' ? 'riderNotifications' : 'notifications', ownership = kind === 'rider' ? { riderId: owner.id } : { userId: owner.id };
    if (action === 'read-all' && ctx.method === 'POST') { await repo.updateMany(collection, { ...ownership, readAt: null }, { $set: { readAt: new Date().toISOString() } }); return { unread: 0 }; }
    const read = action.match(/^([^/]+)\/read$/);
    if (read && ctx.method === 'POST') {
      const notification = await repo.one(collection, { ...ownership, id: read[1] }); if (!notification) fail(404, 'Notification not found');
      notification.readAt ||= new Date().toISOString(); await repo.flush();
      return { ok: true, notification, unread: await repo.count(collection, { ...ownership, readAt: null }) };
    }
    return undefined;
  }
  async function dispatch(ctx) {
    for (const handler of [() => auth.handle(ctx), () => noticeApi(ctx), () => handleAdminApi(repo, ctx), () => handleRiderApi(repo, ctx), () => handleCustomerApi(repo, ctx)]) {
      const value = await handler();
      if (value !== undefined) {
        if (ctx.status >= 400) fail(ctx.status, value.error || 'Request failed.', value.code);
        return value;
      }
    }
    fail(404, 'API route not found', 'NOT_FOUND');
  }
  async function handle(req, res) {
    const started = performance.now();
    const headers = { ...securityHeaders(production), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    const reply = (_res, status, body, responseHeaders) => jsonReply(req, res, status, body, responseHeaders, started);
    let ctx, limitedIdentity;
    try {
      const url = new URL(req.url, 'http://localhost');
      let route; try { route = decodeURIComponent(url.pathname); } catch { fail(400, 'Malformed URL'); }
      ctx = { req, url, route, method: req.method, body: {}, headers, status: 200, production, publicDir };
      // This exact allowlist contains no identity-dependent response. Never
      // hydrate a session or issue guest cookies on a shared catalogue response.
      if (req.method === 'GET' && /^\/api\/(products(?:\/[^/]+)?|categories|delivery-areas)$/.test(route)) {
        headers['cache-control'] = 'public, max-age=15';
        const key = url.pathname+url.search, cached = catalogueCache.get(key);
        if (cached?.expires > Date.now()) return reply(res,200,cached.value,headers);
        const value = await repo.context.run({documents:new Map(),readCache:new Map()},()=>handleCustomerApi(repo,ctx));
        if (Buffer.byteLength(JSON.stringify(value)) < 256000) {
          if(catalogueCache.size>=64)catalogueCache.delete(catalogueCache.keys().next().value);
          catalogueCache.set(key,{value,expires:Date.now()+15000});
        }
        return reply(res,200,value,headers);
      }
      if (req.method === 'GET' && ['/api/health', '/api/health/ready'].includes(route)) {
        if (route.endsWith('/ready')) await db.command({ ping: 1 });
        return reply(res, 200, { status: route.endsWith('/ready') ? 'ready' : 'ok', database: 'mongodb', ready: true, mode: production ? 'production' : 'development', payments: { cod: true, online: false }, authConfigured: { google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) } }, headers);
      }
      if (production && ['POST','PATCH','PUT','DELETE'].includes(req.method) && (!originFor(req) || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))) fail(403, 'Request origin could not be verified.');
      if (!['GET', 'HEAD'].includes(req.method)) ctx.body = await readBody(req);
      const gid = cookies(req).gid, guestId = /^[A-Za-z0-9_-]{32,80}$/.test(gid || '') ? gid : crypto.randomBytes(24).toString('base64url');
      ctx.guestOwner = `guest:${guestId}`;
      if (gid !== guestId) headers['set-cookie'] = sessionCookie('gid', guestId, req, 365 * 86400, production);
      if (route === '/api/notifications/config' && req.method === 'GET') return reply(res, 200, { ...publicWebMessagingConfig(env), serverConfigured: Boolean(env.FCM_PROJECT_ID) }, headers);
      if (route === '/api/notifications/firebase-config.js' && req.method === 'GET') { res.writeHead(200, { ...headers, 'content-type': 'application/javascript; charset=utf-8' }); return res.end(`self.ZEPTO_FCM_CONFIG=${JSON.stringify(publicWebMessagingConfig(env).firebase || {})};`); }
      // OAuth exchange is an external effect and must not be retried by MongoDB.
      if (route === '/api/auth/google/callback' && req.method === 'POST') ctx.googleIdentity = await auth.googleIdentity(ctx);
      const login = req.method === 'POST' && ['/api/auth/password/login', '/api/admin/auth/login', '/api/rider/auth/login', '/api/auth/register'].includes(route);
      if (login) { limitedIdentity = normalizePhone(ctx.body.phone) || 'invalid'; await auth.rateLimit(ctx, limitedIdentity); }
      const reward = route.match(/^\/api\/rewards\/([^/]+)\/redeem$/);
      const cancel = route.match(/^\/api\/(rider\/)?orders\/([^/]+)\/cancel$/);
      const adminCancel = route.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
      let result;
      if (req.method === 'POST' && (route === '/api/orders' || reward || cancel) || req.method === 'PATCH' && adminCancel && ctx.body.status === 'Cancelled') {
        await hydrate(ctx);
        if (cancel) result = await cancellationApi(repo, ctx, cancel[2], cancel[1] ? 'rider' : 'customer');
        else if (adminCancel) { requireAdmin(ctx); result = await cancellationApi(repo, ctx, adminCancel[1], 'admin'); if (result.order) result.order = await orderForAdmin(repo, result.order); }
        else result = await checkoutApi(repo, ctx, reward?.[1]);
        if (cancel?.[1] && result.order) result.order = await riderOrderDetails(repo, result.order);
      } else if (['GET', 'HEAD'].includes(req.method) || route === '/api/auth/google/start') {
        result = await repo.context.run({ documents: new Map(), readCache: new Map() }, async () => { await hydrate(ctx); return dispatch(ctx); });
      } else {
        result = await repo.transaction(async () => { ctx.status = 200; await hydrate(ctx, true); return dispatch(ctx); });
      }
      if (login && ctx.status < 400) {
        // Authentication has committed; cleanup failure must not turn a valid
        // login into an apparent failure or cause the client to register again.
        try { await auth.rateLimit(ctx, limitedIdentity, false, true); } catch {}
      }
      if (!['GET','HEAD'].includes(req.method)) catalogueCache.clear();
      if (ctx.raw !== undefined) { res.writeHead(ctx.status, headers); return res.end(ctx.raw); }
      return reply(res, ctx.status, result, headers);
    } catch (error) {
      headers['cache-control'] = 'no-store';
      delete headers['set-cookie'];
      if (ctx && limitedIdentity && [400,401,403].includes(error.status)) {
        try { await repo.transaction(() => auth.rateLimit(ctx, limitedIdentity, true)); } catch {}
      }
      const duplicate = error.code === 11000;
      const status = error.status || (duplicate ? 409 : 503);
      if (!error.status) logger.error(JSON.stringify({ event: 'api_request_failed', route: ctx?.route?.replace(/[A-Fa-f0-9-]{24,}/g, ':id'), name: error.name, code: error.code || 'UNKNOWN' }));
      return reply(res, status, { error: error.status ? error.message : duplicate ? 'A record with these details already exists. Please refresh and try again.' : 'The application data store is temporarily unavailable. Please retry.', code: error.status ? error.code : duplicate ? 'DUPLICATE_RECORD' : 'DATABASE_OPERATION_FAILED' }, headers);
    }
  }
  return { handle, repo, close: async () => { await worker?.stop(); await mediaWorker?.stop(); } };
}
