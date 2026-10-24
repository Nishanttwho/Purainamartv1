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
