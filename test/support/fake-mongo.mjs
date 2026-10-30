// Test-only MongoDB contract double. It is never imported by runtime code and
// cannot prove MongoDB isolation, wire protocol, indexes, or transaction retries.
import { isDeepStrictEqual } from 'node:util';
const clone = value => structuredClone(value);
function values(row, path) {
  const parts = path.split('.');
  function visit(value, at) {
    if (at === parts.length) return [value];
    if (Array.isArray(value) && !/^\d+$/.test(parts[at])) return value.flatMap(child => visit(child, at));
    return visit(value?.[parts[at]], at + 1);
  }
  return visit(row, 0);
}
const get = (row, path) => values(row, path)[0];
function put(row, path, value, remove = false) { const parts = path.split('.'); let target = row; for (const key of parts.slice(0, -1)) target = target[key] ||= {}; if (remove) delete target[parts.at(-1)]; else target[parts.at(-1)] = clone(value); }
function expression(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return get(row, value.slice(1));
  if (Array.isArray(value)) return value.map(item => expression(item, row));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const [operator, operand] = Object.entries(value)[0] || [];
  const args = Array.isArray(operand) ? operand.map(item => expression(item, row)) : expression(operand, row);
  if (operator === '$ifNull') return args[0] ?? args[1];
  if (operator === '$cond') return args[0] ? args[1] : args[2];
  if (operator === '$eq') return isDeepStrictEqual(args[0], args[1]);
  if (operator === '$ne') return !isDeepStrictEqual(args[0], args[1]);
  if (operator === '$lt') return args[0] < args[1];
  if (operator === '$lte') return args[0] <= args[1];
  if (operator === '$gt') return args[0] > args[1];
  if (operator === '$gte') return args[0] >= args[1];
  if (operator === '$and') return args.every(Boolean);
  if (operator === '$or') return args.some(Boolean);
  if (operator === '$substrBytes') return String(args[0]).slice(args[1], args[1] + args[2]);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expression(item, row)]));
}
function condition(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual || ''));
  if (expected === null) return actual == null;
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if (!Object.keys(expected).some(key => key.startsWith('$'))) return isDeepStrictEqual(actual, expected);
    return Object.entries(expected).every(([op, value]) => {
      if (op === '$exists') return (actual !== undefined) === value;
      if (op === '$ne') return !condition(actual, value);
      if (op === '$in') return value.some(item => Array.isArray(actual) ? actual.some(a => condition(a, item)) : condition(actual, item));
      if (op === '$nin') return !condition(actual, { $in: value });
      if (op === '$gt') return actual > value;
      if (op === '$gte') return actual >= value;
      if (op === '$lt') return actual < value;
      if (op === '$lte') return actual <= value;
      if (op === '$elemMatch') return Array.isArray(actual) && actual.some(item => matches(item, value));
      if (op === '$type') return value === 'string' ? typeof actual === 'string' : value === 'date' ? actual instanceof Date : typeof actual === value;
      if (op === '$not') return !condition(actual, value);
      throw new Error(`Unimplemented fake query operator ${op}`);
    });
  }
  return Array.isArray(actual) ? actual.some(item => condition(item, expected)) : isDeepStrictEqual(actual, expected);
}
export function matches(row, filter) {
  return Object.entries(filter || {}).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(row, part));
    if (key === '$and') return value.every(part => matches(row, part));
    if (key === '$expr') return expression(value, row);
    const candidates = values(row, key);
    return value && typeof value === 'object' && ('$ne' in value || '$nin' in value) ? candidates.every(actual => condition(actual, value)) : candidates.some(actual => condition(actual, value));
  });
}
function project(row, projection) {
  if (!projection) return clone(row);
  const included = Object.entries(projection).filter(([, value]) => value === 1);
  if (included.length) { const result = {}; for (const [key] of included) if (get(row, key) !== undefined) put(result, key, get(row, key)); return result; }
  const result = clone(row); for (const [key, value] of Object.entries(projection)) if (!value) put(result, key, null, true); return result;
}
const sorted = (rows, sort) => rows.sort((a,b) => { for (const [key, direction] of Object.entries(sort || {})) { const x = get(a,key), y = get(b,key); if (x < y) return -direction; if (x > y) return direction; } return 0; });
export function fakeMongo(seed = {}) {
  const docs = clone(seed), operations = [], failures = [];
  let tail = Promise.resolve(), sessionNumber = 0, replayNext = false;
  const rows = name => docs[name] ||= [];
  const record = (name, operation, filter, options) => {
    operations.push({ name, operation, filter: clone(filter), session: options?.session?.id });
    const at = failures.findIndex(row => row.name === name && row.operation === operation);
    if (at >= 0) throw failures.splice(at, 1)[0].error;
  };
  const unique = (name, document, except) => {
    const keys = name === 'sessions' ? [['kind','idHash']] : ['carts','wishlists','shoppingPreferences'].includes(name) ? [['ownerId']] : name === 'addresses' ? [['customerId','id']] : name === 'settings' ? [['key']] : name === 'coupons' ? [['code']] : name === 'notificationPreferences' ? [['ownerType','ownerId']] : [['id']];
    if (name === 'users') keys.push(['phone'], ['email'], ['referralCode'], ['googleSub']);
    if (name === 'orders') keys.push(['userId','idempotencyKey']);
    if (name === 'referrals') keys.push(['referredUserId']);
    if (name === 'rewards') keys.push(['qualifyingOrderId']);
    for (const fields of keys) if (fields.every(key => document[key] != null) && rows(name).some(row => row !== except && fields.every(key => row[key] === document[key]))) throw Object.assign(new Error('Duplicate key'), { code: 11000, keyPattern: Object.fromEntries(fields.map(key => [key, 1])) });
  };
  function updateRow(row, update, options, inserting) {
    for (const [op, fields] of Object.entries(update)) for (const [path, value] of Object.entries(fields)) {
      if (op === '$setOnInsert' && !inserting) continue;
      const array = path.match(/^(.+)\.\$\[([^\]]+)\]\.(.+)$/);
      if (array) {
        const filter = Object.fromEntries(Object.entries(options.arrayFilters.find(item => Object.keys(item).some(key => key.startsWith(array[2] + '.'))) || {}).map(([key, value]) => [key.slice(array[2].length + 1), value]));
        for (const child of get(row, array[1]) || []) if (matches(child, filter)) updateRow(child, { [op]: { [array[3]]: value } }, {}, false);
      } else if (op === '$set' || op === '$setOnInsert') put(row, path, value);
      else if (op === '$unset') put(row, path, null, true);
      else if (op === '$inc') put(row, path, Number(get(row,path) || 0) + value);
      else if (op === '$push') { const current = get(row,path) || []; current.push(...clone(value?.$each || [value])); put(row,path,current); }
      else if (op === '$addToSet') { const current = get(row,path) || []; for (const item of value?.$each || [value]) if (!current.some(row => isDeepStrictEqual(row,item))) current.push(clone(item)); put(row,path,current); }
      else if (op === '$pull') put(row,path,(get(row,path)||[]).filter(item => !condition(item,value)));
      else throw new Error(`Unimplemented fake update ${op}`);
    }
  }
  function aggregate(input, pipeline) {
    let result = clone(input);
    for (const stage of pipeline) {
      if (stage.$match) result = result.filter(row => matches(row, stage.$match));
      else if (stage.$sort) result = sorted(result, stage.$sort);
      else if (stage.$skip !== undefined) result = result.slice(stage.$skip);
      else if (stage.$limit !== undefined) result = result.slice(0, stage.$limit);
      else if (stage.$project) result = result.map(row => project(row, stage.$project));
      else if (stage.$set) result = result.map(row => ({ ...row, ...Object.fromEntries(Object.entries(stage.$set).map(([key,value]) => [key, expression(value,row)])) }));
      else if (stage.$lookup) {
        const lookup = stage.$lookup;
        result = result.map(row => ({ ...row, [lookup.as]: aggregate(rows(lookup.from).filter(foreign => get(foreign,lookup.foreignField) === get(row,lookup.localField)), lookup.pipeline || []) }));
      } else if (stage.$group) {
        const groups = new Map();
        for (const row of result) {
          const id = expression(stage.$group._id, row), key = JSON.stringify(id); const group = groups.get(key) || { _id: id };
          for (const [field, accumulator] of Object.entries(stage.$group)) if (field !== '_id') { if ('$sum' in accumulator) group[field] = Number(group[field] || 0) + Number(expression(accumulator.$sum, row) || 0); else throw new Error('Unsupported accumulator'); }
          groups.set(key, group);
        }
        result = [...groups.values()];
      } else throw new Error(`Unimplemented fake aggregation ${Object.keys(stage)}`);
    }
    return result;
  }
  const db = { async command() { return { ok: 1, setName: 'mock-only' }; }, collection(name) { return {
    async findOne(filter, options) { record(name,'findOne',filter,options); return project(rows(name).find(row => matches(row,filter)) || null, null) && project(rows(name).find(row => matches(row,filter)), options?.projection); },
    find(filter = {}, options = {}) {
      record(name,'find',filter,options); let sort = {}, skip = 0, limit = Infinity;
      const cursor = { sort(value) { sort = value; return cursor; }, skip(value) { skip = value; return cursor; }, limit(value) { limit = value; return cursor; }, async toArray() { return sorted(rows(name).filter(row => matches(row,filter)),sort).slice(skip,skip+limit).map(row => project(row,options.projection)); } }; return cursor;
    },
    aggregate(pipeline, options) { record(name,'aggregate',pipeline,options); return { toArray: async () => aggregate(rows(name),pipeline) }; },
    async countDocuments(filter = {}, options) { record(name,'countDocuments',filter,options); return rows(name).filter(row => matches(row,filter)).length; },
    async insertOne(document, options) { record(name,'insertOne',document,options); unique(name,document); rows(name).push(clone(document)); return { insertedId: document.id, acknowledged: true }; },
    async insertMany(documents, options) { for (const row of documents) await this.insertOne(row,options); return { insertedCount: documents.length }; },
    async updateOne(filter, update, options = {}) {
      record(name,'updateOne',filter,options); let row = rows(name).find(row => matches(row,filter)), inserting = !row;
      if (!row && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      if (!row) row = Object.fromEntries(Object.entries(filter).filter(([key,value]) => !key.startsWith('$') && (typeof value !== 'object' || value === null)));
      const next = clone(row); updateRow(next,update,options,inserting); unique(name,next,row);
      if (inserting) rows(name).push(next); else { for (const key of Object.keys(row)) delete row[key]; Object.assign(row,next); }
      return { matchedCount: inserting ? 0 : 1, modifiedCount: inserting ? 0 : 1, upsertedCount: inserting ? 1 : 0 };
    },
    async updateMany(filter, update, options = {}) { record(name,'updateMany',filter,options); let modifiedCount = 0; for (const row of rows(name)) if (matches(row,filter)) { updateRow(row,update,options,false); modifiedCount++; } return { modifiedCount }; },
    async deleteOne(filter, options) { record(name,'deleteOne',filter,options); const at = rows(name).findIndex(row => matches(row,filter)); if (at < 0) return { deletedCount: 0 }; rows(name).splice(at,1); return { deletedCount: 1 }; },
    async deleteMany(filter, options) { record(name,'deleteMany',filter,options); const previous = rows(name).length; docs[name] = rows(name).filter(row => !matches(row,filter)); return { deletedCount: previous - docs[name].length }; },
    async findOneAndUpdate(filter, update, options = {}) { const row = sorted(rows(name).filter(row => matches(row,filter)),options.sort)[0]; if (!row) return null; await this.updateOne({ id: row.id },update,options); return project(row,options.projection); },
    async createIndex() {},
  }; } };
  const client = { startSession() { const session = { id: ++sessionNumber, ended: false, async withTransaction(fn) {
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
    const saved = clone(docs);
    const replay = replayNext; replayNext = false;
    try {
      if (replay) { await fn(); for (const key of Object.keys(docs)) delete docs[key]; Object.assign(docs,clone(saved)); }
      return await fn();
    } catch(error) { for (const key of Object.keys(docs)) delete docs[key]; Object.assign(docs,saved); throw error; } finally { release(); }
  }, async endSession() { session.ended = true; } }; return session; } };
  return { db, client, docs, operations, retryNextTransaction() { replayNext = true; }, failNext(name, operation, error = new Error('Injected write failure')) { failures.push({ name, operation, error }); } };
}
