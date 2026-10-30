import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/api-fixture.mjs';
import { createNotice, startNotificationWorkers } from '../lib/mongo-notifications.mjs';

const registration = { deviceKey: '123e4567-e89b-12d3-a456-426614174000', fid: 'test_installation_12345678901234567890', platform: 'web' };
function worker(t, f, send) {
  const value = startNotificationWorkers(f.application.repo, { intervalMs: 3600000, send, logger: { error() {} } });
  t.after(() => value.stop()); return value;
}
test('Mongo mock notifications: in-app campaigns, preferences, duplicate suppression and scheduled cancellation', async t => {
  const f = await fixture(t), w = worker(t, f, async () => { throw new Error('In-app campaign must not send'); });
  await f.call('/api/notifications/preferences', { method: 'PATCH', body: { announcements: false } });
  const body = { title: 'News', message: 'Synthetic notification', channel: 'in_app', category: 'announcements', target: { type: 'customer', id: 'u1' } };
  const first = await f.call('/api/admin/notifications', { as: 'admin', method: 'POST', body }); assert.equal(first.status, 202);
  assert.equal((await f.call('/api/admin/notifications', { as: 'admin', method: 'POST', body })).status, 409);
  await w.run(); assert.equal((await f.call('/api/notifications')).data.notifications.length, 0);
  await f.call('/api/notifications/preferences', { method: 'PATCH', body: { announcements: true } });
  const second = await f.call('/api/admin/notifications', { as: 'admin', method: 'POST', body: { ...body, title: 'Allowed news' } }); assert.equal(second.status, 202);
  f.retryNextTransaction(); await w.run();
  const notices = (await f.call('/api/notifications')).data; assert.equal(notices.notifications.length, 1); assert.equal(notices.unread, 1);
  const id = notices.notifications[0].id;
  assert.equal((await f.call(`/api/notifications/${id}/read`, { as: 'customer2', method: 'POST', body: {} })).status, 404);
  assert.equal((await f.call(`/api/notifications/${id}/read`, { method: 'POST', body: {} })).data.unread, 0);
  const schedule = await f.call('/api/admin/notifications', { as: 'admin', method: 'POST', body: { ...body, title: 'Scheduled', scheduledAt: new Date(Date.now() + 180000).toISOString() } }); assert.equal(schedule.status, 202);
  assert.equal((await f.call(`/api/admin/notifications/campaigns/${schedule.data.campaign.id}/cancel`, { as: 'admin', method: 'POST', body: {} })).status, 200);
  const duplicate = await f.call(`/api/admin/notifications/campaigns/${second.data.campaign.id}/duplicate`, { as: 'admin', method: 'POST', body: {} }); assert.equal(duplicate.data.campaign.status, 'draft');
});

test('Mongo mock notifications: retry sends only failed devices and never resends an accepted device', async t => {
  const f = await fixture(t), sends = [];
  assert.equal((await f.call('/api/notifications/devices', { method: 'POST', body: registration })).status, 200);
  await f.call('/api/notifications/devices', { method: 'POST', body: { ...registration, deviceKey: '123e4567-e89b-12d3-a456-426614174001', fid: 'second_installation_123456789012345678' } });
  assert.equal(JSON.stringify((await f.call('/api/admin/bootstrap', { as: 'admin' })).data).includes(registration.fid), false);
  let failSecond = true;
  const w = worker(t, f, async fid => { sends.push(fid); if (fid.startsWith('second') && failSecond) throw Object.assign(new Error('Synthetic provider failure'), { code: 'messaging/server-unavailable' }); return 'accepted-message'; });
  await f.order(); await w.run();
  assert.equal(sends.length, 2); assert.equal(f.docs.notificationOutbox[0].status, 'queued');
  failSecond = false; f.docs.notificationOutbox[0].nextAttemptAt = new Date(0).toISOString(); await w.run();
  assert.equal(sends.filter(fid => fid === registration.fid).length, 1); assert.equal(sends.length, 3); assert.equal(f.docs.notificationOutbox[0].status, 'accepted');
  assert.equal(f.docs.notificationDeliveryLogs.filter(row => row.status === 'accepted').length, 2);
});

test('Mongo mock notifications: invalid installations are disabled and failures are not reported as accepted', async t => {
  const f = await fixture(t);
  await f.call('/api/notifications/devices', { method: 'POST', body: registration });
  const w = worker(t, f, async () => { throw Object.assign(new Error('Synthetic invalid device'), { code: 'messaging/installation-id-not-registered' }); });
  await f.order(); await w.run();
  assert.equal(f.docs.notificationDevices[0].status, 'invalid'); assert.equal(f.docs.notificationDeliveryLogs[0].status, 'invalid_device'); assert.equal(f.docs.notificationOutbox[0].status, 'failed');
});

test('Mongo mock notifications: stop waits for the active provider call despite overlapping worker ticks', async t => {
  const f = await fixture(t); await f.call('/api/notifications/devices', { method: 'POST', body: registration }); await f.order();
  let release, entered; const sending = new Promise(resolve => { entered = resolve; });
  const w = worker(t, f, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const first = w.run(); await sending; assert.strictEqual(w.run(), first);
  let stopped = false; const stop = w.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release('accepted'); await first; await stop; assert.equal(stopped, true);
  assert.equal(f.docs.notificationDeliveryLogs.length, 1);
});

test('Mongo mock notifications: rejected transaction does not leave events or queue a provider send', async t => {
  const f = await fixture(t); let sends = 0; const w = worker(t, f, async () => { sends++; return 'unexpected'; });
  f.failNext('notificationOutbox', 'insertOne');
  await assert.rejects(f.application.repo.transaction(() => createNotice(f.application.repo, 'customer', 'u1', { eventId: 'rollback-event', title: 'Rolled back', message: 'Must not persist' })));
  await w.run(); assert.equal(sends, 0); assert.equal(f.docs.notificationEvents?.length || 0, 0); assert.equal(f.docs.notifications?.length || 0, 0);
});

test('Mongo mock notifications: claimed campaign cannot be cancelled and device reassignment preserves ownership', async t => {
  const f = await fixture(t);
  await f.call('/api/notifications/devices', { method: 'POST', body: registration });
  await f.call('/api/notifications/devices', { as: 'customer2', method: 'POST', body: registration });
  assert.equal(f.docs.notificationDevices.length, 1); assert.equal(f.docs.notificationDevices[0].ownerId, 'u2');
  let sends = 0; const w = worker(t, f, async () => { sends++; return 'accepted'; });
  const response = await f.call('/api/admin/notifications', { as: 'admin', method: 'POST', body: { title: 'Private account news', message: 'Test', channel: 'both', target: { type: 'customer', id: 'u1' } } });
  await w.run(); assert.equal(sends, 0);
  assert.equal((await f.call(`/api/admin/notifications/campaigns/${response.data.campaign.id}/cancel`, { as: 'admin', method: 'POST', body: {} })).status, 409);
});
