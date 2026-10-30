const COLLECTIONS = ['users','admins','riders','sessions','products','categories','carts','wishlists','addresses','orders','coupons','couponRedemptions','notifications','notificationOutbox','rewards','referrals','referralEvents','settings','shoppingPreferences','deliveryAreas','notificationPreferences','notificationDevices','notificationEvents','notificationCampaigns','notificationDeliveryLogs','riderNotifications','adminAuditLog'];
const REQUIRED_FIELDS = {
  users: ['id'], riders: ['id'], products: ['id','name','price','stock'], categories: ['id','name'],
  carts: ['ownerId','items','version'], wishlists: ['ownerId','productIds'], addresses: ['customerId','id'],
  orders: ['id','userId','status','paymentMethod','paymentStatus','items'], coupons: ['code'],
  notifications: ['id','userId'], notificationOutbox: ['id','eventId','status'], rewards: ['id','userId','status'],
  referrals: ['id'], settings: ['key'], deliveryAreas: ['id'], notificationPreferences: ['ownerType','ownerId','preferences'],
  notificationDevices: ['id'], notificationEvents: ['id'], notificationCampaigns: ['id'], notificationDeliveryLogs: ['id'],
  riderNotifications: ['id','riderId'], adminAuditLog: ['id']
};

import { mongoCollectionIndexes, mongoCollectionSchemas } from './mongodb.mjs';
const asRows = value => Array.isArray(value) ? value : [];
const mapValues = (value, fn) => Object.entries(value || {}).flatMap(([key, rows]) => asRows(rows).map(row => fn(key, row)));
const isLikelyDemoProduct = product => /demo listing|sample product|placeholder/i.test(`${product?.name || ''} ${product?.description || ''} ${product?.detail || ''}`);

