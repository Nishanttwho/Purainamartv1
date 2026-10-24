import crypto from 'node:crypto';

const params = { parallelism: 1, memory: 65_536, passes: 3, tagLength: 32 };

function derive(message, salt) {
  return new Promise((resolve, reject) => {
    if (typeof crypto.argon2 !== 'function') return reject(new Error('Node.js 24.7 or later with built-in Argon2 support is required.'));
    crypto.argon2('argon2id', { ...params, message: Buffer.from(message), nonce: salt }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt);
  return `argon2id$${params.memory}$${params.passes}$${params.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  if (!isPasswordHash(encoded)) return false;
  const [algorithm, memory, passes, parallelism, saltText, hashText, extra] = encoded.split('$');
  if (algorithm !== 'argon2id' || extra !== undefined || Number(memory) !== params.memory || Number(passes) !== params.passes || Number(parallelism) !== params.parallelism || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length !== 16 || expected.length !== params.tagLength) return false;
    const actual = await derive(password, salt);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function isPasswordHash(encoded) {
  if (typeof encoded !== 'string') return false;
  const [algorithm, memory, passes, parallelism, saltText, hashText, extra] = encoded.split('$');
  if (algorithm !== 'argon2id' || extra !== undefined || Number(memory) !== params.memory || Number(passes) !== params.passes || Number(parallelism) !== params.parallelism || !saltText || !hashText) return false;
  return Buffer.from(saltText, 'base64url').length === 16 && Buffer.from(hashText, 'base64url').length === params.tagLength;
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128 && !/[\u0000-\u001f\u007f]/.test(password);
}
