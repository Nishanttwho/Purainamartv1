import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

export const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
export const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
export const pageOptions = (url, fallback = 100) => ({
  limit: Math.floor(Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || fallback))),
  skip: Math.floor(Math.max(0, Math.min(1000000, Number(url.searchParams.get('offset')) || 0)))
});

// Request-local document unit of work. Only explicitly queried documents are
// tracked; there is no shared store, collection cache, or database-wide read.
// Updates contain changed top-level fields, never a database replacement.
export class MongoRepository {
  context = new AsyncLocalStorage();
  constructor(db, client) { this.db = db; this.client = client; }
  options(extra = {}) { return { ...extra, ...(this.context.getStore()?.session ? { session: this.context.getStore().session } : {}) }; }
  collection(name) { return this.db.collection(name); }
  track(name, row) {
    if (!row) return null;
    const { _id, ...document } = row;
    const context = this.context.getStore();
    if (!context) return document;
    const key = JSON.stringify([name, document.id ?? document.code ?? document.key ?? document.ownerId, document.customerId]);
    if (context.documents.has(key)) return context.documents.get(key).document;
    const filter = name === 'addresses' ? { customerId: document.customerId, id: document.id }
      : ['carts', 'wishlists', 'shoppingPreferences'].includes(name) ? { ownerId: document.ownerId }
      : name === 'coupons' ? { code: document.code } : name === 'settings' ? { key: document.key }
      : { id: document.id };
    context.documents.set(key, { name, filter, document, original: structuredClone(document) });
    return document;
  }
  async one(name, filter, extra = {}) {
    const cache = this.context.getStore()?.readCache;
    const key = cache ? JSON.stringify([name, filter, extra], (_, value) => value instanceof RegExp ? { pattern: value.source, flags: value.flags } : value) : null;
    if (cache?.has(key)) return cache.get(key);
    const value = this.track(name, await this.collection(name).findOne(filter, this.options({ projection: { _id: 0 }, ...extra })));
    cache?.set(key, value);
    return value;
  }
  async list(name, filter = {}, { sort = { createdAt: -1, id: 1 }, limit = 100, skip = 0, projection } = {}) {
    const rows = await this.collection(name).find(filter, this.options({ projection: projection || { _id: 0 } }))
      .sort(sort).skip(skip).limit(Math.min(2000, Math.max(1, limit))).toArray();
    return rows.map(row => this.track(name, row));
  }
  async all(name, filter = {}, options = {}) {
    const result = [], limit = 200;
    for (let skip = 0; ; skip += limit) {
      const page = await this.list(name, filter, { ...options, limit, skip });
      result.push(...page);
      if (page.length < limit) return result;
    }
  }
  count(name, filter = {}) { return this.collection(name).countDocuments(filter, this.options()); }
  async exists(name, filter) { return Boolean(await this.collection(name).findOne(filter, this.options({ projection: { _id: 1 } }))); }
  async insert(name, document) { await this.collection(name).insertOne({ ...document }, this.options()); return document; }
  update(name, filter, update, extra = {}) { return this.collection(name).updateOne(filter, update, this.options(extra)); }
  updateMany(name, filter, update) { return this.collection(name).updateMany(filter, update, this.options()); }
  remove(name, filter) { return this.collection(name).deleteMany(filter, this.options()); }
  async setting(key, fallback = null) { return (await this.one('settings', { key }))?.value ?? structuredClone(fallback); }
  setSetting(key, value) { return this.update('settings', { key }, { $set: { value } }, { upsert: true }); }
  forget(name) { const entries = this.context.getStore()?.documents; if (entries) for (const [key, row] of entries) if (row.name === name) entries.delete(key); }
  async flush() {
    for (const row of this.context.getStore()?.documents.values() || []) {
      const set = {}, unset = {};
      for (const key of new Set([...Object.keys(row.original), ...Object.keys(row.document)])) {
        if (isDeepStrictEqual(row.original[key], row.document[key])) continue;
        if (row.document[key] === undefined) unset[key] = ''; else set[key] = row.document[key];
      }
      if (Object.keys(set).length || Object.keys(unset).length) {
        await this.update(row.name, row.filter, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
        row.original = structuredClone(row.document);
      }
    }
  }
  async transaction(callback) {
    if (this.context.getStore()?.session) return callback();
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => this.context.run({ session, documents: new Map() }, async () => {
        const result = await callback();
        await this.flush();
        return result;
      }), transactionOptions);
    } finally { await session.endSession(); }
  }
}
