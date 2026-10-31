import { MongoClient } from 'mongodb';

const EXPECTED_DATABASE = 'purainamart';
let clientPromise;
let client;
let database;
let closingPromise;

const indexes = {
  mediaAssets: [[{ id: 1 }, { unique: true, name: 'media_id_unique' }], [{ public_id: 1 }, { unique: true, name: 'media_public_id_unique' }], [{ secure_url: 1, ownerId: 1, status: 1 }, { name: 'media_attach' }], [{ cloudName: 1, status: 1, cleanupAfter: 1 }, { name: 'media_cleanup' }]],
  users: [[{ id: 1 }, { unique: true, name: 'users_id_unique' }], [{ phone: 1 }, { partialFilterExpression: { phone: { $type: 'string' } }, unique: true, name: 'users_phone_unique' }], [{ email: 1 }, { partialFilterExpression: { email: { $type: 'string' } }, unique: true, name: 'users_email_unique' }], [{ referralCode: 1 }, { partialFilterExpression: { referralCode: { $type: 'string' } }, unique: true, name: 'users_referral_code_unique' }], [{ googleSub: 1 }, { partialFilterExpression: { googleSub: { $type: 'string' } }, unique: true, name: 'users_google_unique' }]],
  admins: [[{ id: 1 }, { unique: true, name: 'admins_id_unique' }]],
  riders: [[{ id: 1 }, { unique: true, name: 'riders_id_unique' }], [{ phone: 1 }, { unique: true, name: 'riders_phone_unique' }]],
  sessions: [[{ kind: 1, idHash: 1 }, { unique: true, name: 'sessions_kind_hash_unique' }], [{ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'sessions_expiry_ttl' }], [{ kind: 1, ownerId: 1 }, { name: 'sessions_owner' }]],
  authAttempts: [[{ id: 1 }, { unique: true, name: 'auth_attempt_id' }], [{ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'auth_attempt_expiry' }]],
  shoppingPreferences: [[{ ownerId: 1 }, { unique: true, name: 'shopping_preferences_owner' }]],
  referralEvents: [[{ id: 1 }, { unique: true, name: 'referral_events_id' }]],
  products: [[{ id: 1 }, { unique: true, name: 'products_id_unique' }], [{ category: 1, isActive: 1, rank: 1 }, { name: 'products_category_active_rank' }], [{ name: 'text', detail: 'text', description: 'text' }, { name: 'products_search_text' }]],
  categories: [[{ id: 1 }, { unique: true, name: 'categories_id_unique' }], [{ parentId: 1, position: 1 }, { name: 'categories_parent_position' }]],
  carts: [[{ ownerId: 1 }, { unique: true, name: 'carts_owner_unique' }]],
  wishlists: [[{ ownerId: 1 }, { unique: true, name: 'wishlists_owner_unique' }]],
  addresses: [[{ customerId: 1, id: 1 }, { unique: true, name: 'addresses_customer_id_unique' }]],
  orders: [[{ id: 1 }, { unique: true, name: 'orders_id_unique' }], [{ userId: 1, createdAt: -1 }, { name: 'orders_customer_created' }], [{ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'orders_idempotency_unique' }]],
  coupons: [[{ code: 1 }, { unique: true, name: 'coupons_code_unique' }]],
  couponRedemptions: [[{ couponCode: 1, userId: 1, orderId: 1 }, { unique: true, name: 'coupon_redemption_order_unique' }], [{ couponCode: 1, userId: 1, redeemedAt: -1 }, { name: 'coupon_redemptions_customer_history' }]],
  notifications: [[{ id: 1 }, { unique: true, name: 'notifications_id' }], [{ userId: 1, createdAt: -1 }, { name: 'notifications_customer_created' }], [{ userId: 1, readAt: 1 }, { name: 'notifications_unread' }]],
  notificationOutbox: [[{ id: 1 }, { unique: true, name: 'notification_outbox_id_unique' }], [{ eventId: 1 }, { unique: true, name: 'notification_outbox_event_unique' }], [{ status: 1, nextAttemptAt: 1 }, { name: 'notification_outbox_pending' }]],
  rewards: [[{ id: 1 }, { unique: true, name: 'rewards_id_unique' }], [{ userId: 1, status: 1 }, { name: 'rewards_customer_status' }]],
  referrals: [[{ id: 1 }, { unique: true, name: 'referrals_id_unique' }], [{ referredUserId: 1 }, { unique: true, name: 'referrals_referred_unique' }]],
  settings: [[{ key: 1 }, { unique: true, name: 'settings_key_unique' }]],
  deliveryAreas: [[{ id: 1 }, { unique: true, name: 'delivery_areas_id_unique' }]],
  notificationPreferences: [[{ ownerType: 1, ownerId: 1 }, { unique: true, name: 'notification_preferences_owner_unique' }]],
  notificationDevices: [[{ id: 1 }, { unique: true, name: 'notification_devices_id_unique' }], [{ ownerType: 1, ownerId: 1, deviceKey: 1 }, { unique: true, name: 'notification_devices_owner_key_unique' }]],
  notificationEvents: [[{ id: 1 }, { unique: true, name: 'notification_events_id_unique' }]],
  notificationCampaigns: [[{ id: 1 }, { unique: true, name: 'notification_campaigns_id_unique' }], [{ status: 1, scheduledAt: 1 }, { name: 'notification_campaigns_schedule' }]],
  notificationDeliveryLogs: [[{ id: 1 }, { unique: true, name: 'notification_delivery_logs_id_unique' }]],
  riderNotifications: [[{ riderId: 1, id: 1 }, { unique: true, name: 'rider_notifications_owner_id_unique' }]],
  adminAuditLog: [[{ id: 1 }, { unique: true, name: 'admin_audit_id_unique' }]]
};

