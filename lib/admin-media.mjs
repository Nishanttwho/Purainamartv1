import crypto from 'node:crypto';
import { fail } from './mongo-repository.mjs';
import { cloudinaryConfig, signCloudinaryParams, cloudinaryResource, destroyCloudinaryResource, isCloudinaryImageUrl, MAX_IMAGE_BYTES, IMAGE_FORMATS } from './cloudinary.mjs';

// Upload leases retain ownership even if the browser closes before saving.
// Cleanup is asynchronous; remote deletion never runs in a retried transaction.
export async function handleAdminMedia(repo, ctx) {
  const { route, method, body, admin } = ctx;
  if (route === '/api/admin/cloudinary/signature' && method === 'GET') fail(405, 'Use the authorized image upload form.');
  if (route === '/api/admin/media/uploads' && method === 'POST') {
    const config = cloudinaryConfig(); if (!config) fail(503, 'Image uploads are unavailable. Configure Cloudinary on the server to enable uploads.');
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(body.type) || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_IMAGE_BYTES) fail(400, 'Choose a JPEG, PNG, WebP or AVIF image up to 10 MB.');
    if (await repo.count('mediaAssets', { ownerId: admin.id, status: { $in: ['pending', 'ready'] } }) >= 60) fail(429, 'Save or remove the images already uploaded before adding more.');
    const id = crypto.randomUUID(), public_id = `purainamart/managed/${id}`;
    const params = { public_id, timestamp: Math.floor(Date.now() / 1000), overwrite: false, allowed_formats: IMAGE_FORMATS.join(',') };
    await repo.insert('mediaAssets', { id, ownerId: admin.id, public_id, cloudName: config.cloudName, status: 'pending', createdAt: new Date().toISOString(), cleanupAfter: new Date(Date.now() + 86400000).toISOString() });
    return { uploadId: id, cloudName: config.cloudName, apiKey: config.apiKey, params, signature: signCloudinaryParams(config, params) };
  }
  const match = route.match(/^\/api\/admin\/media\/uploads\/([a-f0-9-]+)(?:\/(complete))?$/);
  if (!match) return undefined;
  const asset = await repo.one('mediaAssets', { id: match[1], ownerId: admin.id });
  if (!asset) fail(404, 'Upload not found.');
  if (method === 'DELETE' && !match[2]) {
    if (!['pending', 'ready'].includes(asset.status)) fail(409, 'This image is already saved. Remove it from its record first.');
    // Keep the original lease deadline: signed credentials can be used for an hour.
    asset.status = 'abandoned'; return { ok: true };
  }
  if (method !== 'POST' || !match[2]) fail(405, 'Method not allowed');
  if (asset.status === 'ready') return { image: asset.secure_url, imageAsset: { public_id: asset.public_id, secure_url: asset.secure_url } };
  if (asset.status !== 'pending') fail(409, 'This upload is no longer available. Choose the image again.');
  const config = cloudinaryConfig(); if (!config || config.cloudName !== asset.cloudName) fail(503, 'Image uploads are unavailable.');
  const verified = await cloudinaryResource(config, asset.public_id);
  if (verified.public_id !== asset.public_id || verified.resource_type !== 'image' || verified.type !== 'upload' || !IMAGE_FORMATS.includes(verified.format) || !Number.isSafeInteger(verified.bytes) || verified.bytes < 1 || verified.bytes > MAX_IMAGE_BYTES || !isCloudinaryImageUrl(verified.secure_url, config.cloudName)) fail(400, 'The uploaded file is not a supported image up to 10 MB. Remove it and choose another image.');
  asset.secure_url = verified.secure_url; asset.bytes = verified.bytes; asset.status = 'ready';
  return { image: asset.secure_url, imageAsset: { public_id: asset.public_id, secure_url: asset.secure_url } };
}

export async function attachMedia(repo, adminId, image, previousImage, previousAsset) {
  if (image === previousImage) return previousAsset || null;
  if (!image || String(image).startsWith('/assets/')) return null;
  const asset = await repo.one('mediaAssets', { secure_url: image, ownerId: adminId, status: { $in: ['ready', 'attached'] } });
  if (!asset) fail(400, 'Choose and upload the image from your device before saving.');
  const claimed = await repo.update('mediaAssets', { id: asset.id, status: { $in: ['ready', 'attached'] } }, { $set: { status: 'attached', cleanupAfter: null }, $inc: { referenceRevision: 1 } });
  if (claimed.matchedCount !== 1) fail(409, 'This upload expired. Choose the image again.');
  asset.status = 'attached'; asset.cleanupAfter = null;
  return { secure_url: asset.secure_url, public_id: asset.public_id };
}

export async function scheduleMediaCleanup(repo, previousAsset, replacementAsset) {
  if (!previousAsset?.public_id || previousAsset.public_id === replacementAsset?.public_id) return;
  await repo.update('mediaAssets', { public_id: previousAsset.public_id, status: 'attached' }, { $set: { cleanupAfter: new Date(Date.now() + 86400000).toISOString() } });
}
async function referenced(repo, asset) {
  const image = asset.secure_url;
  if (!image) return false;
  // Protect shared images, deactivated records, and historical order snapshots.
  for (const name of ['products', 'categories']) if (await repo.exists(name, { $or: [{ image }, { images: image }, { 'imageAsset.public_id': asset.public_id }] })) return true;
  if (await repo.exists('orders', { $or: [{ 'items.image': image }, { 'items.images': image }] })) return true;
  return await repo.exists('settings', { $or: [{ key: 'homepageHeroFruitImage', value: image }, { key: 'homepageBanners', 'value.image': image }] });
}
export async function cleanupMedia(repo, { destroy = destroyCloudinaryResource, config = cloudinaryConfig() } = {}) {
  if (!config) return;
  const due = await repo.list('mediaAssets', { cloudName: config.cloudName, cleanupAfter: { $ne: null, $lte: new Date().toISOString() }, status: { $in: ['pending', 'ready', 'abandoned', 'attached', 'deleting'] } }, { limit: 10, sort: { cleanupAfter: 1 } });
  for (const row of due) {
    const claimed = await repo.transaction(async () => {
      const asset = await repo.one('mediaAssets', { id: row.id });
      if (!asset || asset.status === 'deleted' || !asset.cleanupAfter || asset.cleanupAfter > new Date().toISOString()) return false;
      if (await referenced(repo, asset)) { asset.status = 'attached'; asset.cleanupAfter = null; return false; }
      asset.status = 'deleting'; asset.cleanupAfter = new Date(Date.now() + 300000).toISOString(); return true;
    });
    if (!claimed) continue;
    try {
      await destroy(config, row.public_id);
      await repo.update('mediaAssets', { id: row.id, status: 'deleting' }, { $set: { status: 'deleted', deletedAt: new Date().toISOString(), cleanupAfter: null } });
    } catch { /* Retained for retry after the five-minute claim expires. */ }
  }
}
export function startMediaCleanup(repo) {
  let pending, stopping = false;
  const timer = setInterval(() => { if (!stopping && !pending) pending = cleanupMedia(repo).catch(() => {}).finally(() => { pending = null; }); }, 60000);
  timer.unref?.();
  return { stop: async () => { stopping = true; clearInterval(timer); await pending; } };
}
