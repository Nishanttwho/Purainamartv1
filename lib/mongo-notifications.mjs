import { newId, nowIso } from './commerce.mjs';
import { fail } from './mongo-repository.mjs';
import crypto from 'node:crypto';
import { sendFirebaseInstallationMessage, isInvalidFirebaseInstallation, firebaseMessagingStatus } from './firebase-push.mjs';

export const defaultPreferences = () => ({ order_updates: true, payments: true, referrals_rewards: true, promotions: false, announcements: true });
export const templateDefaults = () => Object.fromEntries(['order_received','order_status','rider_assigned','delivery_status','payment_update','referral_reward','promotional_campaign','announcement','rider_order','admin_operational'].map(eventType => [eventType, { eventType, enabled: true, inAppEnabled: true, pushEnabled: true }]));
export function destination(value = '/') {
  const translated = String(value).replace('/#referrals', '/referral').replace('/#', '/');
  return /^\/(?:orders(?:\/[A-Za-z0-9_-]+)?|notifications|referral|offers|home|rider(?:\?order=[A-Za-z0-9_-]+)?)?$/.test(translated) ? translated : '/';
}
export async function preferences(repo, ownerType, ownerId) {
  const row = await repo.collection('notificationPreferences').findOne({ ownerType, ownerId }, repo.options());
  return { ...defaultPreferences(), ...row?.preferences };
}
export async function createNotice(repo, ownerType, ownerId, options) {
  if (!ownerId) return null;
  const eventType = options.eventType || 'order_status';
  const category = options.category || ({ payment_update: 'payments', referral_reward: 'referrals_rewards', promotional_campaign: 'promotions', announcement: 'announcements' })[eventType] || 'order_updates';
  const id = `${ownerType}:${ownerId}:${options.eventId || newId()}`.slice(0, 240);
  const existing = await repo.one('notificationEvents', { id });
  if (existing) return existing;
  const template = (await repo.setting('notificationTemplates', templateDefaults()))[eventType] || {};
  const allowed = (await preferences(repo, ownerType, ownerId))[category] !== false;
  const createdAt = nowIso(), notificationId = newId();
  const event = { id, eventId: id, eventType, ownerType, ownerId, notificationId, category, title: String(options.title || '').slice(0, 100), message: String(options.message || '').slice(0, 400), destination: destination(options.destination || '/orders'), orderId: options.orderId || null, campaignId: options.campaignId || null, createdAt, status: 'created' };
  await repo.insert('notificationEvents', event);
  if (template.enabled !== false && template.inAppEnabled !== false && (allowed || options.forceInApp) && options.inApp !== false && ownerType !== 'admin') {
    await repo.insert(ownerType === 'rider' ? 'riderNotifications' : 'notifications', { ...event, id: notificationId, ...(ownerType === 'rider' ? { riderId: ownerId } : { userId: ownerId }), type: options.type || (category === 'promotions' ? 'offer' : 'order'), readAt: null });
  }
  if (template.enabled !== false && template.pushEnabled !== false && allowed && options.push !== false) {
    await repo.insert('notificationOutbox', { id: newId(), eventId: id, ownerType, ownerId, notificationId, campaignId: event.campaignId, category, status: 'queued', attempts: 0, nextAttemptAt: createdAt, createdAt });
  }
  return { ...event, id: notificationId };
}
export async function saveDevice(repo, ownerType, ownerId, body, deactivate = false) {
  const key = String(body.deviceKey || '').trim();
  if (!/^[A-Fa-f0-9-]{20,80}$/.test(key)) fail(400, 'This browser registration is invalid.');
  const deviceKey = crypto.createHash('sha256').update(key).digest('hex');
  if (deactivate) { await repo.updateMany('notificationDevices', { ownerType, ownerId, deviceKey }, { $set: { status: 'inactive', updatedAt: nowIso() } }); return { ok: true }; }
  const fid = String(body.fid || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(fid) || body.platform !== 'web') fail(400, 'This browser registration is invalid.');
  const existing = await repo.one('notificationDevices', { $or: [{ platform: 'web', fid }, { platform: 'web', deviceKey }] });
  const fields = { ownerType, ownerId, deviceKey, fid, platform: 'web', status: 'active', updatedAt: nowIso(), lastSeenAt: nowIso(), metadata: { userAgent: String(body.metadata?.userAgent || '').slice(0, 240), language: String(body.metadata?.language || '').slice(0, 20) } };
  if (existing) Object.assign(existing, fields);
  else await repo.insert('notificationDevices', { id: newId(), createdAt: nowIso(), ...fields });
  return { ok: true, status: 'active' };
}
export async function savePreferences(repo, ownerType, ownerId, body) {
  const next = await preferences(repo, ownerType, ownerId);
  for (const key of Object.keys(defaultPreferences())) if (body[key] !== undefined) {
    if (typeof body[key] !== 'boolean') fail(400, 'Notification preferences must be enabled or disabled.');
    next[key] = body[key];
  }
  await repo.update('notificationPreferences', { ownerType, ownerId }, { $set: { preferences: next } }, { upsert: true });
  await repo.updateMany('notificationOutbox', { ownerType, ownerId, status: 'queued', category: { $in: Object.keys(next).filter(k => next[k] === false) } }, { $set: { status: 'skipped', processedAt: nowIso(), skipReason: 'preference' } });
  return { preferences: next };
}
export async function notificationList(repo, ownerType, ownerId, pagination = {}) {
  const collection = ownerType === 'rider' ? 'riderNotifications' : 'notifications';
  const filter = ownerType === 'rider' ? { riderId: ownerId } : { userId: ownerId };
  const notifications = await repo.list(collection, filter, { limit: 100, ...pagination });
  return { notifications, unread: await repo.count(collection, { ...filter, readAt: null }) };
}
export async function recipients(repo, target, category, adminId, { offset = 0, limit = 501 } = {}) {
  if (!target || typeof target !== 'object') fail(400, 'Choose a valid recipient group.');
  let ownerType = 'customer', rows = [];
  if (target.type === 'admin') return [{ ownerType: 'admin', ownerId: adminId }];
  if (['rider', 'all_riders', 'designated_rider'].includes(target.type)) {
    ownerType = 'rider';
    const id = target.type === 'designated_rider' ? (await repo.setting('dispatchSettings', {})).designatedRiderId : target.id;
    rows = await repo.list('riders', { isActive: { $ne: false }, ...(target.type !== 'all_riders' ? { id: String(id || '') } : {}) }, { skip: offset, limit });
  } else if (target.type === 'customer') rows = await repo.list('users', { id: String(target.id || ''), blockedAt: null }, { limit });
  else if (['all_customers', 'customers_ordered', 'customers_never_ordered', 'promotional_opt_in', 'delivery_area'].includes(target.type)) {
    const pipeline = [{ $match: { blockedAt: null } }];
    if (target.type === 'customers_ordered' || target.type === 'customers_never_ordered') {
      pipeline.push({ $lookup: { from: 'orders', localField: 'id', foreignField: 'userId', pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: 'matches' } }, { $match: { 'matches.0': { $exists: target.type === 'customers_ordered' } } });
    }
    if (target.type === 'delivery_area') {
      if (!await repo.exists('deliveryAreas', { id: String(target.areaId || ''), isActive: { $ne: false } })) fail(400, 'Choose an enabled delivery area.');
      pipeline.push({ $lookup: { from: 'addresses', localField: 'id', foreignField: 'customerId', pipeline: [{ $match: { deliveryAreaId: target.areaId } }, { $limit: 1 }], as: 'matches' } }, { $match: { 'matches.0': { $exists: true } } });
    }
    if (category === 'promotions' || target.type === 'promotional_opt_in') pipeline.push({ $lookup: { from: 'notificationPreferences', localField: 'id', foreignField: 'ownerId', pipeline: [{ $match: { ownerType: 'customer', 'preferences.promotions': true } }], as: 'preferences' } }, { $match: { 'preferences.0': { $exists: true } } });
    pipeline.push({ $sort: { id: 1 } }, { $skip: offset }, { $limit: limit }, { $project: { _id: 0, id: 1 } });
    rows = await repo.collection('users').aggregate(pipeline, repo.options()).toArray();
  } else fail(400, 'Choose a valid recipient group.');
  const result = [];
  for (const row of rows) if (category !== 'promotions' || (await preferences(repo, ownerType, row.id)).promotions) result.push({ ownerType, ownerId: row.id });
  return result;
}
export async function campaignPublic(repo, row) {
  // Driver operations sharing a transaction session must run sequentially.
  const attemptCount = await repo.count('notificationDeliveryLogs', { campaignId: row.id });
  const acceptedCount = await repo.count('notificationDeliveryLogs', { campaignId: row.id, status: 'accepted' });
  const failedCount = await repo.count('notificationDeliveryLogs', { campaignId: row.id, status: { $in: ['failed', 'invalid_device'] } });
  return { ...row, attemptCount, acceptedCount, failedCount };
}
export function startNotificationWorkers(repo, { intervalMs = 3000, send = sendFirebaseInstallationMessage, logger = console } = {}) {
  let stopping = false, pending = null;
  function run() {
    if (pending) return pending;
    if (stopping) return Promise.resolve();
    pending = drain().finally(() => { pending = null; });
    return pending;
  }
  async function drain() {
    try {
      // Fan-out writes are committed before any provider call. Each event has a
      // unique source ID so a retry cannot duplicate the in-app event/outbox.
      await repo.transaction(async () => {
        const campaign = await repo.one('notificationCampaigns', { status: { $in: ['queued', 'scheduled'] }, processedAt: null, $or: [{ scheduledAt: null }, { scheduledAt: { $lte: nowIso() } }] });
        if (!campaign) return;
        const targets = await recipients(repo, campaign.target, campaign.category, campaign.createdBy);
        if (targets.length > 500) { campaign.status = 'failed'; campaign.error = 'Recipient group now exceeds 500. Narrow the audience.'; campaign.processedAt = nowIso(); return; }
        for (const target of targets) await createNotice(repo, target.ownerType, target.ownerId, { ...campaign, eventType: campaign.category === 'promotions' ? 'promotional_campaign' : 'announcement', eventId: `campaign:${campaign.id}`, campaignId: campaign.id, inApp: campaign.channel !== 'push', push: campaign.channel !== 'in_app' });
        const queued = await repo.exists('notificationOutbox', { campaignId: campaign.id, status: 'queued' });
        campaign.recipientCount = targets.length; campaign.processedAt = nowIso(); campaign.status = targets.length ? (queued ? 'queued' : 'recorded') : 'failed';
      });
      // Without credentials keep jobs durable and queued for a later start.
      if (!firebaseMessagingStatus().serverConfigured && send === sendFirebaseInstallationMessage) return;
      for (let n = 0; n < 20 && !stopping; n++) {
        const at = nowIso(), claimId = newId();
        const job = await repo.collection('notificationOutbox').findOneAndUpdate({ $or: [{ status: 'queued', nextAttemptAt: { $lte: at } }, { status: 'processing', claimedAt: { $lt: new Date(Date.now() - 600000).toISOString() } }] }, { $set: { status: 'processing', claimedAt: at, claimId }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } });
        if (!job) break;
        const event = await repo.one('notificationEvents', { id: job.eventId });
        const allowed = event && (await preferences(repo, job.ownerType, job.ownerId))[event.category] !== false;
        const devices = allowed ? await repo.list('notificationDevices', { ownerType: job.ownerType, ownerId: job.ownerId, status: 'active' }, { limit: 20 }) : [];
        const outcomes = [];
        for (const device of devices) {
          if (stopping) break;
          // A browser installation can be reassigned on account switch while
          // this job is in flight. Recheck ownership before every provider send.
          if (!await repo.exists('notificationDevices', { id: device.id, fid: device.fid, ownerType: job.ownerType, ownerId: job.ownerId, status: 'active' })) continue;
          if (!(await preferences(repo, job.ownerType, job.ownerId))[event.category]) continue;
          if (await repo.exists('notificationDeliveryLogs', { eventId: job.eventId, deviceId: device.id, status: 'accepted' })) continue;
          try { const messageId = await send(device.fid, { title: event.title, body: event.message, destination: destination(event.destination), notificationId: event.notificationId, eventId: job.eventId }); outcomes.push({ device, ok: true, messageId }); }
          catch (error) { outcomes.push({ device, ok: false, code: String(error.code || 'provider_error').slice(0, 80) }); }
        }
        await repo.transaction(async () => {
          const live = await repo.one('notificationOutbox', { id: job.id, status: 'processing', claimId });
          if (!live) return;
          for (const result of outcomes) {
            const invalid = !result.ok && isInvalidFirebaseInstallation({ code: result.code });
            await repo.insert('notificationDeliveryLogs', { id: newId(), campaignId: job.campaignId || null, eventId: job.eventId, ownerType: job.ownerType, ownerId: job.ownerId, deviceId: result.device.id, status: result.ok ? 'accepted' : invalid ? 'invalid_device' : 'failed', attemptedAt: nowIso(), providerMessageId: result.messageId || null, errorCode: result.code || null });
            if (invalid) await repo.update('notificationDevices', { id: result.device.id, fid: result.device.fid }, { $set: { status: 'invalid', updatedAt: nowIso() } });
          }
          const failed = outcomes.some(row => !row.ok && !isInvalidFirebaseInstallation({ code: row.code }));
          const accepted = await repo.exists('notificationDeliveryLogs', { eventId: job.eventId, status: 'accepted' });
          live.status = stopping ? 'queued' : !devices.length ? 'skipped' : failed ? job.attempts < 8 ? 'queued' : 'failed' : accepted ? 'accepted' : outcomes.length ? 'failed' : 'skipped';
          live.processedAt = live.status === 'queued' ? null : nowIso();
          if (live.status === 'queued') live.nextAttemptAt = new Date(Date.now() + Math.min(21600000, 30000 * 2 ** (job.attempts - 1))).toISOString();
        });
        if (job.campaignId) {
          const remaining = await repo.count('notificationOutbox', { campaignId: job.campaignId, status: { $in: ['queued', 'processing'] } });
          if (!remaining) {
            const failed = await repo.count('notificationOutbox', { campaignId: job.campaignId, status: 'failed' });
            await repo.update('notificationCampaigns', { id: job.campaignId, status: { $ne: 'cancelled' } }, { $set: { status: failed ? 'partial' : 'accepted', deliveryFinishedAt: nowIso() } });
          }
        }
      }
    } catch (error) { logger.error(JSON.stringify({ event: 'notification_worker_failed', name: error.name, code: error.code || 'UNKNOWN' })); }
  }
  const timer = setInterval(() => { void run(); }, intervalMs); timer.unref();
  return { run, async stop() { stopping = true; clearInterval(timer); await pending; } };
}