indexes.orders.push([{ riderId: 1, status: 1, deliveredAt: -1 }, { name: 'orders_rider_status' }], [{ status: 1, riderId: 1, createdAt: -1 }, { name: 'orders_dispatch' }]);
indexes.carts.push([{ 'items.productId': 1 }, { name: 'carts_product' }]);
indexes.addresses.push([{ deliveryAreaId: 1, customerId: 1 }, { name: 'addresses_area' }]);
indexes.referrals.push([{ referrerUserId: 1, attributedAt: -1 }, { name: 'referrals_referrer' }], [{ qualifyingOrderId: 1 }, { name: 'referrals_order' }]);
indexes.rewards.push([{ qualifyingOrderId: 1 }, { unique: true, partialFilterExpression: { qualifyingOrderId: { $type: 'string' } }, name: 'reward_qualifying_order_unique' }]);
indexes.notificationDevices.push([{ platform: 1, fid: 1 }, { unique: true, partialFilterExpression: { fid: { $type: 'string' } }, name: 'notification_device_installation' }]);
indexes.notificationDeliveryLogs.push([{ eventId: 1, deviceId: 1, status: 1 }, { name: 'delivery_log_event_device' }], [{ campaignId: 1, status: 1 }, { name: 'delivery_log_campaign' }]);
indexes.adminAuditLog.push([{ userId: 1, at: -1 }, { name: 'audit_customer_time' }]);
indexes.coupons.push([{ userId: 1, isActive: 1 }, { name: 'coupons_customer_active' }]);
indexes.orders.push([{ userId: 1, couponCode: 1 }, { name: 'orders_customer_coupon' }]);
indexes.notificationOutbox.push([{ status: 1, claimedAt: 1 }, { name: 'notification_outbox_expired_claim' }]);
indexes.referralEvents.push([{ at: -1 }, { name: 'referral_events_time' }]);
// Match the stable sort used by bounded catalogue/management/history pages.
indexes.products.push([{ position: 1, rank: 1, id: 1 }, { name: 'products_catalogue_order' }], [{ createdAt: -1, id: 1 }, { name: 'products_admin_page' }]);
indexes.categories.push([{ position: 1, id: 1 }, { name: 'categories_public_order' }]);
indexes.orders.push([{ createdAt: -1, id: 1 }, { name: 'orders_admin_page' }], [{ userId: 1, createdAt: -1, id: 1 }, { name: 'orders_customer_page' }]);
indexes.addresses.push([{ customerId: 1, isDefault: 1 }, { name: 'addresses_customer_default' }]);
indexes.riderNotifications.push([{ riderId: 1, createdAt: -1, id: 1 }, { name: 'rider_notifications_page' }], [{ riderId: 1, readAt: 1 }, { name: 'rider_notifications_unread' }]);

