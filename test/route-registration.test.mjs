import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/api-fixture.mjs';

// Frozen inventory of the preserved application's non-OTP routes, including
// dynamic handlers. Domain tests exercise successful writes and permissions.
const routes = {
  GET: ['/api/health','/api/health/ready','/api/bootstrap','/api/products','/api/products/p1','/api/categories','/api/cart','/api/wishlist','/api/addresses','/api/orders','/api/orders/missing','/api/delivery-areas','/api/coupons','/api/referrals/validate','/api/referrals/me','/api/referrals/qr','/api/rewards/missing/quote','/api/auth/session','/api/notifications','/api/notifications/config','/api/notifications/firebase-config.js','/api/notifications/preferences','/api/admin/config','/api/admin/session','/api/admin/bootstrap','/api/admin/products','/api/admin/categories','/api/admin/coupons','/api/admin/customers','/api/admin/customers/u1','/api/admin/delivery-areas','/api/admin/riders','/api/admin/riders/r1','/api/admin/referrals','/api/admin/rider-delivery-summaries','/api/admin/cloudinary/signature','/api/admin/notifications','/api/rider/bootstrap','/api/rider/orders','/api/rider/orders/missing','/api/rider/notifications'],
  POST: ['/api/auth/google/start','/api/auth/google/callback','/api/auth/password/login','/api/auth/password/set','/api/auth/register','/api/cart/items','/api/coupons/apply','/api/delivery-area/select','/api/wishlist/toggle','/api/addresses','/api/orders','/api/orders/missing/cancel','/api/rewards/missing/redeem','/api/notifications/devices','/api/notifications/devices/deactivate','/api/notifications/missing/read','/api/notifications/read-all','/api/admin/auth/login','/api/admin/products','/api/admin/categories','/api/admin/coupons','/api/admin/delivery-areas','/api/admin/riders','/api/admin/customers/u1/block','/api/admin/customers/u1/coupons','/api/admin/customers/u1/coupons/missing/revoke','/api/admin/customers/u1/coupons/missing/notify','/api/admin/orders/missing/assign','/api/admin/notifications','/api/admin/notifications/estimate','/api/admin/notifications/test','/api/admin/notifications/devices','/api/admin/notifications/devices/deactivate','/api/admin/notifications/campaigns/missing/cancel','/api/admin/notifications/campaigns/missing/duplicate','/api/rider/auth/login','/api/rider/auth/password','/api/rider/status','/api/rider/orders/missing/accept','/api/rider/orders/missing/reject','/api/rider/orders/missing/cancel','/api/rider/orders/missing/payment','/api/rider/orders/missing','/api/rider/notifications/devices','/api/rider/notifications/devices/deactivate','/api/rider/notifications/missing/read'],
  PATCH: ['/api/notifications/preferences','/api/addresses/a1/default','/api/admin/products/p1','/api/admin/categories/pantry','/api/admin/coupons/SAVE10','/api/admin/delivery-areas/area1','/api/admin/customers/u1','/api/admin/riders/r1','/api/admin/orders/missing/status','/api/admin/banners','/api/admin/hero-fruit','/api/admin/dispatch-settings','/api/admin/referrals/campaign','/api/admin/notifications/templates/announcement']
};
test('Mongo HTTP route registration covers the preserved customer, admin and rider API inventory', async t => {
  const f = await fixture(t);
  for (const [method, paths] of Object.entries(routes)) for (const route of paths) {
    const as = route.startsWith('/api/admin/') ? 'admin' : route.startsWith('/api/rider/') ? 'rider' : 'customer';
    const result = await f.call(route, { method, as, ...(method === 'GET' ? {} : { body: {} }) });
    assert.notEqual(result.data?.code, 'NOT_FOUND', `${method} ${route} is registered`);
    assert.ok(result.status < 500 || ['GOOGLE_AUTH_NOT_CONFIGURED'].includes(result.data?.code) || route === '/api/admin/cloudinary/signature' || route === '/api/referrals/qr', `${method} ${route}: ${JSON.stringify(result.data)}`);
  }
  for (const route of ['/api/auth/logout','/api/admin/auth/logout','/api/rider/auth/logout']) assert.equal((await f.call(route,{method:'POST',body:{}})).status,200);
});
