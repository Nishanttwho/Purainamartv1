import test from 'node:test';
import assert from 'node:assert/strict';
import { rollbackGuard } from '../scripts/performance-safety.mjs';

test('live verification blocks commits, administration and writes outside an active guarded transaction', async () => {
  let writes=0,active=false;
  const session={inTransaction:()=>active,commitTransaction:async()=>{throw new Error('Native commit must never be reached');}};
  const client={startSession:()=>session};
  const native={collection:()=>({updateOne:async()=>{writes++;},aggregate:()=>[],createIndex:()=>{throw new Error('Native index creation must never be reached');}}),command:async()=>({ok:1})};
  const db=rollbackGuard(client,native),collection=db.collection('carts');
  assert.throws(()=>collection.updateOne({},{}),/Every write requires/);
  const guarded=client.startSession();
  await assert.rejects(guarded.commitTransaction(),/must never commit/);
  assert.throws(()=>collection.updateOne({},{},{session:guarded}),/Every write requires/);
  active=true;
  await collection.updateOne({},{},{session:guarded});assert.equal(writes,1);
  assert.throws(()=>collection.aggregate([{$merge:'orders'}]),/Write aggregation forbidden/);
  assert.throws(()=>collection.createIndex({id:1}),/Unsupported verification/);
  assert.throws(()=>db.command({dropDatabase:1}));
  assert.deepEqual(await db.command({ping:1}),{ok:1});
});
