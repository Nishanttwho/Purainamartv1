// Existing screens filter their loaded lists locally. Fetch bounded pages so
// records after the first database page remain accessible to those controls.
const routes = {
  '/api/products': ['products'], '/api/categories': ['categories'],
  '/api/orders': ['orders'], '/api/notifications': ['notifications'],
  '/api/referrals/me': ['referrals', 'rewards'],
  '/api/admin/referrals': ['referrals', 'rewards'],
  '/api/admin/products': ['products'], '/api/admin/categories': ['categories'],
  '/api/admin/coupons': ['coupons'], '/api/admin/customers': ['customers'],
  '/api/admin/orders': ['orders'], '/api/admin/riders': ['riders'],
  '/api/admin/rider-delivery-summaries': ['riders'],
  '/api/admin/delivery-areas': ['areas'],
  '/api/rider/bootstrap': ['availableOrders', 'assignedOrders', 'deliveredOrders'],
  '/api/rider/orders': ['availableOrders', 'assignedOrders', 'deliveredOrders'],
  '/api/admin/bootstrap': ['products', 'customers', 'orders', 'riders', 'coupons', 'referralRewards.referrals', 'referralRewards.rewards']
};
const get = (data, path) => path.split('.').reduce((value, key) => value?.[key], data);
const set = (data, path, value) => { const keys = path.split('.'), key = keys.pop(); get(data, keys.join('.'))[key] = value; };
export async function paginatedRequest(request, input, options = {}) {
  const url = new URL(input, 'http://localhost');
  const fields = routes[url.pathname] || (/^\/api\/admin\/customers\/[^/]+$/.test(url.pathname) ? ['orders', 'coupons'] : null);
  if ((options.method || 'GET').toUpperCase() !== 'GET' || !fields || url.searchParams.has('offset') || url.searchParams.has('limit')) return request(input, options);
  const limit = 200;
  url.searchParams.set('limit', String(limit));
  let result, page;
  for (let offset = 0; ; offset += limit) {
    url.searchParams.set('offset', String(offset));
    page = await request(url.pathname + url.search, options);
    if (!result) result = page;
    else for (const field of fields) {
      const old = get(result, field) || [], rows = get(page, field) || [];
      const seen = new Set(old.map(row => row.id || row.code));
      const merged = [...old, ...rows.filter(row => !seen.has(row.id || row.code))];
      if (field.includes('.')) set(result, field, merged); else result[field] = merged;
    }
    if (!fields.some(field => (get(page, field)?.length || 0) === limit)) return result;
    if (offset >= 1000000 - limit) throw new Error('This list is too large to load. Narrow the search.');
  }
}
