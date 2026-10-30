import { newId, nowIso, referralDefaults } from './commerce.mjs';
import { createNotice } from './mongo-notifications.mjs';
import crypto from 'node:crypto';

export function canonicalPublicBaseUrl(value, production = false) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && (production || !['localhost', '127.0.0.1'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
export async function attributeReferral(repo, user, code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return { status: 'none' };
  const rejected = async status => {
    await repo.insert('referralEvents', { id: newId(), code: code.slice(0, 20), userId: user.id, status, at: nowIso() });
    return { status };
  };
  const campaign = await repo.setting('referralCampaign', referralDefaults());
  if (!campaign.enabled) return rejected('campaign_unavailable');
  const referrer = await repo.one('users', { referralCode: code, blockedAt: null });
  if (!referrer) return rejected('invalid_code');
  if (referrer.id === user.id) return rejected('self_referral_blocked');
  if (user.referredBy) return rejected('already_attributed');
  const at = nowIso();
  user.referredBy = referrer.id; user.referredAt = at;
  await repo.insert('referrals', { id: newId(), referrerUserId: referrer.id, referredUserId: user.id, referralCode: code, attributedAt: at, status: 'pending', qualifyingOrderId: null, rewardId: null });
  return { status: 'linked' };
}
export async function issueReferralReward(repo, order) {
  const campaign = await repo.setting('referralCampaign', referralDefaults());
  if (!campaign.enabled || order.status !== campaign.qualifyingStatus) return;
  const referral = await repo.one('referrals', { referredUserId: order.userId, status: 'pending' });
  if (!referral) return;
  const earlier = campaign.firstOrderOnly && await repo.exists('orders', { userId: order.userId, id: { $ne: order.id }, createdAt: { $lt: order.createdAt }, status: campaign.qualifyingStatus });
  if (earlier || campaign.firstOrderOnly && Number(order.subtotal) < Number(campaign.minimumOrder)) { referral.status = 'not_qualified'; referral.qualifyingOrderId = order.id; referral.qualifiedAt = nowIso(); return; }
  if (Number(order.subtotal) < Number(campaign.minimumOrder)) return;
  // Serialize reward issuance for the referrer, including simultaneous deliveries
  // by different friends, before checking the campaign's per-customer ceiling.
  await repo.update('users', { id: referral.referrerUserId }, { $inc: { rewardRevision: 1 } });
  if (await repo.count('rewards', { userId: referral.referrerUserId, status: { $ne: 'cancelled' } }) >= Number(campaign.maxRewardsPerCustomer || 20)) { referral.status = 'reward_limit_reached'; referral.qualifyingOrderId = order.id; return; }
  const issuedAt = nowIso(), expiresAt = new Date(Date.now() + Number(campaign.expiryDays || 30) * 86400000).toISOString();
  const reward = { id: newId(), userId: referral.referrerUserId, referralId: referral.id, qualifyingOrderId: order.id, type: campaign.rewardType, amount: Number(campaign.rewardAmount || 0), productId: campaign.rewardType === 'free_product' ? campaign.freeProductId : null, status: 'available', issuedAt, expiresAt, redemptionLimit: Number(campaign.redemptionLimit || 1), redemptionCount: 0, redemptionHistory: [], orderId: null };
  if (reward.type === 'coupon') {
    reward.couponCode = `REF${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await repo.insert('coupons', { code: reward.couponCode, label: 'Referral reward', minimum: 0, discountType: 'fixed', discount: reward.amount, isActive: true, expiresAt, userId: reward.userId, rewardId: reward.id, maxRedemptions: reward.redemptionLimit, maxRedemptionsPerCustomer: reward.redemptionLimit, redemptionCount: 0 });
  }
  await repo.insert('rewards', reward);
  Object.assign(referral, { status: 'qualified', qualifyingOrderId: order.id, qualifiedAt: issuedAt, rewardId: reward.id });
  await createNotice(repo, 'customer', reward.userId, { eventType: 'referral_reward', eventId: `reward:${reward.id}:earned`, title: 'Referral reward unlocked', message: reward.type === 'coupon' ? `Your reward coupon ${reward.couponCode} is ready.` : 'A free product reward is ready in My Rewards.', destination: '/referral' });
}
export async function referralDashboard(repo, user, pagination = {}) {
  const campaign = await repo.setting('referralCampaign', referralDefaults());
  const referrals = await repo.list('referrals', { referrerUserId: user.id }, pagination);
  const rows = [];
  for (const row of referrals) {
    const friend = await repo.one('users', { id: row.referredUserId });
    const order = row.qualifyingOrderId ? await repo.one('orders', { id: row.qualifyingOrderId }) : null;
    const reward = row.rewardId ? await repo.one('rewards', { id: row.rewardId }) : null;
    rows.push({ id: row.id, name: friend?.name || 'PurainaMart member', phone: friend?.phone ? '••••' + friend.phone.slice(-4) : '', status: row.status, attributedAt: row.attributedAt, qualifyingOrder: order ? { id: order.id, displayId: order.displayId, subtotal: order.subtotal, status: order.status } : null, rewardStatus: reward?.status || null });
  }
  const rewards = [];
  for (const row of await repo.list('rewards', { userId: user.id }, pagination)) {
    const product = row.productId ? await repo.one('products', { id: row.productId }) : null;
    rewards.push({ ...row, status: row.status === 'available' && row.expiresAt && Date.parse(row.expiresAt) <= Date.now() ? 'expired' : row.status, product });
  }
  return { campaign: { enabled: Boolean(campaign.enabled), minimumOrder: Number(campaign.minimumOrder), rewardType: campaign.rewardType }, referralCode: user.referralCode, referralUrlBase: canonicalPublicBaseUrl(campaign.publicBaseUrl) || '', referrals: rows, rewards };
}
export async function referralAdminData(repo, pagination = {}) {
  const referrals = [], rewards = [];
  for (const row of await repo.list('referrals', {}, pagination)) {
    const referrer = await repo.one('users', { id: row.referrerUserId }), referred = await repo.one('users', { id: row.referredUserId });
    const order = row.qualifyingOrderId ? await repo.one('orders', { id: row.qualifyingOrderId }) : null;
    const reward = row.rewardId ? await repo.one('rewards', { id: row.rewardId }) : null;
    referrals.push({ ...row, referrer: referrer?.phone || 'Unknown', referred: referred?.phone ? '••••' + referred.phone.slice(-4) : '', qualifyingOrder: order?.displayId || null, reward: reward?.status || null });
  }
  for (const row of await repo.list('rewards', {}, pagination)) {
    const customer = await repo.one('users', { id: row.userId }), relation = await repo.one('referrals', { id: row.referralId });
    const friend = relation ? await repo.one('users', { id: relation.referredUserId }) : null;
    rewards.push({ ...row, customer: customer?.phone || 'Unknown', friend: friend?.phone || 'Unknown', order: row.qualifyingOrderId ? (await repo.one('orders', { id: row.qualifyingOrderId }))?.displayId : null, product: row.productId ? (await repo.one('products', { id: row.productId }))?.name : null });
  }
  return { campaign: await repo.setting('referralCampaign', referralDefaults()), referrals, rewards, events: await repo.list('referralEvents', {}, { limit: 100, sort: { at: -1 } }) };
}