const schemas = {
  mediaAssets: { required: ['id', 'ownerId', 'public_id', 'status'], properties: { id: { bsonType: 'string' }, ownerId: { bsonType: 'string' }, public_id: { bsonType: 'string' }, status: { enum: ['pending', 'ready', 'attached', 'abandoned', 'deleting', 'deleted'] } } },
  authAttempts: { required: ['id', 'expiresAt', 'failures'], properties: { id: { bsonType: 'string' }, expiresAt: { bsonType: 'date' }, failures: { bsonType: ['int', 'long'] } } },
  shoppingPreferences: { required: ['ownerId'], properties: { ownerId: { bsonType: 'string' } } },
  referralEvents: { required: ['id'], properties: { id: { bsonType: 'string' } } },
  users: { required: ['id'], properties: { id: { bsonType: 'string' }, phone: { bsonType: ['string', 'null'] }, email: { bsonType: ['string', 'null'] }, passwordHash: { bsonType: ['string', 'null'] }, blockedAt: { bsonType: ['string', 'null'] } } },
  admins: { required: ['id'], properties: { id: { bsonType: 'string' }, passwordHash: { bsonType: ['string', 'null'] } } },
  riders: { required: ['id'], properties: { id: { bsonType: 'string' }, phone: { bsonType: 'string' }, isActive: { bsonType: 'bool' } } },
  sessions: { required: ['kind', 'idHash', 'ownerId', 'authMethod', 'createdAt', 'expiresAt'], properties: { kind: { enum: ['customer', 'admin', 'rider'] }, idHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, ownerId: { bsonType: 'string' }, authMethod: { bsonType: 'string' }, createdAt: { bsonType: 'date' }, expiresAt: { bsonType: 'date' } } },
  products: { required: ['id', 'name', 'price', 'stock'], properties: { id: { bsonType: 'string' }, name: { bsonType: 'string' }, price: { bsonType: ['int', 'long', 'double', 'decimal'] }, stock: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 }, isActive: { bsonType: 'bool' }, variants: { bsonType: 'array' } } },
  categories: { required: ['id', 'name'], properties: { id: { bsonType: 'string' }, name: { bsonType: 'string' }, isActive: { bsonType: 'bool' } } },
  carts: { required: ['ownerId', 'items', 'version'], properties: { ownerId: { bsonType: 'string' }, items: { bsonType: 'array' }, version: { bsonType: ['int', 'long'], minimum: 0 } } },
  wishlists: { required: ['ownerId', 'productIds'], properties: { ownerId: { bsonType: 'string' }, productIds: { bsonType: 'array', items: { bsonType: 'string' } } } },
  addresses: { required: ['customerId', 'id'], properties: { customerId: { bsonType: 'string' }, id: { bsonType: 'string' } } },
  orders: { required: ['id', 'userId', 'status', 'paymentMethod', 'paymentStatus', 'items'], properties: { id: { bsonType: 'string' }, userId: { bsonType: 'string' }, status: { bsonType: 'string' }, paymentMethod: { bsonType: 'string' }, paymentStatus: { bsonType: 'string' }, items: { bsonType: 'array' }, total: { bsonType: ['int', 'long', 'double', 'decimal'] } } },
  coupons: { required: ['code'], properties: { code: { bsonType: 'string' }, redemptionCount: { bsonType: ['int', 'long'], minimum: 0 }, isActive: { bsonType: 'bool' } } },
  couponRedemptions: { required: ['couponCode', 'userId', 'orderId', 'redeemedAt'], properties: { couponCode: { bsonType: 'string' }, userId: { bsonType: 'string' }, orderId: { bsonType: 'string' }, redeemedAt: { bsonType: ['date', 'string'] } } },
  notifications: { required: ['id', 'userId'], properties: { id: { bsonType: 'string' }, userId: { bsonType: 'string' }, createdAt: { bsonType: ['string', 'date'] } } },
  notificationOutbox: { required: ['id', 'eventId', 'status'], properties: { id: { bsonType: 'string' }, eventId: { bsonType: 'string' }, status: { bsonType: 'string' }, attempts: { bsonType: ['int', 'long'], minimum: 0 } } },
  deliveryAreas: { required: ['id'], properties: { id: { bsonType: 'string' }, name: { bsonType: 'string' }, isActive: { bsonType: 'bool' } } },
  notificationPreferences: { required: ['ownerType', 'ownerId', 'preferences'], properties: { ownerType: { enum: ['customer', 'admin', 'rider'] }, ownerId: { bsonType: 'string' }, preferences: { bsonType: 'object' } } },
  notificationDevices: { required: ['id', 'ownerType', 'ownerId', 'deviceKey'], properties: { id: { bsonType: 'string' }, ownerType: { enum: ['customer', 'admin', 'rider'] }, ownerId: { bsonType: 'string' }, deviceKey: { bsonType: 'string' } } },
  notificationEvents: { required: ['id'], properties: { id: { bsonType: 'string' }, eventType: { bsonType: 'string' }, ownerId: { bsonType: ['string', 'null'] } } },
  notificationCampaigns: { required: ['id', 'status'], properties: { id: { bsonType: 'string' }, status: { bsonType: 'string' }, scheduledAt: { bsonType: ['string', 'null'] } } },
  notificationDeliveryLogs: { required: ['id'], properties: { id: { bsonType: 'string' }, campaignId: { bsonType: ['string', 'null'] } } },
  riderNotifications: { required: ['id', 'riderId'], properties: { id: { bsonType: 'string' }, riderId: { bsonType: 'string' } } },
  adminAuditLog: { required: ['id'], properties: { id: { bsonType: 'string' }, adminId: { bsonType: ['string', 'null'] }, action: { bsonType: ['string', 'null'] } } },
  rewards: { required: ['id', 'userId', 'status'], properties: { id: { bsonType: 'string' }, userId: { bsonType: 'string' }, status: { bsonType: 'string' }, redemptionCount: { bsonType: ['int', 'long'], minimum: 0 } } },
  referrals: { required: ['id'], properties: { id: { bsonType: 'string' }, referredUserId: { bsonType: ['string', 'null'] } } },
  settings: { required: ['key'], properties: { key: { bsonType: 'string' } } }
};

