import crypto from 'node:crypto';

export const MIGRATION_VERSION = 3;
export const MIGRATION_NAME = '003_quantity_pricing';
let snapshotReadCount = 0;

export async function assertPostgresSchema(pool) {
  let result;
  try { result = await pool.query('SELECT version FROM schema_migrations ORDER BY version'); }
  catch (error) {
    if (error.code === '42P01') throw new Error('PostgreSQL schema is not initialized. Run `npm run db:migrate` before starting the app.');
    throw error;
  }
  if (Number(result.rows.at(-1)?.version) !== MIGRATION_VERSION) {
    throw new Error('PostgreSQL schema is not initialized. Run `npm run db:migrate` before starting the app.');
  }
}

export async function readPostgresStore(client) {
  const startedAt = Date.now();
  const queryStartedAt = Date.now();
  // A pg Client runs one query at a time. Promise.all here queues each query
  // serially, emits pg's concurrent-query deprecation warning, and adds a pooler
  // round trip per table. Keep all snapshot data in one statement on this client
  // so the transaction and its MVCC view remain consistent.
  const result = await client.query(`
    WITH base AS MATERIALIZED (SELECT store_snapshot() AS state),
    related AS MATERIALIZED (
      SELECT jsonb_build_object(
        'devices', COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM notification_devices d), '[]'::jsonb),
        'preferences', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM notification_preferences p), '[]'::jsonb),
        'templates', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM notification_templates t), '[]'::jsonb),
        'events', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM notification_events e), '[]'::jsonb),
        'outbox', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM notification_outbox o), '[]'::jsonb),
        'campaigns', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC) FROM notification_campaigns c), '[]'::jsonb),
        'logs', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.attempted_at DESC) FROM (SELECT * FROM notification_delivery_logs ORDER BY attempted_at DESC LIMIT 2000) l), '[]'::jsonb),
        'riderNotifications', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rider_id, r.position) FROM rider_notifications r), '[]'::jsonb),
        'variantCartRows', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.owner_id, v.product_id, v.variant_id) FROM cart_variant_items v), '[]'::jsonb),
        'settings', COALESCE((SELECT jsonb_object_agg(key, data) FROM application_settings WHERE key IN ('homepageBanners','homepageHeroFruitImage')), '{}'::jsonb)
      ) AS data
    )
    SELECT base.state, pg_column_size(base.state) AS state_bytes,
      related.data AS related, pg_column_size(related.data) AS related_bytes
    FROM base CROSS JOIN related
  `);
  const queryMs = Date.now() - queryStartedAt;
  const snapshot = result.rows[0]?.state;
  if (!snapshot || snapshot.__initialized !== true) return null;
  const { __initialized: _initialized, ...state } = snapshot;
  for (const key of ['sessions','riderSessions','adminSessions']) state[key] = Object.fromEntries(Object.entries(state[key] || {}).map(([id,value]) => [`h:${id.replace(/^h:/, '')}`, value]));
  const mappingStartedAt = Date.now();
  const related = result.rows[0]?.related || {};
  const devices = related.devices || [], preferences = related.preferences || [], templates = related.templates || [], events = related.events || [], outbox = related.outbox || [], campaigns = related.campaigns || [], logs = related.logs || [], riderNotifications = related.riderNotifications || [], variantCartRows = related.variantCartRows || [];
  state.variantCarts = {};
  for (const row of variantCartRows) { state.variantCarts[row.owner_id] ||= {}; state.variantCarts[row.owner_id][row.product_id] ||= {}; state.variantCarts[row.owner_id][row.product_id][row.variant_id] = Number(row.quantity); }
  state.notificationDevices = devices.map(row => ({ id:row.id,ownerType:row.owner_type,ownerId:row.owner_id,platform:row.platform,fid:row.fid,deviceKey:row.device_key,status:row.status,createdAt:row.created_at?.toISOString?.() || row.created_at,updatedAt:row.updated_at?.toISOString?.() || row.updated_at,lastSeenAt:row.last_seen_at?.toISOString?.() || row.last_seen_at,metadata:row.metadata }));
  state.notificationPreferences = {};
  for (const row of preferences) { state.notificationPreferences[row.owner_type] ||= {}; state.notificationPreferences[row.owner_type][row.owner_id] ||= {}; state.notificationPreferences[row.owner_type][row.owner_id][row.category] = row.enabled; }
  state.notificationTemplates = Object.fromEntries(templates.map(row => [row.event_type,{...row.data,eventType:row.event_type,enabled:row.enabled,inAppEnabled:row.in_app_enabled,pushEnabled:row.push_enabled,updatedAt:row.updated_at?.toISOString?.() || row.updated_at,updatedBy:row.updated_by}]));
  state.notificationEvents = Object.fromEntries(events.map(row => [row.event_id,{...row.data,eventId:row.event_id,eventType:row.event_type,ownerType:row.owner_type,ownerId:row.owner_id,createdAt:row.created_at?.toISOString?.() || row.created_at}]));
  state.notificationOutbox = outbox.map(row => ({...row.data,id:row.id,eventId:row.event_id,ownerType:row.owner_type,ownerId:row.owner_id,status:row.status,attempts:row.attempts,nextAttemptAt:row.next_attempt_at?.toISOString?.() || row.next_attempt_at,createdAt:row.created_at?.toISOString?.() || row.created_at,processedAt:row.processed_at?.toISOString?.() || row.processed_at}));
  state.notificationCampaigns = campaigns.map(row => ({...row.data,id:row.id,title:row.title,category:row.category,channel:row.channel,target:row.target,destination:row.destination,status:row.status,scheduledAt:row.scheduled_at?.toISOString?.() || row.scheduled_at,createdAt:row.created_at?.toISOString?.() || row.created_at,createdBy:row.created_by,processedAt:row.processed_at?.toISOString?.() || row.processed_at,recipientCount:row.recipient_count,acceptedCount:row.accepted_count,failedCount:row.failed_count}));
  state.notificationDeliveryLogs = logs.map(row => ({...row.data,id:row.id,campaignId:row.campaign_id,eventId:row.event_id,ownerType:row.owner_type,ownerId:row.owner_id,deviceId:row.device_id,status:row.status,attemptedAt:row.attempted_at?.toISOString?.() || row.attempted_at,providerMessageId:row.provider_message_id,errorCode:row.error_code}));
  state.riderNotifications = {};
  for (const row of riderNotifications) { state.riderNotifications[row.rider_id] ||= []; state.riderNotifications[row.rider_id].push(row.data); }
  const settings = related.settings || {};
  if (Object.hasOwn(settings, 'homepageBanners')) state.homepageBanners = settings.homepageBanners;
  if (Object.hasOwn(settings, 'homepageHeroFruitImage')) state.homepageHeroFruitImage = settings.homepageHeroFruitImage;
  const mappingMs = Date.now() - mappingStartedAt;
  const totalMs = Date.now() - startedAt;
  snapshotReadCount++;
  if (totalMs >= 250 || snapshotReadCount <= 5 || snapshotReadCount % 100 === 0) console.info(JSON.stringify({ event: 'postgres_snapshot_read', sample: snapshotReadCount, queryMs, mappingMs, totalMs, stateBytes: Number(result.rows[0]?.state_bytes || 0), relatedBytes: Number(result.rows[0]?.related_bytes || 0), users: state.users?.length || 0, products: state.products?.length || 0, orders: state.orders?.length || 0, notifications: Object.values(state.notifications || {}).reduce((sum, rows) => sum + rows.length, 0), notificationDevices: devices.length, outbox: outbox.length, campaigns: campaigns.length, deliveryLogs: logs.length, variantCartRows: variantCartRows.length }));
  return state;
}

