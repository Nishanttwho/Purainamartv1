import { createHash } from 'node:crypto';

export function hashSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 32) throw new TypeError('Session identifier is invalid.');
  return createHash('sha256').update(sessionId).digest('hex');
}

export async function findCustomerByPhone(db, phone) {
  return db.collection('users').findOne({ phone }, { projection: { _id: 0 } });
}

export async function createCustomer(db, customer, { session } = {}) {
  const document = { ...customer, id: String(customer.id) };
  await db.collection('users').insertOne(document, { session });
  return document;
}

export async function createDurableSession(db, { sessionId, ownerId, kind = 'customer', authMethod, expiresAt, createdAt = new Date() }, { session } = {}) {
  if (!['customer', 'admin', 'rider'].includes(kind)) throw new TypeError('Session kind is invalid.');
  const expiration = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(expiration.getTime()) || expiration <= new Date()) throw new TypeError('Session expiry is invalid.');
  const document = { kind, idHash: hashSessionId(sessionId), ownerId: String(ownerId), authMethod, createdAt: new Date(createdAt), expiresAt: expiration };
  await db.collection('sessions').insertOne(document, { session });
  return document;
}

export async function resolveDurableSession(db, { sessionId, kind = 'customer', now = new Date(), allowAuthMethods }) {
  if (!sessionId) return null;
  const session = await db.collection('sessions').findOne({ kind, idHash: hashSessionId(sessionId), expiresAt: { $gt: now } }, { projection: { _id: 0 } });
  if (!session || allowAuthMethods && !allowAuthMethods.includes(session.authMethod)) return null;
  const collectionName = kind === 'customer' ? 'users' : kind === 'admin' ? 'admins' : 'riders';
  const owner = await db.collection(collectionName).findOne({ id: session.ownerId }, { projection: { _id: 0 } });
  if (!owner || kind === 'customer' && owner.blockedAt) return null;
  return { session, owner };
}

export async function deleteDurableSession(db, { sessionId, kind = 'customer' }, { session } = {}) {
  if (!sessionId) return { deletedCount: 0 };
  return db.collection('sessions').deleteOne({ kind, idHash: hashSessionId(sessionId) }, { session });
}
