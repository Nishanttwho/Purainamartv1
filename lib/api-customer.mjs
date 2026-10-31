import { requireUser, resolveIdentity } from './api-auth.mjs';
import { fail, pageOptions } from './mongo-repository.mjs';
import { safeUser, cartSummary, eligibleCoupons, couponEligible, addressForCustomer, deliveryQuote, resolveLine, makeOrder, newId, nowIso, referralDefaults } from './commerce.mjs';
import { listMongoProducts, listMongoCategories, getMongoProduct } from './mongodb-catalogue.mjs';
import { createMongoCodOrder } from './mongodb-cod-checkout.mjs';
import { cancelMongoCodOrder } from './mongodb-order-cancellation.mjs';
import { notificationList, createNotice } from './mongo-notifications.mjs';
import { referralDashboard, canonicalPublicBaseUrl } from './mongo-referrals.mjs';
import { defaultHomepageBanners } from './homepage-banners.mjs';
import QRCode from 'qrcode';

export async function customerBootstrap(repo, ctx) {
  const ownerId = ctx.ownerId, user = ctx.user, paging = pageOptions(ctx.url, 100);
  const compact = ctx.url.searchParams.get('compact') === '1';
  const [catalogue, categoryData, cart, saved, preferences, wishlist, notices, banners, hero, orders, deliveryAreas] = await repo.reads([
    () => listMongoProducts(repo.db, paging), () => listMongoCategories(repo.db),
    () => cartSummary(repo, ownerId), () => user ? repo.all('addresses', { customerId: user.id }) : [],
    () => repo.one('shoppingPreferences', { ownerId }), () => wishlistProducts(repo, ownerId),
    () => user ? compact ? repo.count('notifications', { userId: user.id, readAt: null }).then(unread => ({ notifications: [], unread })) : notificationList(repo, 'customer', user.id, { limit: 30 }) : { notifications: [], unread: 0 },
    () => repo.setting('homepageBanners', defaultHomepageBanners()), () => repo.setting('homepageHeroFruitImage'),
    () => user && !compact ? repo.list('orders', { userId: user.id }, { limit: 5 }) : [],
    () => repo.all('deliveryAreas', { isActive: { $ne: false } })
  ]);
  const areas = new Map(deliveryAreas.map(area => [area.id, area]));
  const addresses = saved.map(({ customerId, pincode, ...row }) => ({ ...row, deliveryAreaName: areas.get(row.deliveryAreaId)?.name || null, deliveryAreaUnavailable: !areas.has(row.deliveryAreaId) }));
  return { mode: ctx.production ? 'production' : 'development', categories: categoryData.categories, products: catalogue.products, cataloguePagination: { offset: paging.skip, limit: paging.limit, count: catalogue.count }, homepageBanners: banners.filter(row => row.enabled).sort((a,b) => a.order-b.order), homepageHeroFruitImage: hero, cart, wishlist, user: safeUser(user), addresses, activeAddress: addresses.find(row => row.id === preferences?.addressId) || addresses.find(row => row.isDefault) || addresses[0] || null, orders, ...notices, notificationUnread: notices.unread, coupons: cart.couponOffers, activeCoupon: cart.activeCoupon, deliveryAreas, selectedDeliveryAreaId: cart.deliveryArea?.id || null, deliveryQuote: cart, deliveryCopy: 'Delivery eligibility and charges are configured for the selected area.' };
}
async function wishlistProducts(repo, ownerId) {
  const saved = await repo.one('wishlists', { ownerId });
  return saved?.productIds?.length ? repo.all('products', { id: { $in: saved.productIds }, isActive: { $ne: false } }) : [];
}
export async function handleCustomerApi(repo, ctx) {
  const { route, method, body, url, ownerId } = ctx;
  if (route === '/api/bootstrap' && method === 'GET') return customerBootstrap(repo, ctx);
  if (route === '/api/products' && method === 'GET') return listMongoProducts(repo.db, { search: url.searchParams.get('q') || '', category: url.searchParams.get('category') || 'all', ...pageOptions(url) });
  const productMatch = route.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && method === 'GET') { const product = await getMongoProduct(repo.db, productMatch[1]); if (!product) fail(404, 'Product not found'); return { product }; }
  if (route === '/api/categories' && method === 'GET') return listMongoCategories(repo.db, pageOptions(url));
  if (route === '/api/delivery-areas' && method === 'GET') return { areas: await repo.all('deliveryAreas', { isActive: { $ne: false } }) };
  if (['/api/account', '/api/account/profile'].includes(route)) {
    const user = requireUser(ctx);
    if (method === 'GET') return { user: safeUser(user) };
    if (method === 'PATCH') {
      if (Object.keys(body).some(k => !['name', 'email'].includes(k))) fail(400, 'Only name and email can be edited.');
      if (body.name !== undefined) { const name = String(body.name).trim(); if (name.length < 2 || name.length > 50) fail(400, 'Name must be between 2 and 50 characters.'); user.name = name; }
      if (body.email !== undefined) { const email = String(body.email || '').trim().toLowerCase(); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.'); if (email && await repo.exists('users', { id: { $ne: user.id }, email })) fail(409, 'That email is already linked to another customer.'); user.email = email || null; user.emailVerified = false; }
      return { user: safeUser(user) };
    }
  }
  if (route === '/api/cart' && method === 'GET') return cartSummary(repo, ownerId, { offers: url.searchParams.get('offers') !== '0' });
  if (route === '/api/cart/items' && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    const productId = String(body.productId || ''), variantId = body.variantId == null ? null : String(body.variantId);
    let cart = await repo.one('carts', { ownerId });
    if (!cart) { cart = { ownerId, items: [], version: 0 }; await repo.insert('carts', cart); cart = repo.track('carts', cart); }
    const at = cart.items.findIndex(row => row.productId === productId && (row.variantId || null) === variantId);
    const current = at < 0 ? 0 : cart.items[at].quantity;
    if (body.expectedQuantity !== undefined && (!Number.isSafeInteger(body.expectedQuantity) || body.expectedQuantity !== current)) fail(409, 'This cart changed in another window. Refresh its quantity and retry.', 'CART_CONFLICT');
    const delta = Number(body.delta), requested = method === 'DELETE' ? 0 : body.quantity !== undefined ? Number(body.quantity) : current + delta;
    if (!Number.isSafeInteger(requested) || body.quantity === undefined && method !== 'DELETE' && (!Number.isSafeInteger(delta) || delta === 0)) fail(400, 'Choose a valid quantity change.');
    const quantity = Math.max(0, Math.min(10, requested));
    const ids = [...new Set([...cart.items.map(row => row.productId), ...(quantity ? [productId] : [])])];
    const products = ids.length ? await repo.list('products', { id: { $in: ids } }, { limit: 200 }) : [];
    if (quantity > current) {
      const product = products.find(row => row.id === productId);
      if (!product) fail(404, 'Product not found');
      resolveLine(product, { productId, variantId, quantity }, { strict: true });
    }
    if (at >= 0) cart.items.splice(at, 1);
    if (quantity) cart.items.push({ productId, ...(variantId ? { variantId } : {}), quantity });
    if (cart.items.length > 100) fail(400, 'A cart can contain up to 100 quantity selections.');
    cart.version++; cart.updatedAt = nowIso();
    await repo.flush();
    const summary = await cartSummary(repo, ownerId, { cart, products, offers: url.searchParams.get('offers') !== '0' });
    if (summary.appliedCouponCode && !summary.activeCoupon) await repo.update('shoppingPreferences', { ownerId }, { $unset: { couponCode: '' } });
    return summary;
  }
  if (route === '/api/cart' && method === 'DELETE') {
    await repo.remove('carts', { ownerId });
    await repo.update('shoppingPreferences', { ownerId }, { $unset: { couponCode: '' } });
    return cartSummary(repo, ownerId);
  }
  if (route === '/api/coupons' && method === 'GET') return { coupons: await eligibleCoupons(repo, ownerId, 0, { allowBelowMinimum: true }) };
  if (['/api/coupons/apply', '/api/coupons/validate'].includes(route) && method === 'POST') {
    const code = String(body.code || '').trim().toUpperCase();
    const coupon = await repo.one('coupons', { code }), summary = await cartSummary(repo, ownerId);
    if (!await couponEligible(repo, coupon, ownerId, summary.subtotal)) fail(400, 'That coupon is not available for this cart.');
    if (coupon.discountType === 'free_delivery' && (!summary.deliveryAvailable || !summary.minimumOrderMet || summary.freeDeliveryUnlocked)) fail(409, 'Choose an eligible delivery area that does not already include free delivery.');
    if (route.endsWith('/validate')) return { valid: true, coupon };
    await repo.update('shoppingPreferences', { ownerId }, { $set: { couponCode: code } }, { upsert: true });
    // Discard only this explicitly changed document from the unit of work.
    return { coupon, cart: await cartSummaryFresh(repo, ownerId) };
  }
  if (route === '/api/coupons' && method === 'DELETE') {
    await repo.update('shoppingPreferences', { ownerId }, { $unset: { couponCode: '' } });
    return cartSummaryFresh(repo, ownerId);
  }
  if (route === '/api/wishlist' && method === 'GET') return { items: await wishlistProducts(repo, ownerId) };
  if (route === '/api/wishlist/toggle' && method === 'POST') {
    const productId = String(body.productId || '');
    if (!await repo.exists('products', { id: productId, isActive: { $ne: false } })) fail(404, 'Product not found');
    const saved = await repo.one('wishlists', { ownerId });
    const added = !saved?.productIds?.includes(productId);
    await repo.update('wishlists', { ownerId }, { [added ? '$addToSet' : '$pull']: { productIds: productId } }, { upsert: true });
    repo.forget('wishlists');
    return { items: await wishlistProducts(repo, ownerId), added };
  }
  if (route === '/api/delivery-area/select' && method === 'POST') {
    const area = await repo.one('deliveryAreas', { id: String(body.areaId || ''), isActive: { $ne: false } });
    if (!area) fail(409, 'That delivery area is unavailable.');
    let address;
    if (ctx.user) {
      address = await repo.one('addresses', { customerId: ownerId, ...(body.addressId ? { id: String(body.addressId) } : { isDefault: true }) });
      if (!address || address.deliveryAreaId !== area.id) fail(409, 'Choose a saved address that belongs to this delivery area.');
    }
    await repo.update('shoppingPreferences', { ownerId }, { $set: { areaId: area.id, ...(address ? { addressId: address.id } : {}) } }, { upsert: true });
    return { area: { id: area.id, name: area.name }, cart: await cartSummaryFresh(repo, ownerId) };
  }
  const addressMatch = route.match(/^\/api\/addresses(?:\/([^/]+)(?:\/(default))?)?$/);
  if (addressMatch) {
    const user = requireUser(ctx), id = addressMatch[1], isDefault = addressMatch[2];
    if (method === 'GET') { const addresses = []; for (const row of await repo.all('addresses', { customerId: user.id })) addresses.push(await addressForCustomer(repo, row)); return { addresses }; }
    const existing = id ? await repo.one('addresses', { customerId: user.id, id }) : null;
    if (id && !existing) fail(404, 'Address not found');
    if (method === 'DELETE' && id) {
      await repo.remove('addresses', { customerId: user.id, id });
      if (existing.isDefault) {
        const replacement = await repo.one('addresses', { customerId: user.id, id: { $ne: id } });
        if (replacement) replacement.isDefault = true;
        await repo.update('shoppingPreferences', { ownerId }, { $set: { addressId: replacement?.id || null, areaId: replacement?.deliveryAreaId || null } }, { upsert: true });
      } else await repo.update('shoppingPreferences', { ownerId, addressId: id }, { $unset: { addressId: '', areaId: '' } });
    } else if (method === 'PATCH' && isDefault) {
      await repo.updateMany('addresses', { customerId: user.id, id: { $ne: id } }, { $set: { isDefault: false } });
      existing.isDefault = true;
      await repo.update('shoppingPreferences', { ownerId }, { $set: { addressId: id, areaId: existing.deliveryAreaId } }, { upsert: true });
    } else if (method === 'POST' && !id || method === 'PATCH' && id) {
      const recipientName = String(body.recipientName || '').trim().slice(0, 80), phone = String(body.phone || '').replace(/\D/g, '').slice(-10);
      if (!recipientName || !/^\d{10}$/.test(phone) || !String(body.line1 || '').trim() || !String(body.city || '').trim()) fail(400, 'Enter recipient name, mobile number, street/building and city.');
      if (!String(body.deliveryAreaId || '').trim()) fail(400, 'Select a delivery area.');
      const area = await repo.one('deliveryAreas', { id: String(body.deliveryAreaId || ''), isActive: { $ne: false } });
      if (!area) fail(409, 'Select a currently enabled delivery area.');
      const next = { id: existing?.id || newId(), customerId: user.id, label: String(body.label || 'Home').slice(0, 24), recipientName, phone, line1: String(body.line1).trim().slice(0, 100), line2: String(body.line2 || '').trim().slice(0, 100), landmark: String(body.landmark || '').trim().slice(0, 100), city: String(body.city).trim().slice(0, 60), deliveryAreaId: area.id, isDefault: existing?.isDefault || !await repo.exists('addresses', { customerId: user.id }), createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso() };
      if (existing) Object.assign(existing, next); else { await repo.insert('addresses', next); ctx.status = 201; }
      ctx.savedAddressId = next.id;
      await repo.update('shoppingPreferences', { ownerId }, { $set: { addressId: next.id, areaId: area.id } }, { upsert: true });
    } else fail(405, 'Method not allowed');
    await repo.flush(); repo.forget('addresses'); repo.forget('shoppingPreferences');
    const addresses = []; for (const row of await repo.all('addresses', { customerId: user.id })) addresses.push(await addressForCustomer(repo, row));
    const prefs = await repo.one('shoppingPreferences', { ownerId });
    return { ok: true, addresses, address: addresses.find(row => row.id === ctx.savedAddressId), activeAddress: addresses.find(row => row.id === prefs?.addressId) || null, cart: await cartSummary(repo, ownerId) };
  }
  if (route === '/api/orders' && method === 'GET') return { orders: await repo.list('orders', { userId: requireUser(ctx).id }, pageOptions(url)) };
  const orderMatch = route.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && method === 'GET') { const order = await repo.one('orders', { id: orderMatch[1], userId: requireUser(ctx).id }); if (!order) fail(404, 'Order not found'); return { order }; }
  if (route === '/api/referrals/validate' && method === 'GET') {
    const campaign = await repo.setting('referralCampaign', referralDefaults()), referrer = await repo.exists('users', { referralCode: String(url.searchParams.get('code') || '').trim().toUpperCase(), blockedAt: null });
    return { valid: Boolean(campaign.enabled && referrer), campaignEnabled: Boolean(campaign.enabled), reason: !campaign.enabled ? 'campaign_unavailable' : !referrer ? 'invalid_code' : null };
  }
  if (route === '/api/referrals/me' && method === 'GET') return referralDashboard(repo, requireUser(ctx), pageOptions(url));
  if (route === '/api/referrals/qr' && method === 'GET') {
    const user = requireUser(ctx), campaign = await repo.setting('referralCampaign', referralDefaults());
    if (!campaign.enabled) fail(409, 'Referral campaign is not active.');
    const base = canonicalPublicBaseUrl(campaign.publicBaseUrl, ctx.production); if (!base) fail(503, 'Referral links are not configured.');
    const link = new URL('/referral', base); link.searchParams.set('code', user.referralCode);
    ctx.raw = await QRCode.toString(link.toString(), { type: 'svg', width: 280, margin: 2, errorCorrectionLevel: 'M' }); ctx.headers['content-type'] = 'image/svg+xml; charset=utf-8'; return {};
  }
  const rewardQuote = route.match(/^\/api\/rewards\/([^/]+)\/quote$/);
  if (rewardQuote && method === 'GET') {
    const user = requireUser(ctx), reward = await availableReward(repo, user.id, rewardQuote[1]);
    const product = await repo.one('products', { id: reward.productId, isActive: { $ne: false }, stock: { $gt: 0 } });
    if (!product) fail(409, 'The reward product is unavailable.');
    const address = await repo.one('addresses', { customerId: user.id, id: String(url.searchParams.get('addressId') || '') });
    if (!address) fail(400, 'Choose a saved delivery address.');
    const quote = deliveryQuote(await repo.one('deliveryAreas', { id: address.deliveryAreaId, isActive: { $ne: false } }), 0);
    if (!quote.available) fail(409, 'Delivery is unavailable for this address.');
    return { rewardId: reward.id, product, delivery: quote.delivery, platform: 0, total: quote.delivery, area: quote.area, eta: quote.estimate, available: true, rewardExpiresAt: reward.expiresAt };
  }
  return undefined;
}
async function cartSummaryFresh(repo, ownerId) { repo.forget('shoppingPreferences'); return cartSummary(repo, ownerId); }
async function availableReward(repo, userId, rewardId) {
  const reward = await repo.one('rewards', { id: rewardId, userId, status: 'available', type: 'free_product' });
  if (!reward || reward.expiresAt && Date.parse(reward.expiresAt) <= Date.now() || Number(reward.redemptionCount || 0) >= Number(reward.redemptionLimit || 1)) fail(409, 'This reward is no longer available.');
  return reward;
}
export async function checkoutApi(repo, ctx, rewardId = null) {
  const user = requireUser(ctx), { body } = ctx;
  if (body.paymentMethod !== 'cod') fail(400, 'Cash on Delivery is the only supported payment method.', 'COD_ONLY');
  const inSession = (session, fn) => repo.context.run({ session, documents: new Map() }, fn);
  const response = await createMongoCodOrder({ db: repo.db, client: repo.client, userId: user.id, idempotencyKey: String(body.idempotencyKey || ''),
    authorize: session => inSession(session, async () => { if (!await resolveIdentity(repo, ctx.req, 'customer', { write: true })) fail(401, 'Sign in to continue', 'AUTH_REQUIRED'); }),
    ...(rewardId ? { rewardCart: session => inSession(session, async () => {
      const reward = await availableReward(repo, user.id, rewardId), product = await repo.one('products', { id: reward.productId });
      const variant = product?.variants?.find(row => row.isActive !== false && row.stock >= (product.saleType === 'loose' ? row.quantityBase : 1));
      return { items: [{ productId: reward.productId, ...(variant ? { variantId: variant.id } : {}), quantity: 1 }] };
    }) } : {}),
    buildOrder: ({ cart, products, session }) => inSession(session, async () => {
      const address = await repo.one('addresses', { customerId: user.id, ...(body.addressId ? { id: String(body.addressId) } : { isDefault: true }) });
      if (!address) fail(400, 'Choose a saved delivery address.');
      if (body.deliveryAreaId && String(body.deliveryAreaId) !== address.deliveryAreaId) fail(409, 'Delivery area does not match this address.');
      let summary;
      if (rewardId) {
        await availableReward(repo, user.id, rewardId);
        const area = await repo.one('deliveryAreas', { id: address.deliveryAreaId, isActive: { $ne: false } });
        const quote = deliveryQuote(area, 0); if (!quote.available) fail(409, 'Delivery is unavailable for this address.');
        const line = resolveLine(products[0], cart.items[0], { strict: true });
        summary = { items: [{ ...line, price: 0, lineTotal: 0, mrp: line.price }], deliveryArea: area, deliveryEstimate: quote.estimate, subtotal: 0, discount: 0, delivery: quote.delivery, platform: 0, total: quote.delivery };
      } else {
        summary = await cartSummary(repo, user.id, { addressId: address.id, strict: true, cart, products });
        if (!summary.deliveryAvailable || !summary.minimumOrderMet) fail(409, summary.deliveryMessage);
      }
      const order = makeOrder(user.id, { ...address, deliveryAreaName: summary.deliveryArea.name }, summary, String(body.idempotencyKey));
      if (rewardId) { order.rewardId = rewardId; order.orderType = 'Referral free-product reward'; }
      return { order, couponCode: order.couponCode, rewardId: order.rewardId };
    }),
    recordEvents: (order, session) => inSession(session, () => createNotice(repo, 'customer', order.userId, { eventType: 'order_received', eventId: `order:${order.id}:received`, title: 'Order confirmed', message: `Order ${order.displayId} was received. We’ll notify you as it is prepared.`, orderId: order.id }))
  });
  ctx.status = response.status;
  return rewardId && response.body.order ? { ...response.body, reward: await repo.one('rewards', { id: rewardId, userId: user.id }) } : response.body;
}
export async function cancellationApi(repo, ctx, orderId, actorType = 'customer') {
  const owner = actorType === 'customer' ? requireUser(ctx) : actorType === 'rider' ? ctx.rider : ctx.admin;
  if (!owner) fail(401, 'Sign in to continue');
  const inSession = (session, fn) => repo.context.run({ session, documents: new Map() }, fn);
  const reason = actorType === 'customer' ? 'Cancelled by customer' : String(ctx.body.reason || '').trim().slice(0, 300);
  if (!reason) fail(400, 'Enter a cancellation reason.');
  const result = await cancelMongoCodOrder({ db: repo.db, client: repo.client, orderId, actorType, actorId: owner.id, reason,
    authorize: session => inSession(session, async () => { const live = await resolveIdentity(repo, ctx.req, actorType, { write: true }); if (!live || actorType === 'rider' && live.mustChangePassword) fail(401, 'Sign in to continue'); }),
    recordEvents: (order, session) => inSession(session, async () => {
      await createNotice(repo, 'customer', order.userId, { eventType: 'order_status', eventId: `order:${order.id}:cancelled`, title: 'Order cancelled', message: `Order ${order.displayId} was cancelled. ${reason}`, orderId: order.id });
      if (order.riderId) await createNotice(repo, 'rider', order.riderId, { eventType: 'rider_order', eventId: `order:${order.id}:cancelled`, title: 'Delivery cancelled', message: `Order ${order.displayId} was cancelled.`, orderId: order.id, destination: `/rider?order=${order.id}` });
    })
  });
  ctx.status = result.status; return result.body;
}
