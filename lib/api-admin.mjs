import crypto from 'node:crypto';
import { requireAdmin, normalizePhone } from './api-auth.mjs';
import { fail, pageOptions } from './mongo-repository.mjs';
import { handleAdminCatalogue, adminImagePath } from './api-admin-catalogue.mjs';
import { safeRider, nowIso, newId, addressForCustomer, eligibleCoupons, couponEligible, referralDefaults } from './commerce.mjs';
import { hashPassword, validPassword, isPasswordHash } from './password.mjs';
import { defaultHomepageBanners, validateHomepageBanners } from './homepage-banners.mjs';
import { cloudinaryConfig, signCloudinaryUpload } from './cloudinary.mjs';
import { firebaseMessagingStatus } from './firebase-push.mjs';
import { referralAdminData, canonicalPublicBaseUrl } from './mongo-referrals.mjs';
import { createNotice, notificationList, templateDefaults, recipients, campaignPublic, destination } from './mongo-notifications.mjs';
import { riderDeliverySummary, openOrderFilter, assignRider, milestone, notifyDesignatedRider } from './api-rider.mjs';

export async function audit(repo, admin, action, userId, details = {}) { await repo.insert('adminAuditLog', { id: newId(), at: nowIso(), adminId: admin.id, action, userId, details }); }
async function customerForAdmin(repo, user) {
  const context = repo.context.getStore();
  const summaries = context ? (context.customerSummaries ||= new Map()) : null;
  if (summaries?.has(user.id)) return summaries.get(user.id);
  const result = await buildCustomerForAdmin(repo, user);
  summaries?.set(user.id, result);
  return result;
}
async function buildCustomerForAdmin(repo, user) {
  const totals = await repo.collection('orders').aggregate([{ $match: { userId: user.id } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$total' } } }], repo.options()).toArray();
  return { id: user.id, phone: user.phone || null, searchPhone: user.phone || null, email: user.email || null, name: user.name || 'PurainaMart member', profilePhoto: user.profilePhoto || user.photoURL || user.picture || null, createdAt: user.createdAt, status: user.blockedAt ? 'Blocked' : 'Active', blockedAt: user.blockedAt || null, blockReason: user.blockReason || null, orderCount: totals[0]?.count || 0, orderValue: totals[0]?.value || 0, wishlistCount: (await repo.one('wishlists', { ownerId: user.id }))?.productIds?.length || 0, unreadNotifications: await repo.count('notifications', { userId: user.id, readAt: null }) };
}
async function customersForAdmin(repo, users) {
  if (!users.length) return [];
  const ids = users.map(user => user.id);
  const [totals, wishlists, notices] = await repo.reads([
    () => repo.collection('orders').aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', count: { $sum: 1 }, value: { $sum: '$total' } } }], repo.options()).toArray(),
    () => repo.list('wishlists', { ownerId: { $in: ids } }, { limit: 200 }),
    () => repo.collection('notifications').aggregate([{ $match: { userId: { $in: ids }, readAt: null } }, { $group: { _id: '$userId', count: { $sum: 1 } } }], repo.options()).toArray()
  ]);
  const orders = new Map(totals.map(row => [row._id, row])), wishes = new Map(wishlists.map(row => [row.ownerId, row.productIds?.length || 0])), unread = new Map(notices.map(row => [row._id, row.count]));
  return users.map(user => ({ id: user.id, phone: user.phone || null, searchPhone: user.phone || null, email: user.email || null, name: user.name || 'PurainaMart member', profilePhoto: user.profilePhoto || user.photoURL || user.picture || null, createdAt: user.createdAt, status: user.blockedAt ? 'Blocked' : 'Active', blockedAt: user.blockedAt || null, blockReason: user.blockReason || null, orderCount: orders.get(user.id)?.count || 0, orderValue: orders.get(user.id)?.value || 0, wishlistCount: wishes.get(user.id) || 0, unreadNotifications: unread.get(user.id) || 0 }));
}
async function ordersForAdmin(repo, orders) {
  if (!orders.length) return [];
  const [users, riders, referrals] = await repo.reads([
    () => repo.list('users', { id: { $in: [...new Set(orders.map(row => row.userId))] } }, { limit: 200 }),
    () => repo.list('riders', { id: { $in: [...new Set(orders.map(row => row.riderId).filter(Boolean))] } }, { limit: 200 }),
    () => repo.list('referrals', { qualifyingOrderId: { $in: orders.map(row => row.id) }, rewardId: { $ne: null } }, { limit: 200 })
  ]);
  const customers = new Map((await customersForAdmin(repo, users)).map(row => [row.id, row])), byRider = new Map(riders.map(row => [row.id, safeRider(row)])), rewarded = new Set(referrals.map(row => row.qualifyingOrderId));
  return orders.map(row => ({ ...row, customer: customers.get(row.userId) || null, rider: byRider.get(row.riderId) || null, referralRewardIssued: rewarded.has(row.id) }));
}
function searchFilter(url, fields) {
  const term = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return term ? { $or: fields.map(field => ({ [field]: pattern })) } : {};
}
async function dashboardMetrics(repo) {
  const today = nowIso().slice(0,10);
  const [rows, customers, lowStock] = await repo.reads([
    () => repo.collection('orders').aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, sales: { $sum: '$total' }, today: { $sum: { $cond: [{ $and: [{ $gte: ['$deliveredAt', today+'T00:00:00.000Z'] }, { $lt: ['$deliveredAt', today+'T23:59:59.999Z'] }] }, 1, 0] } } } }], repo.options()).toArray(),
    () => repo.count('users'), () => repo.count('products', { isActive: { $ne: false }, stock: { $lte: 5 } })
  ]);
  return { orders: rows.reduce((n,row)=>n+row.count,0), openOrders: rows.filter(row=>!['Delivered','Cancelled'].includes(row._id)).reduce((n,row)=>n+row.count,0), sales: rows.find(row=>row._id==='Delivered')?.sales || 0, deliveredToday: rows.find(row=>row._id==='Delivered')?.today || 0, customers, lowStock };
}
async function adminScreen(repo, ctx, view) {
  const paging = pageOptions(ctx.url, 25), admin = requireAdmin(ctx);
  if (!['overview','products','banners','categories','deliveryAreas','orders','customers','coupons','riders','referrals','notifications'].includes(view)) fail(400, 'Unknown admin screen.');
  const result = { admin: { id: admin.id, name: admin.name, phone: admin.phone }, products: [], categories: [], orders: [], customers: [], riders: [], coupons: [], deliveryAreas: [], notifications: [], adminAuditLog: [], homepageBanners: [], referralRewards: {}, metrics: {}, pagination: { offset: paging.skip, limit: paging.limit } };
  const tasks = [];
  const add = (key, task) => tasks.push(async () => { result[key] = await task(); });
  if (view === 'overview') {
    add('metrics', () => dashboardMetrics(repo));
    add('orders', async () => ordersForAdmin(repo, await repo.list('orders', {}, { limit: 10 })));
    add('products', () => repo.list('products', { isActive: { $ne: false }, stock: { $lte: 5 } }, { limit: 25 }));
  }
  if (view === 'products') {
    const filter = searchFilter(ctx.url, ['name','detail','category']);
    add('products', () => repo.list('products', filter, paging)); add('total', () => repo.count('products', filter));
  }
  if (['products','banners'].includes(view)) add('categories', () => repo.all('categories', { id: { $ne: 'all' } }));
  if (['banners','referrals'].includes(view)) add('products', () => repo.list('products', {}, { limit: 25, projection: { _id:0,id:1,name:1,price:1,isActive:1 } }));
  if (view === 'banners') { add('homepageBanners', () => repo.setting('homepageBanners', defaultHomepageBanners())); add('homepageHeroFruitImage', () => repo.setting('homepageHeroFruitImage')); }
  for (const [screen, collection] of [['categories','categories'],['deliveryAreas','deliveryAreas'],['coupons','coupons']]) if (view === screen) {
    const filter = screen === 'categories' ? { id: { $ne: 'all' } } : {};
    add(screen, () => repo.list(collection, filter, paging)); add('total', () => repo.count(collection, filter));
  }
  if (view === 'orders') {
    const filter = searchFilter(ctx.url, ['displayId','status','address.phone','address.recipientName','id']);
    add('orders', async () => ordersForAdmin(repo, await repo.list('orders', filter, paging))); add('total', () => repo.count('orders', filter));
  }
  if (view === 'customers') {
    const filter = searchFilter(ctx.url, ['name','phone','email']);
    if (ctx.url.searchParams.get('status') === 'Blocked') filter.blockedAt = { $ne: null };
    if (ctx.url.searchParams.get('status') === 'Active') filter.blockedAt = null;
    add('customers', async () => customersForAdmin(repo, await repo.list('users', filter, paging))); add('total', () => repo.count('users', filter));
  }
  if (['orders','riders','notifications'].includes(view)) {
    add('riders', async () => { const rows=await repo.list('riders', {}, view === 'riders' ? paging : {limit:200}); return view === 'riders' ? repo.reads(rows.map(row=>async()=>({...safeRider(row),deliverySummary:await riderDeliverySummary(repo,row.id)}))) : rows.map(safeRider); });
    add('dispatchSettings', () => repo.setting('dispatchSettings', {}));
    if (view === 'riders') add('total', () => repo.count('riders'));
  }
  if (view === 'referrals') { add('referralRewards', () => referralAdminData(repo, paging)); add('total', async () => Math.max(...await repo.reads([() => repo.count('referrals'), () => repo.count('rewards')]))); }
  if (view === 'notifications') {
    add('notificationCenter', () => notificationCenter(repo, paging));
    add('customers', async () => (await repo.list('users', {}, {limit:25})).map(({id,name,phone,email})=>({id,name,phone,email})));
    add('deliveryAreas', () => repo.list('deliveryAreas', {}, {limit:200}));
    add('total', () => repo.count('notificationCampaigns'));
  }
  await repo.reads(tasks);
  if (view === 'riders') {
    result.riderChoices = result.riders;
    const id=result.dispatchSettings?.designatedRiderId;
    if(id&&!result.riders.some(row=>row.id===id)){const designated=await repo.one('riders',{id});if(designated)result.riderChoices=[...result.riders,safeRider(designated)];}
  }
  if (view === 'categories' && result.categories.length) {
    const counts = await repo.collection('products').aggregate([{ $match: { category: { $in: result.categories.map(row=>row.id) }, isActive: { $ne:false } } }, { $group: { _id:'$category', count:{$sum:1} } }],repo.options()).toArray();
    const byCategory = new Map(counts.map(row=>[row._id,row.count]));
    result.categories = result.categories.map(row=>({...row,productCount:byCategory.get(row.id)||0}));
  }
  return result;
}
export async function orderForAdmin(repo, order) {
  const user = await repo.one('users', { id: order.userId }), rider = order.riderId ? await repo.one('riders', { id: order.riderId }) : null;
  return { ...order, referralRewardIssued: await repo.exists('referrals', { qualifyingOrderId: order.id, rewardId: { $ne: null } }), customer: user ? await customerForAdmin(repo, user) : null, rider: rider ? safeRider(rider) : null };
}
async function couponStatus(repo, coupon, userId) {
  const usedOrder = await repo.one('orders', { userId, couponCode: coupon.code });
  if (usedOrder) return { status: 'Used', usedOrder, appliedDiscount: Number(usedOrder.discount || 0) };
  return { status: coupon.revokedAt || coupon.isActive === false ? 'Revoked' : coupon.expiresAt && Date.parse(coupon.expiresAt) <= Date.now() ? 'Expired' : coupon.maxRedemptions != null && Number(coupon.redemptionCount || 0) >= coupon.maxRedemptions ? 'Exhausted' : 'Available' };
}
async function notifyCoupon(repo, admin, user, coupon) {
  const notice = await createNotice(repo, 'customer', user.id, { eventType: 'announcement', eventId: `customer-coupon:${coupon.code}:notify`, title: `Your coupon ${coupon.code} is ready`, message: `${coupon.label || coupon.code}: ${coupon.discountType === 'free_delivery' ? 'free delivery' : coupon.discountType === 'percentage' ? coupon.discount + '% off' : '₹' + coupon.discount + ' off'} on orders over ₹${coupon.minimum || 0}.`, destination: '/offers', inApp: true, forceInApp: true, push: true });
  await audit(repo, admin, 'customer.coupon_notified', user.id, { code: coupon.code, notificationId: notice?.id }); return notice;
}
async function notificationCenter(repo, paging = {limit:100}) {
  const campaignRows = await repo.list('notificationCampaigns', {}, paging);
  const counts = campaignRows.length ? await repo.collection('notificationDeliveryLogs').aggregate([{ $match:{campaignId:{$in:campaignRows.map(row=>row.id)}} }, { $group:{_id:'$campaignId',attemptCount:{$sum:1},acceptedCount:{$sum:{$cond:[{$eq:['$status','accepted']},1,0]}},failedCount:{$sum:{$cond:[{$or:[{$eq:['$status','failed']},{$eq:['$status','invalid_device']}]},1,0]}}} }],repo.options()).toArray() : [];
  const byCampaign=new Map(counts.map(({_id,...row})=>[_id,row]));
  const campaigns=campaignRows.map(row=>({...row,attemptCount:0,acceptedCount:0,failedCount:0,...byCampaign.get(row.id)}));
  const deviceCounts = await repo.reads(['customer','rider','admin'].map(ownerType => () => repo.count('notificationDevices', { ownerType, status: 'active' })));
  const devices = Object.fromEntries(['customer','rider','admin'].map((type,i)=>[type,deviceCounts[i]]));
  return { config: firebaseMessagingStatus(), status: firebaseMessagingStatus(), devices, templates: Object.values(await repo.setting('notificationTemplates', templateDefaults())), campaigns, deliveryLogs: await repo.list('notificationDeliveryLogs', {}, { limit: 250, sort: { attemptedAt: -1 }, projection: { _id: 0, id: 1, campaignId: 1, eventId: 1, ownerType: 1, ownerId: 1, status: 1, attemptedAt: 1, providerMessageId: 1, errorCode: 1 } }) };
}
export async function adminBootstrap(repo, ctx) {
  if (ctx.url.searchParams.has('view')) return adminScreen(repo, ctx, ctx.url.searchParams.get('view'));
  const admin = requireAdmin(ctx), paging = pageOptions(ctx.url, 100);
  const [metrics, orderRows, users, riderRows, dispatch, noticeRows, products, categories, homepageBanners, homepageHeroFruitImage, deliveryAreas, referralRewards, coupons, adminAuditLog, center] = await repo.reads([
    () => dashboardMetrics(repo), () => repo.list('orders', {}, paging), () => repo.list('users', {}, paging), () => repo.list('riders', {}, paging),
    () => repo.setting('dispatchSettings', {designatedRiderId:null}), () => repo.list('notifications', {}, {limit:100}),
    () => repo.list('products', {}, {...paging,sort:{rank:1,id:1}}), () => repo.list('categories', {id:{$ne:'all'}}, {limit:200}),
    () => repo.setting('homepageBanners',defaultHomepageBanners()), () => repo.setting('homepageHeroFruitImage'),
    () => repo.list('deliveryAreas', {}, {limit:200}), () => referralAdminData(repo,paging), () => repo.list('coupons',{},paging),
    () => repo.list('adminAuditLog',{}, {limit:200,sort:{at:-1}}), () => notificationCenter(repo)
  ]);
  const [orders, customers, riders, designated, noticeUsers] = await repo.reads([
    () => ordersForAdmin(repo,orderRows), () => customersForAdmin(repo,users),
    () => repo.reads(riderRows.map(row=>async()=>({...safeRider(row),deliverySummary:await riderDeliverySummary(repo,row.id)}))),
    () => dispatch.designatedRiderId ? repo.one('riders',{id:dispatch.designatedRiderId}) : null,
    () => repo.preload('users',noticeRows.map(row=>row.userId))
  ]);
  const phones=new Map(noticeUsers.map(row=>[row.id,row.phone]));
  return {admin:{id:admin.id,name:admin.name,phone:admin.phone},metrics,products,categories,homepageBanners,homepageHeroFruitImage,deliveryAreas,referralRewards,orders,customers,riders,dispatchSettings:{...dispatch,designatedRider:designated?safeRider(designated):null},coupons,adminAuditLog,notifications:noticeRows.map(row=>({...row,customer:phones.get(row.userId)||'Guest'})),notificationCenter:center,pagination:{offset:paging.skip,limit:paging.limit}};
}
export async function handleAdminApi(repo, ctx) {
  if (!ctx.route.startsWith('/api/admin/')) return undefined;
  const admin = requireAdmin(ctx), { route, method, body, url } = ctx;
  if (route === '/api/admin/bootstrap' && method === 'GET') return adminBootstrap(repo, ctx);
  const catalogue = await handleAdminCatalogue(repo, ctx); if (catalogue !== undefined) return catalogue;
  const listCollection = ({ '/api/admin/products': 'products', '/api/admin/categories': 'categories', '/api/admin/delivery-areas': 'deliveryAreas', '/api/admin/coupons': 'coupons', '/api/admin/inventory': 'products' })[route];
  if (listCollection && method === 'GET') {
    const filter = searchFilter(url, ['name','detail','category','code']);
    const [rows, total] = await repo.reads([() => repo.list(listCollection, filter, pageOptions(url)), () => repo.count(listCollection, filter)]);
    return { [listCollection === 'deliveryAreas' ? 'areas' : listCollection]: rows, total };
  }
  const productRead = route.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (productRead && method === 'GET') { const product=await repo.one('products',{id:productRead[1]}); if(!product)fail(404,'Product not found'); return {product}; }
  if (route === '/api/admin/rider-delivery-summaries' && method === 'GET') {
    const riders = []; for (const rider of await repo.list('riders', {}, pageOptions(url))) riders.push({ id: rider.id, name: rider.name, deliverySummary: await riderDeliverySummary(repo, rider.id, url.searchParams.get('month'), url.searchParams.get('date')) });
    return { month: url.searchParams.get('month') || nowIso().slice(0, 7), date: url.searchParams.get('date') || nowIso().slice(0, 10), today: nowIso().slice(0, 10), riders };
  }
  if (route === '/api/admin/cloudinary/signature' && method === 'GET') { const config = cloudinaryConfig(); if (!config) fail(503, 'Cloudinary image uploads are not configured.'); return signCloudinaryUpload(config); }
  if (route === '/api/admin/hero-fruit' && method === 'PATCH') { const image = body.image ? adminImagePath(body.image, ctx.publicDir) : null; if (image === undefined) fail(400, 'Choose a Cloudinary URL or existing image under /assets/.'); await repo.setSetting('homepageHeroFruitImage', image); return { homepageHeroFruitImage: image }; }
  if (route === '/api/admin/banners' && method === 'PATCH') {
    const productIds = (Array.isArray(body.banners) ? body.banners : []).filter(row => row.action?.type === 'product').map(row => String(row.action.id || ''));
    const result = validateHomepageBanners(body.banners, { isAllowedImage: image => Boolean(adminImagePath(image, ctx.publicDir)), products: productIds.length ? await repo.list('products', { id: { $in: productIds } }, { limit: 200 }) : [], categories: await repo.list('categories', {}, { limit: 200 }) });
    if (result.error) fail(400, result.error);
    const banners = result.banners.map(row => ({ ...row, updatedAt: nowIso(), updatedBy: admin.id })); await repo.setSetting('homepageBanners', banners); return { banners };
  }
  if (route === '/api/admin/settings' && method === 'GET') return { dispatchSettings: await repo.setting('dispatchSettings', {}), referralCampaign: await repo.setting('referralCampaign', referralDefaults()), homepageBanners: await repo.setting('homepageBanners', defaultHomepageBanners()) };
  if (route === '/api/admin/dispatch-settings' && method === 'PATCH') {
    const id = body.designatedRiderId ? String(body.designatedRiderId) : null;
    const rider = id ? await repo.one('riders', { id, isActive: { $ne: false } }) : null;
    if (id && (!rider || !isPasswordHash(rider.passwordHash))) fail(400, 'Select an active Rider with configured login credentials.');
    const settings = { designatedRiderId: id, updatedAt: nowIso(), updatedBy: admin.id }; await repo.setSetting('dispatchSettings', settings); return { dispatchSettings: settings };
  }
  if (route === '/api/admin/referrals' && method === 'GET') return referralAdminData(repo, pageOptions(url));
  if (route === '/api/admin/referrals/campaign' && method === 'PATCH') {
    const next = { ...await repo.setting('referralCampaign', referralDefaults()) };
    for (const key of ['enabled', 'firstOrderOnly']) if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') fail(400, 'Campaign switches must be boolean.'); next[key] = body[key]; }
    for (const key of ['minimumOrder', 'rewardAmount', 'expiryDays', 'redemptionLimit', 'maxRewardsPerCustomer']) if (body[key] !== undefined) next[key] = Number(body[key]);
    for (const key of ['qualifyingStatus', 'rewardType', 'freeProductId', 'publicBaseUrl']) if (body[key] !== undefined) next[key] = String(body[key] || '');
    if (!Number.isFinite(next.minimumOrder) || next.minimumOrder < 0 || next.qualifyingStatus !== 'Delivered' || !['coupon','free_product'].includes(next.rewardType) || !Number.isFinite(next.rewardAmount) || next.rewardAmount < 0 || !Number.isInteger(next.expiryDays) || next.expiryDays < 1 || next.expiryDays > 365 || !Number.isInteger(next.redemptionLimit) || next.redemptionLimit < 1 || next.redemptionLimit > 10 || !Number.isInteger(next.maxRewardsPerCustomer) || next.maxRewardsPerCustomer < 1 || next.maxRewardsPerCustomer > 100) fail(400, 'Enter valid referral rules. Qualification supports Delivered orders.');
    if (next.publicBaseUrl && !canonicalPublicBaseUrl(next.publicBaseUrl, ctx.production)) fail(400, 'Enter a canonical public app origin.');
    if (next.rewardType === 'coupon' && next.rewardAmount <= 0) fail(400, 'Coupon rewards must be greater than ₹0.');
    if (next.rewardType === 'free_product' && !await repo.exists('products', { id: next.freeProductId, isActive: { $ne: false } })) fail(400, 'Select an active product for free-product rewards.');
    next.demoSettings = false; next.updatedAt = nowIso(); await repo.setSetting('referralCampaign', next); return { campaign: next };
  }
  if (route === '/api/admin/riders' && method === 'GET') return { riders: (await repo.list('riders', searchFilter(url,['name','phone']), pageOptions(url))).map(safeRider) };
  if (route === '/api/admin/riders' && method === 'POST') {
    const phone = normalizePhone(body.phone), name = String(body.name || '').trim().slice(0, 50), password = String(body.password || '');
    if (!name || !/^\d{10}$/.test(phone) || !validPassword(password)) fail(400, 'Provide a name, ten-digit phone number and initial password of 12–128 characters.');
    if (await repo.exists('riders', { phone })) fail(409, 'That phone already has a rider account.');
    const rider = { id: newId(), phone, name, vehicle: String(body.vehicle || 'Motorbike').slice(0, 40), passwordHash: await hashPassword(password), mustChangePassword: true, status: 'offline', isActive: true, createdAt: nowIso() }; await repo.insert('riders', rider); ctx.status = 201; return { rider: safeRider(rider) };
  }
  const riderMatch = route.match(/^\/api\/admin\/riders\/([^/]+)(?:\/(reset-password))?$/);
  if (riderMatch) {
    const rider = await repo.one('riders', { id: riderMatch[1] }); if (!rider) fail(404, 'Rider not found');
    if (riderMatch[2] && method === 'POST') {
      const temporaryPassword = crypto.randomBytes(15).toString('base64url'); rider.passwordHash = await hashPassword(temporaryPassword); rider.mustChangePassword = true; rider.passwordResetAt = nowIso(); await repo.remove('sessions', { kind: 'rider', ownerId: rider.id }); return { ok: true, temporaryPassword };
    }
    if (method === 'GET') return { rider: safeRider(rider) };
    if (method === 'DELETE' || body.isActive === false) {
      if (await repo.exists('orders', openOrderFilter(rider.id))) fail(409, 'Reassign or complete this rider’s active deliveries first.');
      await repo.remove('sessions', { kind: 'rider', ownerId: rider.id });
      const dispatch = await repo.setting('dispatchSettings', {}); if (dispatch.designatedRiderId === rider.id) await repo.setSetting('dispatchSettings', { ...dispatch, designatedRiderId: null, updatedAt: nowIso(), updatedBy: admin.id });
      rider.isActive = false; rider.status = 'offline';
    }
    if (method === 'DELETE') return { ok: true };
    if (method !== 'PATCH') fail(405, 'Method not allowed');
    if (body.name !== undefined) { const name = String(body.name).trim().slice(0, 50); if (!name) fail(400, 'Rider name is required.'); rider.name = name; }
    if (body.vehicle !== undefined) rider.vehicle = String(body.vehicle).trim().slice(0, 40);
    if (body.isActive !== undefined) rider.isActive = Boolean(body.isActive);
    return { rider: safeRider(rider) };
  }
  if (route === '/api/admin/customers' && method === 'GET') { const filter = searchFilter(url, ['name','phone','email']); const [users,total] = await repo.reads([() => repo.list('users', filter, pageOptions(url)), () => repo.count('users', filter)]); return { customers: await customersForAdmin(repo, users), total }; }
  const customerMatch = route.match(/^\/api\/admin\/customers\/([^/]+)(?:\/(block|unblock|coupons)(?:\/([^/]+)\/(revoke|notify))?)?$/);
  if (customerMatch) {
    const user = await repo.one('users', { id: customerMatch[1] }); if (!user) fail(404, 'Customer not found');
    const [, , action, code, couponAction] = customerMatch;
    if (!action && method === 'GET') {
      const addresses = []; for (const address of await repo.all('addresses', { customerId: user.id })) addresses.push(await addressForCustomer(repo, address));
      const coupons = []; for (const coupon of await repo.list('coupons', { userId: user.id }, pageOptions(url))) coupons.push({ ...coupon, ...await couponStatus(repo, coupon, user.id) });
      return { customer: await customerForAdmin(repo, user), addresses, orders: await repo.list('orders', { userId: user.id }, pageOptions(url)), coupons, eligibleCoupons: (await eligibleCoupons(repo, user.id, 0, { allowBelowMinimum: true })).filter(row => !row.userId && !row.rewardId), audit: await repo.list('adminAuditLog', { userId: user.id }, { limit: 100, sort: { at: -1 } }), notifications: (await notificationList(repo, 'customer', user.id)).notifications };
    }
    if (!action && method === 'PATCH') {
      if (!Object.keys(body).length || Object.keys(body).some(key => !['name', 'email'].includes(key))) fail(400, 'Only customer name and email can be edited here.');
      const before = { name: user.name, email: user.email || null };
      if (body.name !== undefined) { const name = String(body.name || '').trim(); if (name.length < 2 || name.length > 50) fail(400, 'Name must be between 2 and 50 characters.'); user.name = name; }
      if (body.email !== undefined) { const email = String(body.email || '').trim().toLowerCase(); if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail(400, 'Enter a valid email address.'); if (email && await repo.exists('users', { id: { $ne: user.id }, email })) fail(409, 'That email address is already linked to another customer.'); user.email = email || null; user.emailVerified = false; }
      await audit(repo, admin, 'customer.details_updated', user.id, { before, after: { name: user.name, email: user.email || null } }); return { customer: await customerForAdmin(repo, user) };
    }
    if (['block', 'unblock'].includes(action) && method === 'POST') {
      if (action === 'block') {
        const reason = String(body.reason || '').trim().slice(0, 300); if (reason.length < 3) fail(400, 'Provide a reason of at least 3 characters.');
        if (!user.blockedAt) { user.blockedAt = nowIso(); user.blockReason = reason; await repo.remove('sessions', { kind: 'customer', ownerId: user.id }); await audit(repo, admin, 'customer.blocked', user.id, { reason }); }
      } else if (user.blockedAt) { await audit(repo, admin, 'customer.unblocked', user.id, { previousReason: user.blockReason || '' }); delete user.blockedAt; delete user.blockReason; }
      return { customer: await customerForAdmin(repo, user) };
    }
    if (action === 'coupons' && method === 'POST') {
      // Same customer document is touched by checkout and coupon assignment.
      await repo.update('users', { id: user.id }, { $inc: { couponRevision: 1 } });
      if (!couponAction) {
        const originCode = String(body.code || '').trim().toUpperCase(), source = await repo.one('coupons', { code: originCode });
        if (!source || source.userId || source.rewardId || !await couponEligible(repo, source, user.id, 0, { allowBelowMinimum: true })) fail(409, 'Choose an existing eligible coupon.');
        if (await repo.exists('coupons', { userId: user.id, assignmentOriginCode: originCode, revokedAt: null })) fail(409, 'This coupon has already been assigned to this customer.');
        const coupon = { ...source, code: `${originCode.slice(0, 22)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, userId: user.id, assignmentOriginCode: originCode, assignedAt: nowIso(), assignedBy: admin.id, isActive: true, redemptionCount: 0, maxRedemptions: 1 };
        await repo.insert('coupons', coupon); await audit(repo, admin, 'customer.coupon_assigned', user.id, { code: coupon.code, sourceCode: originCode });
        const notice = body.notify === true ? await notifyCoupon(repo, admin, user, coupon) : null; ctx.status = 201;
        return { coupon: { ...coupon, status: 'Available' }, notification: notice ? { created: true, id: notice.id, pushStatus: 'queued' } : null };
      }
      const coupon = await repo.one('coupons', { code: String(code).toUpperCase(), userId: user.id }); if (!coupon) fail(404, 'Assigned coupon not found.');
      const status = await couponStatus(repo, coupon, user.id);
      if (couponAction === 'revoke') {
        if (status.status === 'Used') fail(409, 'A redeemed coupon cannot be revoked.');
        coupon.isActive = false; coupon.revokedAt = nowIso(); coupon.revokedBy = admin.id;
        await repo.update('shoppingPreferences', { ownerId: user.id, couponCode: coupon.code }, { $unset: { couponCode: '' } }); await audit(repo, admin, 'customer.coupon_revoked', user.id, { code: coupon.code }); return { coupon: { ...coupon, status: 'Revoked' } };
      }
      if (status.status !== 'Available') fail(409, 'Only an available coupon can be notified.');
      if (await repo.exists('notificationEvents', { id: `customer:${user.id}:customer-coupon:${coupon.code}:notify` })) fail(409, 'This customer has already been notified about this coupon.');
      const notification = await notifyCoupon(repo, admin, user, coupon); ctx.status = 202; return { created: true, notificationId: notification.id, pushStatus: 'queued' };
    }
    fail(405, 'Method not allowed');
  }
  if (route === '/api/admin/orders' && method === 'GET') { const filter = { ...searchFilter(url, ['displayId','address.phone','address.recipientName']), ...(url.searchParams.get('status') ? {status:url.searchParams.get('status')} : {}) }; return { orders: await ordersForAdmin(repo, await repo.list('orders', filter, pageOptions(url))) }; }
  const orderMatch = route.match(/^\/api\/admin\/orders\/([^/]+)(?:\/(status|assign))?$/);
  if (orderMatch) {
    const order = await repo.one('orders', { id: orderMatch[1] }); if (!order) fail(404, 'Order not found');
    if (method === 'GET' && !orderMatch[2]) return { order: await orderForAdmin(repo, order) };
    if (orderMatch[2] === 'assign' && method === 'POST') {
      const rider = await repo.one('riders', { id: String(body.riderId || ''), isActive: { $ne: false } }); if (!rider) fail(404, 'Choose an active rider account.');
      await assignRider(repo, order, rider, 'admin', admin.id); return { order: await orderForAdmin(repo, order) };
    }
    if (orderMatch[2] === 'status' && method === 'PATCH') {
      const next = String(body.status || '');
      if (!({ 'Order received': ['Being packed'], 'Being packed': ['Ready for pickup'] })[order.status]?.includes(next)) fail(409, 'That order status transition is not allowed.');
      order.status = next; const at = milestone(order, next, 'admin', admin.id); if (next === 'Ready for pickup') order.readyAt = at;
      await createNotice(repo, 'customer', order.userId, { eventType: 'order_status', eventId: `order:${order.id}:status:${next}`, title: next === 'Ready for pickup' ? 'Your order is ready' : 'Your order is being prepared', message: `Order ${order.displayId} is now ${next.toLowerCase()}.`, orderId: order.id });
      if (next === 'Ready for pickup') await notifyDesignatedRider(repo, order);
      return { order: await orderForAdmin(repo, order) };
    }
  }
  if (route === '/api/admin/notifications' && method === 'GET') return notificationCenter(repo);
  if (route === '/api/admin/notifications/estimate' && method === 'POST') { const targets = await recipients(repo, body.target, String(body.category || 'announcements'), admin.id); return { eligibleRecipients: targets.length, maximumRecipients: 500, largeCampaignConfirmationRequired: targets.length > 50 }; }
  if (route === '/api/admin/notifications/test' && method === 'POST') {
    if (!await repo.exists('notificationDevices', { ownerType: 'admin', ownerId: admin.id, status: 'active' })) fail(409, 'Enable notifications on this signed-in Admin browser first.');
    const notice = await createNotice(repo, 'admin', admin.id, { eventType: 'announcement', eventId: `admin-test:${newId()}`, title: String(body.title || 'Notification test'), message: String(body.message || 'Your browser is registered for store notifications.'), inApp: false, destination: '/' }); ctx.status = 202; return { status: 'queued', eventId: notice.id };
  }
  if (route === '/api/admin/notifications' && method === 'POST') {
    const title = String(body.title || '').trim(), message = String(body.message || body.body || '').trim(), category = String(body.category || 'announcements'), channel = String(body.channel || 'both');
    if (!title || title.length > 100 || !message || message.length > 400 || !['order_updates','payments','referrals_rewards','promotions','announcements'].includes(category) || !['in_app','push','both'].includes(channel)) fail(400, 'Enter a title, message, supported category and channel.');
    const target = body.target || (body.userId === 'all' ? { type: 'all_customers' } : { type: 'customer', id: String(body.userId || '') });
    const targets = await recipients(repo, target, category, admin.id);
    if (targets.length > 500) fail(413, 'This campaign exceeds the 500-recipient limit. Narrow the target group.');
    if (targets.length > 50 && body.confirmLargeAudience !== true) fail(409, 'Confirm the large audience before queuing.');
    const scheduledAt = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
    if (scheduledAt && (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 120000 || scheduledAt.getTime() > Date.now() + 30 * 86400000)) fail(400, 'Scheduled send time must be between 2 minutes and 30 days from now.');
    const dest = destination(body.destination || '/notifications'), signature = crypto.createHash('sha256').update(JSON.stringify({ adminId: admin.id, title, message, category, channel, target, destination: dest, scheduledAt })).digest('hex');
    if (await repo.exists('notificationCampaigns', { signature, createdAt: { $gt: new Date(Date.now() - 60000).toISOString() } })) fail(409, 'A matching campaign was already created recently.');
    const campaign = { id: newId(), title, message, category, channel, target, destination: dest, signature, status: scheduledAt ? 'scheduled' : 'queued', scheduledAt: scheduledAt?.toISOString() || null, createdAt: nowIso(), createdBy: admin.id, processedAt: null, recipientCount: 0, acceptedCount: 0, failedCount: 0 };
    await repo.insert('notificationCampaigns', campaign); ctx.status = 202; return { campaign: await campaignPublic(repo, campaign), estimatedRecipients: targets.length };
  }
  const campaignMatch = route.match(/^\/api\/admin\/notifications\/campaigns\/([^/]+)\/(cancel|duplicate)$/);
  if (campaignMatch && method === 'POST') {
    const source = await repo.one('notificationCampaigns', { id: campaignMatch[1] }); if (!source) fail(404, 'Campaign not found.');
    if (campaignMatch[2] === 'cancel') {
      if (!['queued','scheduled'].includes(source.status) || source.processedAt) fail(409, 'Only campaigns whose dispatch has not started can be cancelled.');
      source.status = 'cancelled'; source.cancelledAt = nowIso(); source.cancelledBy = admin.id;
      await repo.updateMany('notificationOutbox', { campaignId: source.id, status: 'queued' }, { $set: { status: 'skipped', processedAt: nowIso() } }); return { campaign: await campaignPublic(repo, source) };
    }
    const draft = { ...source, id: newId(), status: 'draft', scheduledAt: null, createdAt: nowIso(), createdBy: admin.id, processedAt: null, recipientCount: 0, acceptedCount: 0, failedCount: 0, signature: null }; delete draft.cancelledAt; delete draft.cancelledBy;
    await repo.insert('notificationCampaigns', draft); ctx.status = 201; return { campaign: await campaignPublic(repo, draft) };
  }
  const templateMatch = route.match(/^\/api\/admin\/notifications\/templates\/([a-z_]+)$/);
  if (templateMatch && method === 'PATCH') {
    const templates = await repo.setting('notificationTemplates', templateDefaults()), template = templates[templateMatch[1]]; if (!template) fail(404, 'Notification template not found.');
    for (const key of ['enabled', 'inAppEnabled', 'pushEnabled']) if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') fail(400, 'Template switches must be boolean.'); template[key] = body[key]; }
    template.updatedAt = nowIso(); template.updatedBy = admin.id; await repo.setSetting('notificationTemplates', templates); return { template };
  }
  return undefined;
}
