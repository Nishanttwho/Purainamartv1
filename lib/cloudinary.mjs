import crypto from 'node:crypto';

export function cloudinaryConfig(env = process.env) {
  const cloudUrl = String(env.CLOUDINARY_URL || '').trim();
  if (cloudUrl) {
    try {
      const parsed = new URL(cloudUrl);
      if (parsed.protocol !== 'cloudinary:' || !parsed.username || !parsed.password || !parsed.hostname) return null;
      return { cloudName: parsed.hostname, apiKey: decodeURIComponent(parsed.username), apiSecret: decodeURIComponent(parsed.password) };
    } catch { return null; }
  }
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = env;
  if (![cloudName, apiKey, apiSecret].every(value => typeof value === 'string' && value.trim())) return null;
  return { cloudName: cloudName.trim(), apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

export function signCloudinaryUpload(config, timestamp = Math.floor(Date.now() / 1000)) {
  if (!config || !/^[\w-]+$/.test(config.cloudName) || !/^\d+$/.test(String(timestamp))) throw new Error('Cloudinary upload is not configured.');
  const folder = 'purainamart';
  const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${config.apiSecret}`).digest('hex');
  return { cloudName: config.cloudName, apiKey: config.apiKey, timestamp: Number(timestamp), folder, signature };
}

export function isCloudinaryImageUrl(value, cloudName = null) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.username || url.password || url.port || url.search || url.hash) return false;
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length >= 4 && segments[1] === 'image' && segments[2] === 'upload' && (!cloudName || segments[0] === cloudName);
  } catch { return false; }
}

export function signCloudinaryParams(config, params) {
  return crypto.createHash('sha1').update(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join('&') + config.apiSecret).digest('hex');
}
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
export async function cloudinaryResource(config, publicId) {
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/resources/image/upload/${encodeURIComponent(publicId)}`, { headers: { authorization: `Basic ${Buffer.from(config.apiKey + ':' + config.apiSecret).toString('base64')}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error('The uploaded image could not be verified. Retry after the upload completes.'), { status: 502 });
  return response.json();
}
export async function destroyCloudinaryResource(config, publicId) {
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000), invalidate: true };
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/destroy`, { method: 'POST', body: new URLSearchParams({ ...params, api_key: config.apiKey, signature: signCloudinaryParams(config, params) }), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok || !['ok', 'not found'].includes(result.result)) throw new Error('Cloudinary cleanup failed.');
}