export function mongoConnectionOptions(env = process.env) {
  const value = env.MONGODB_URI;
  if (!value) throw new Error('MONGODB_URI is required.');
  if (!/^mongodb(?:\+srv)?:\/\//.test(value)) throw new Error('MONGODB_URI must use mongodb or mongodb+srv.');
  // The driver's parser supports seed lists and IPv6; WHATWG URL does not.
  // Construction parses options only and performs no connection or DNS lookup.
  let parsed;
  try { parsed = new MongoClient(value); } catch { throw new Error('MONGODB_URI must be a valid MongoDB connection URI.'); }
  const dbName = parsed.options.dbName;
  if (dbName !== EXPECTED_DATABASE) throw new Error(`MONGODB_URI must explicitly select the ${EXPECTED_DATABASE} database.`);
  return {
    uri: value,
    dbName,
    options: {
      appName: 'purainamart',
      maxPoolSize: 20,
      minPoolSize: 0,
      maxConnecting: 2,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 30000,
      retryReads: true,
      retryWrites: true
    }
  };
}

export async function initializeMongo({ env = process.env, MongoClientClass = MongoClient, logger = console } = {}) {
  if (closingPromise) await closingPromise;
  if (database) return database;
  if (!clientPromise) {
    const config = mongoConnectionOptions(env);
    clientPromise = (async () => {
      const nextClient = new MongoClientClass(config.uri, config.options);
      const startedAt = Date.now();
      try {
        await nextClient.connect();
        const nextDb = nextClient.db(config.dbName);
        await nextDb.command({ ping: 1 });
        const topology = await nextDb.command({ hello: 1 });
        if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('MongoDB must run as a replica set or sharded cluster to support atomic checkout transactions.');
        await ensureMongoIndexes(nextDb);
        client = nextClient;
        database = nextDb;
        logger.info?.(JSON.stringify({ event: 'mongodb_ready', database: EXPECTED_DATABASE, durationMs: Date.now() - startedAt }));
        return database;
      } catch (error) {
        await nextClient.close().catch(() => {});
        clientPromise = undefined;
        logger.error?.(JSON.stringify({ event: 'mongodb_startup_failed', code: error?.code || 'UNKNOWN', name: error?.name || 'Error' }));
        throw error;
      }
    })();
  }
  return clientPromise;
}

export async function ensureMongoIndexes(db) {
  for (const [collectionName, validator] of Object.entries(schemas)) {
    const exists = await db.listCollections({ name: collectionName }, { nameOnly: true }).hasNext();
    if (!exists) {
      try {
        await db.createCollection(collectionName, { validator: { $jsonSchema: { bsonType: 'object', required: validator.required, properties: validator.properties } }, validationLevel: 'strict', validationAction: 'error' });
      } catch (error) {
        if (error.code !== 48) throw error;
        await db.command({ collMod: collectionName, validator: { $jsonSchema: { bsonType: 'object', required: validator.required, properties: validator.properties } }, validationLevel: 'strict', validationAction: 'error' });
      }
    } else {
      await db.command({ collMod: collectionName, validator: { $jsonSchema: { bsonType: 'object', required: validator.required, properties: validator.properties } }, validationLevel: 'strict', validationAction: 'error' });
    }
  }
  for (const [collectionName, specs] of Object.entries(indexes)) {
    const collection = db.collection(collectionName);
    for (const [keys, options] of specs) await collection.createIndex(keys, options);
  }
}

export async function getMongoDb() {
  if (!database) await initializeMongo();
  return database;
}

export async function getMongoClient() {
  await getMongoDb();
  return client;
}

export async function closeMongo() {
  if (!closingPromise) {
    closingPromise = (async () => {
      try { await clientPromise; } catch { /* initialization closes its failed client */ }
      const closing = client;
      client = undefined;
      database = undefined;
      clientPromise = undefined;
      if (closing) await closing.close();
    })();
  }
  try { await closingPromise; } finally { closingPromise = undefined; }
}

export async function withMongoTransaction(callback) {
  if (!client || !database) throw new Error('MongoDB is not initialized.');
  const session = client.startSession();
  try {
    return await session.withTransaction(() => callback(database, session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
  } finally {
    await session.endSession();
  }
}

export function mongoReady() {
  return Boolean(database && client);
}

export const mongoCollectionIndexes = indexes;
export const mongoCollectionSchemas = schemas;