export function mapLegacyStoreToMongo(store) {
  const mapped = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
  const skipped = { sessionLikeRecords: 0, suspectedDemoProducts: 0 };
  for (const key of ['sessions','challenges','adminSessions','adminChallenges','riderSessions','riderChallenges']) skipped.sessionLikeRecords += Object.keys(store?.[key] || {}).length;
  mapped.users = asRows(store?.users).map(row => {
    const user = { ...row, id: row.id == null ? '' : String(row.id) };
    for (const key of ['email', 'phone', 'googleSub', 'referralCode']) {
      if (!String(user[key] || '').trim()) delete user[key];
      else user[key] = String(user[key]).trim();
    }
    if (user.email) user.email = user.email.toLowerCase();
    return user;
  });
  mapped.admins = asRows(store?.admins).map(row => ({ ...row, id: String(row.id) }));
  mapped.riders = asRows(store?.riders).map(row => ({ ...row, id: String(row.id) }));
  mapped.categories = asRows(store?.categories).map(row => ({ ...row, id: String(row.id) }));
  mapped.products = asRows(store?.products).filter(product => {
    if (!isLikelyDemoProduct(product)) return true;
    skipped.suspectedDemoProducts++;
    return false;
  }).map(row => ({ ...row, id: String(row.id), categoryId: row.categoryId || row.category || null }));
  mapped.addresses = mapValues(store?.addresses, (customerId, row) => ({ ...row, id: String(row.id), customerId }));
  const owners = new Set([...Object.keys(store?.carts || {}), ...Object.keys(store?.variantCarts || {})]);
  mapped.carts = [...owners].map(ownerId => {
    const items = [];
    for (const [productId, quantity] of Object.entries(store?.carts?.[ownerId] || {})) if (Number.isSafeInteger(Number(quantity)) && Number(quantity) > 0) items.push({ productId, quantity: Number(quantity) });
    for (const [productId, variants] of Object.entries(store?.variantCarts?.[ownerId] || {})) for (const [variantId, quantity] of Object.entries(variants || {})) if (Number.isSafeInteger(Number(quantity)) && Number(quantity) > 0) items.push({ productId, variantId, quantity: Number(quantity) });
    return { ownerId, version: 0, items };
  });
  mapped.wishlists = Object.entries(store?.wishlists || {}).map(([ownerId, productIds]) => ({ ownerId, productIds: Array.isArray(productIds) ? productIds.map(String) : [] }));
  mapped.orders = asRows(store?.orders).map(row => ({ ...row, id: String(row.id) }));
  mapped.coupons = Object.values(store?.coupons || {}).map(row => ({ ...row, code: String(row.code) }));
  mapped.couponRedemptions = mapped.orders.filter(row => row.couponCode).map(row => ({ id: `${row.couponCode}:${row.userId}:${row.id}`, couponCode: row.couponCode, userId: row.userId, orderId: row.id, redeemedAt: row.createdAt, discount: Number(row.discount || 0), ...(row.rewardId && row.status === 'Cancelled' ? { cancelledAt: row.cancelledAt || row.createdAt } : {}) }));
  for (const coupon of mapped.coupons) coupon.redemptionCount = Math.max(Number(coupon.redemptionCount || 0), mapped.couponRedemptions.filter(row => row.couponCode === coupon.code && !row.cancelledAt).length);
  mapped.rewards = asRows(store?.rewards).map(row => ({ ...row, id: String(row.id) }));
  mapped.referrals = asRows(store?.referrals).map(row => ({ ...row, id: String(row.id) }));
  mapped.referralEvents = asRows(store?.referralEvents).map(row => ({ ...row, id: String(row.id) }));
  mapped.deliveryAreas = asRows(store?.deliveryAreas).map(row => ({ ...row, id: String(row.id) }));
  mapped.notifications = mapValues(store?.notifications, (userId, row) => ({ ...row, id: String(row.id), userId }));
  mapped.notificationOutbox = asRows(store?.notificationOutbox).map(row => ({ ...row, id: String(row.id), attempts: Number(row.attempts || 0), nextAttemptAt: row.nextAttemptAt || row.createdAt, ...(row.status === 'processing' ? { claimedAt: row.claimedAt || row.createdAt } : {}) }));
  mapped.notificationPreferences = Object.entries(store?.notificationPreferences || {}).flatMap(([ownerType, byOwner]) => Object.entries(byOwner || {}).map(([ownerId, preferences]) => ({ ownerType, ownerId, preferences })));
  mapped.notificationDevices = asRows(store?.notificationDevices).map(row => ({ ...row, id: String(row.id) }));
  mapped.notificationEvents = Object.values(store?.notificationEvents || {}).map(row => ({ ...row, id: String(row.eventId || row.id) }));
  mapped.notificationCampaigns = asRows(store?.notificationCampaigns).map(row => ({ ...row, id: String(row.id) }));
  mapped.notificationDeliveryLogs = asRows(store?.notificationDeliveryLogs).map((row, index) => ({ ...row, id: String(row.id || `${row.campaignId || 'campaign'}:${row.recipientId || 'recipient'}:${index}`) }));
  mapped.riderNotifications = mapValues(store?.riderNotifications, (riderId, row) => ({ ...row, id: String(row.id), riderId }));
  mapped.adminAuditLog = asRows(store?.adminAuditLog).map(row => ({ ...row, id: String(row.id) }));
  const preferenceOwners = new Set(['appliedCoupon','selectedDeliveryAreas','selectedDeliveryAddresses'].flatMap(key => Object.keys(store?.[key] || {})));
  mapped.shoppingPreferences = [...preferenceOwners].map(ownerId => ({ ownerId, ...(store?.appliedCoupon?.[ownerId] ? { couponCode: store.appliedCoupon[ownerId] } : {}), ...(store?.selectedDeliveryAreas?.[ownerId] ? { areaId: store.selectedDeliveryAreas[ownerId] } : {}), ...(store?.selectedDeliveryAddresses?.[ownerId] ? { addressId: store.selectedDeliveryAddresses[ownerId] } : {}) }));
  for (const [key, value] of Object.entries({
    dispatchSettings: store?.dispatchSettings,
    referralCampaign: store?.referralCampaign,
    homepageBanners: store?.homepageBanners,
    homepageHeroFruitImage: store?.homepageHeroFruitImage,
    notificationWelcome: store?.notificationWelcome,
    notificationTemplates: store?.notificationTemplates
  })) if (value !== undefined) mapped.settings.push({ key, value });
  const validation = validateMappedMongoData(mapped);
  const blockers = [];
  if (!validation.valid) blockers.push('duplicate identifiers or broken references');
  if (skipped.suspectedDemoProducts) blockers.push('suspected demo products were excluded; select an authoritative non-demo source');
  return { collections: mapped, skipped, validation, blockers, importable: blockers.length === 0 };
}

