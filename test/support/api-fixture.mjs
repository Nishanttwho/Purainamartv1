import { once } from 'node:events';
import path from 'node:path';
import { createHttpServer } from '../../lib/http-server.mjs';
import { hashPassword } from '../../lib/password.mjs';
import { hashSessionId } from '../../lib/mongodb-auth.mjs';
import { fakeMongo } from './fake-mongo.mjs';

export const password = 'testing-password-phrase-24';
export const passwordHash = await hashPassword(password);
const token = kind => kind.padEnd(40, 'x');
export async function fixture(t, overrides = {}, options = {}) {
  const mongo = fakeMongo({
    users: [{ id: 'u1', name: 'Customer One', phone: '9444444001', passwordHash, referralCode: 'REFCUSTOMER1', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'u2', name: 'Customer Two', phone: '9444444002', passwordHash, referralCode: 'REFCUSTOMER2', createdAt: '2026-01-01T00:00:00.000Z' }],
    admins: [{ id: 'configured-admin', name: 'Administrator', phone: '9990000001', passwordHash }],
    riders: [{ id: 'r1', name: 'Rider One', phone: '9333333001', passwordHash, isActive: true, status: 'online', mustChangePassword: false }],
    sessions: [['customer', 'u1'], ['customer2', 'u2'], ['admin', 'configured-admin'], ['rider', 'r1']].map(([kind, ownerId]) => ({ kind: kind === 'customer2' ? 'customer' : kind, idHash: hashSessionId(token(kind)), ownerId, authMethod: 'password', createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000) })),
    categories: [{ id: 'pantry', name: 'Pantry', isActive: true }],
    products: [{ id: 'p1', name: 'Test Rice Pack', category: 'pantry', price: 100, mrp: 120, stock: 20, isActive: true, rank: 1 }, { id: 'loose', name: 'Test Loose Rice', category: 'pantry', price: 100, mrp: null, stock: 2000, saleType: 'loose', measurementUnit: 'g', isActive: true, variants: [{ id: 'v250', label: '250 g', quantityBase: 250, unit: 'g', price: 25, mrp: null, stock: 2000, isActive: true }, { id: 'v500', label: '500 g', quantityBase: 500, unit: 'g', price: 50, mrp: null, stock: 2000, isActive: true }] }],
    deliveryAreas: [{ id: 'area1', name: 'Test Area', isActive: true, deliveryCharge: 20, minimumOrder: 0, freeDeliveryThreshold: 500, etaMinMinutes: 10, etaMaxMinutes: 20 }],
    addresses: [{ id: 'a1', customerId: 'u1', recipientName: 'Customer One', phone: '9444444001', label: 'Home', city: 'Test City', line1: '1 Test Street', deliveryAreaId: 'area1', isDefault: true }, { id: 'a2', customerId: 'u2', recipientName: 'Customer Two', phone: '9444444002', label: 'Home', city: 'Test City', line1: '2 Test Street', deliveryAreaId: 'area1', isDefault: true }],
    settings: [{ key: 'dispatchSettings', value: { designatedRiderId: 'r1' } }],
    coupons: [{ code: 'SAVE10', label: 'Save ten', discountType: 'fixed', discount: 10, minimum: 0, isActive: true, redemptionCount: 0, maxRedemptions: 10, maxRedemptionsPerCustomer: 1 }],
    ...overrides
  });
  const { server, application } = createHttpServer({ ...mongo, workers: false, publicDir: path.resolve(import.meta.dirname, '../../public'), env: { NODE_ENV: 'development', ADMIN_PHONE: '9990000001', ADMIN_PASSWORD_HASH: passwordHash, ...options.env }, logger: { error() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await application.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = { customer: `sid=${token('customer')}`, customer2: `sid=${token('customer2')}`, admin: `asid=${token('admin')}`, rider: `rsid=${token('rider')}` };
  async function call(route, { method = 'GET', body, as = 'customer', cookie: explicitCookie, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(explicitCookie || cookie[as] ? { cookie: explicitCookie || cookie[as] } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie'), headers: response.headers };
  }
  async function order(key = 'test-checkout-key-0001') {
    const added = await call('/api/cart/items', { method: 'POST', body: { productId: 'p1', delta: 1 } });
    if (added.status !== 200) throw new Error(JSON.stringify(added));
    return call('/api/orders', { method: 'POST', body: { addressId: 'a1', paymentMethod: 'cod', idempotencyKey: key } });
  }
  return { ...mongo, call, order, cookie, base, application };
}
