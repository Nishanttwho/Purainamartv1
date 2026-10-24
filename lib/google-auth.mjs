import crypto from 'node:crypto';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function decodePart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export function createGoogleIdTokenVerifier({ fetchImpl = fetch, now = () => Date.now(), jwksUrl = GOOGLE_JWKS_URL } = {}) {
  let cachedKeys = null;
  let cacheExpiresAt = 0;

  async function getKeys(forceRefresh = false) {
    if (!forceRefresh && cachedKeys && now() < cacheExpiresAt) return cachedKeys;
    const response = await fetchImpl(jwksUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Google signing keys are temporarily unavailable');
    const body = await response.json();
    if (!Array.isArray(body.keys)) throw new Error('Google signing keys response was invalid');
    const maxAge = Number(response.headers?.get?.('cache-control')?.match(/max-age=(\d+)/i)?.[1] || 300);
    cachedKeys = body.keys;
    cacheExpiresAt = now() + Math.min(Math.max(maxAge, 60), 86400) * 1000;
    return cachedKeys;
  }

  return async function verifyGoogleIdToken(token, audience) {
    if (typeof token !== 'string' || token.length > 16384 || !audience) throw new Error('Google ID token is missing');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Google ID token is malformed');
    let header, claims;
    try { header = decodePart(parts[0]); claims = decodePart(parts[1]); } catch { throw new Error('Google ID token is malformed'); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Google ID token signing algorithm is unsupported');
    let key = (await getKeys()).find(candidate => candidate.kid === header.kid && candidate.kty === 'RSA' && candidate.use === 'sig');
    if (!key) key = (await getKeys(true)).find(candidate => candidate.kid === header.kid && candidate.kty === 'RSA' && candidate.use === 'sig');
    if (!key) throw new Error('Google ID token signing key was not found');
    let signatureValid = false;
    try {
      signatureValid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch { throw new Error('Google ID token signature could not be checked'); }
    if (!signatureValid) throw new Error('Google ID token signature is invalid');

    const nowSeconds = Math.floor(now() / 1000);
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error('Google ID token issuer is invalid');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience) || (claims.azp !== undefined && claims.azp !== audience) || (audiences.length > 1 && claims.azp !== audience)) throw new Error('Google ID token audience is invalid');
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) throw new Error('Google ID token has expired');
    if (Number.isFinite(claims.iat) && claims.iat > nowSeconds + 300) throw new Error('Google ID token issue time is invalid');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('Google account subject is invalid');
    if (claims.email_verified !== true || typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) throw new Error('A verified Google email address is required');
    return claims;
  };
}

export const verifyGoogleIdToken = createGoogleIdTokenVerifier();

export function resolveGoogleCustomer(users, claims, { createId = () => crypto.randomUUID(), createReferralCode, createdAt = () => new Date().toISOString() } = {}) {
  if (claims?.email_verified !== true || !claims.sub || !claims.email) throw new Error('Only verified Google identities can create a customer session');
  const email = claims.email.trim().toLowerCase();
  let user = users.find(row => row.googleSub === claims.sub);
  let isNewUser = !user;
  if (!user) {
    user = users.find(row => row.email?.toLowerCase() === email && row.emailVerified === true);
    if (user?.googleSub && user.googleSub !== claims.sub) {
      const error = new Error('This email is already linked to another Google account'); error.code = 'GOOGLE_ACCOUNT_CONFLICT'; throw error;
    }
    if (user) isNewUser = false;
  }
  const otherEmailOwner = users.find(row => row.id !== user?.id && row.email?.toLowerCase() === email && row.emailVerified === true);
  if (otherEmailOwner) {
    const error = new Error('This verified email already belongs to another customer account'); error.code = 'GOOGLE_ACCOUNT_CONFLICT'; throw error;
  }
  if (!user) {
    const fallbackName = email.split('@')[0] || 'Zepto member';
    user = { id: createId(), googleSub: claims.sub, email, emailVerified: true, phone: null, name: String(claims.name || '').trim().slice(0, 80) || fallbackName, referralCode: createReferralCode?.(), createdAt: createdAt() };
    users.push(user);
  } else {
    user.googleSub = claims.sub;
    user.email = email;
    user.emailVerified = true;
    if (!user.name || user.name === 'Zepto member') user.name = String(claims.name || '').trim().slice(0, 80) || user.name;
  }
  return { user, isNewUser };
}