export function validateMappedMongoData(collections) {
  const duplicates = [];
  for (const [name, rows] of Object.entries(collections)) {
    const keyFor = row => ['carts','wishlists','shoppingPreferences'].includes(name) ? row.ownerId : name === 'addresses' ? `${row.customerId}:${row.id}` : name === 'settings' ? row.key : name === 'coupons' ? row.code : name === 'notificationPreferences' ? `${row.ownerType}:${row.ownerId}` : row.id;
    const seen = new Set();
    for (const row of rows) {
      const value = keyFor(row);
      if (value == null) { duplicates.push({ collection: name, reason: 'missing_key' }); continue; }
      if (seen.has(value)) duplicates.push({ collection: name, reason: 'duplicate_key' });
      seen.add(value);
    }
  }
  // Validate secondary unique keys before connecting, without reporting values.
  for (const [name, specs] of Object.entries(mongoCollectionIndexes)) for (const [keys, options] of specs) {
    if (!options.unique || Object.keys(keys).length === 1 && Object.keys(keys)[0] === 'id') continue;
    const seen = new Set();
    for (const row of collections[name] || []) {
      if (options.partialFilterExpression && !Object.keys(options.partialFilterExpression).every(key => typeof row[key] === 'string')) continue;
      const value = JSON.stringify(Object.keys(keys).map(key => row[key] ?? null));
      if (seen.has(value)) duplicates.push({ collection: name, reason: 'duplicate_' + options.name });
      seen.add(value);
    }
  }
  const categories = new Set(collections.categories.map(row => row.id));
  const users = new Set(collections.users.map(row => row.id));
  const brokenCategoryReferences = collections.products.filter(row => row.categoryId && !categories.has(row.categoryId)).length;
  const brokenOrderCustomers = collections.orders.filter(row => row.userId && !users.has(row.userId)).length;
  const brokenAddressCustomers = collections.addresses.filter(row => !users.has(row.customerId)).length;
  const historicalNonCodOrders = collections.orders.filter(row => row.paymentMethod && row.paymentMethod !== 'Cash on delivery').length;
  const incompleteDocuments = [];
  for (const [name, fields] of Object.entries(REQUIRED_FIELDS)) for (const row of collections[name] || []) for (const field of fields) {
    if (row[field] === undefined || row[field] === null || ['', 'undefined', 'null'].includes(row[field])) incompleteDocuments.push({ collection: name, reason: `missing_${field}` });
  }
  const invalidFields = [];
  for (const [name, schema] of Object.entries(mongoCollectionSchemas)) for (const row of collections[name] || []) {
    for (const key of schema.required) if (row[key] === undefined) invalidFields.push({ collection: name, field: key, reason: 'required' });
    for (const [key, rule] of Object.entries(schema.properties)) {
      const value = row[key]; if (value === undefined) continue;
      const types = Array.isArray(rule.bsonType) ? rule.bsonType : [rule.bsonType];
      const typeValid = !rule.bsonType || types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'date' ? value instanceof Date : ['int', 'long'].includes(type) ? Number.isSafeInteger(value) : ['double', 'decimal'].includes(type) ? typeof value === 'number' && Number.isFinite(value) : type === 'bool' ? typeof value === 'boolean' : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type);
      if (!typeValid || rule.enum && !rule.enum.includes(value) || rule.minimum != null && value < rule.minimum || rule.pattern && !new RegExp(rule.pattern).test(value)) invalidFields.push({ collection: name, field: key, reason: 'invalid_type_or_value' });
    }
  }
  return { duplicates, brokenCategoryReferences, brokenOrderCustomers, brokenAddressCustomers, historicalNonCodOrders, incompleteDocuments, invalidFields, valid: !duplicates.length && !brokenCategoryReferences && !brokenOrderCustomers && !brokenAddressCustomers && !incompleteDocuments.length && !invalidFields.length };
}

export const mongoMigrationCollections = COLLECTIONS;