export async function writePostgresStore(client, state, { replace = true } = {}) {
  const snapshot = structuredClone(state);
  for (const key of ['sessions','riderSessions','adminSessions']) {
    snapshot[key] = Object.fromEntries(Object.entries(snapshot[key] || {}).map(([id,value]) => {
      const storedId = id.startsWith('h:') && /^[a-f0-9]{64}$/.test(id.slice(2)) ? id.slice(2) : crypto.createHash('sha256').update(id).digest('hex');
      return [storedId,value];
    }));
  }
  await client.query('SELECT write_store_snapshot($1::jsonb, $2::boolean)', [JSON.stringify(snapshot), replace]);
  if (snapshot.homepageBanners !== undefined) await client.query("INSERT INTO application_settings(key,data) VALUES('homepageBanners',$1::jsonb) ON CONFLICT(key) DO UPDATE SET data=excluded.data", [JSON.stringify(snapshot.homepageBanners)]);
  if (snapshot.homepageHeroFruitImage !== undefined) await client.query("INSERT INTO application_settings(key,data) VALUES('homepageHeroFruitImage',$1::jsonb) ON CONFLICT(key) DO UPDATE SET data=excluded.data", [JSON.stringify(snapshot.homepageHeroFruitImage)]);
  if (replace) await client.query('DELETE FROM cart_variant_items');
  for (const [ownerId,products] of Object.entries(snapshot.variantCarts || {})) for (const [productId,variants] of Object.entries(products || {})) for (const [variantId,quantity] of Object.entries(variants || {})) {
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > 10) continue;
    await client.query('INSERT INTO cart_variant_items(owner_id,product_id,variant_id,quantity) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,product_id,variant_id) DO UPDATE SET quantity=excluded.quantity', [ownerId,productId,variantId,count]);
  }
  const tables = ['notification_delivery_logs','notification_outbox','notification_events','notification_devices','notification_preferences','notification_templates','notification_campaigns','rider_notifications'];
  if (replace) for (const table of tables) await client.query(`DELETE FROM ${table}`);
  const json = value => JSON.stringify(value ?? {});
  for (const row of snapshot.notificationDevices || []) {
    if (!replace) await client.query('DELETE FROM notification_devices WHERE platform=$1 AND device_key=$2 AND id<>$3',[row.platform,row.deviceKey,row.id]);
    await client.query(`INSERT INTO notification_devices(id,owner_type,owner_id,platform,fid,device_key,status,created_at,updated_at,last_seen_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(platform,fid) DO UPDATE SET owner_type=excluded.owner_type,owner_id=excluded.owner_id,device_key=excluded.device_key,status=excluded.status,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,metadata=excluded.metadata`,[row.id,row.ownerType,row.ownerId,row.platform,row.fid,row.deviceKey,row.status,row.createdAt,row.updatedAt,row.lastSeenAt,json(row.metadata)]);
  }
  for (const [ownerType,owners] of Object.entries(snapshot.notificationPreferences || {})) for (const [ownerId,categories] of Object.entries(owners || {})) for (const [category,enabled] of Object.entries(categories || {})) await client.query('INSERT INTO notification_preferences(owner_type,owner_id,category,enabled,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(owner_type,owner_id,category) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at',[ownerType,ownerId,category,Boolean(enabled)]);
  for (const [eventType,row] of Object.entries(snapshot.notificationTemplates || {})) await client.query('INSERT INTO notification_templates(event_type,enabled,in_app_enabled,push_enabled,updated_at,updated_by,data) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),$6,$7::jsonb) ON CONFLICT(event_type) DO UPDATE SET enabled=excluded.enabled,in_app_enabled=excluded.in_app_enabled,push_enabled=excluded.push_enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by,data=excluded.data',[eventType,row.enabled!==false,row.inAppEnabled!==false,row.pushEnabled!==false,row.updatedAt || null,row.updatedBy || null,json(row)]);
  for (const [eventId,row] of Object.entries(snapshot.notificationEvents || {})) await client.query('INSERT INTO notification_events(event_id,event_type,owner_type,owner_id,created_at,data) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),$6::jsonb) ON CONFLICT(event_id) DO UPDATE SET event_type=excluded.event_type,owner_type=excluded.owner_type,owner_id=excluded.owner_id,data=excluded.data',[eventId,row.eventType || 'unknown',row.ownerType || 'customer',row.ownerId || '',row.createdAt || null,json(row)]);
  for (const row of snapshot.notificationCampaigns || []) await client.query(`INSERT INTO notification_campaigns(id,title,category,channel,target,destination,status,scheduled_at,created_at,created_by,processed_at,recipient_count,accepted_count,failed_count,data) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,channel=excluded.channel,target=excluded.target,destination=excluded.destination,status=excluded.status,scheduled_at=excluded.scheduled_at,processed_at=excluded.processed_at,recipient_count=excluded.recipient_count,accepted_count=excluded.accepted_count,failed_count=excluded.failed_count,data=excluded.data`,[row.id,row.title,row.category,row.channel,json(row.target),row.destination || '/',row.status,row.scheduledAt || null,row.createdAt,row.createdBy || 'system',row.processedAt || null,row.recipientCount || 0,row.acceptedCount || 0,row.failedCount || 0,json(row)]);
  for (const row of snapshot.notificationOutbox || []) await client.query(`INSERT INTO notification_outbox(id,event_id,owner_type,owner_id,status,attempts,next_attempt_at,created_at,processed_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,processed_at=excluded.processed_at,data=excluded.data`,[row.id,row.eventId,row.ownerType,row.ownerId,row.status,row.attempts || 0,row.nextAttemptAt || null,row.createdAt,row.processedAt || null,json(row)]);
  for (const row of snapshot.notificationDeliveryLogs || []) await client.query(`INSERT INTO notification_delivery_logs(id,campaign_id,event_id,owner_type,owner_id,device_id,status,attempted_at,provider_message_id,error_code,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempted_at=excluded.attempted_at,provider_message_id=excluded.provider_message_id,error_code=excluded.error_code,data=excluded.data`,[row.id,row.campaignId || null,row.eventId || null,row.ownerType,row.ownerId,row.deviceId || null,row.status,row.attemptedAt,row.providerMessageId || null,row.errorCode || null,json(row)]);
  for (const [riderId,rows] of Object.entries(snapshot.riderNotifications || {})) for (let position=0;position<rows.length;position++) { const row=rows[position]; await client.query('INSERT INTO rider_notifications(id,rider_id,position,created_at,data) VALUES($1,$2,$3,COALESCE($4::timestamptz,now()),$5::jsonb) ON CONFLICT(id) DO UPDATE SET rider_id=excluded.rider_id,position=excluded.position,data=excluded.data',[row.id,riderId,position,row.createdAt || null,json(row)]); }
}
