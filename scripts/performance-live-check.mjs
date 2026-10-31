// Explicit live checks in ONE transaction that can never commit. No workers,
// notifications sent, environment edits, customer creation, or persistent data.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { mongoConnectionOptions } from '../lib/mongodb.mjs';
import { rollbackGuard, databaseSnapshot } from './performance-safety.mjs';
const label = process.argv.includes('--baseline') ? 'before' : 'after';
const moduleRoot = label === 'before' ? '../tmp/performance-baseline/lib/' : '../lib/';
const { MongoRepository, transactionOptions } = await import(moduleRoot+'mongo-repository.mjs');
const { resolveIdentity } = await import(moduleRoot+'api-auth.mjs');
const { hashSessionId } = await import(moduleRoot+'mongodb-auth.mjs');
const { handleCustomerApi, checkoutApi } = await import(moduleRoot+'api-customer.mjs');
const { handleAdminApi } = await import(moduleRoot+'api-admin.mjs');
const { handleRiderApi } = await import(moduleRoot+'api-rider.mjs');
const { resolveLine } = await import(moduleRoot+'commerce.mjs');
globalThis.fetch = async () => { throw new Error('External HTTP effects are forbidden in live verification'); };
if (!process.argv.includes('--rollback-only')) throw new Error('This script requires --rollback-only. Commit is unsupported.');
const config=mongoConnectionOptions(),client=new MongoClient(config.uri,config.options);
const result={label,measuredAt:new Date().toISOString(),environment:'Existing configured MongoDB; real handlers including session resolution; five explicitly aborted transactions; same installed indexes for both code versions',repetitions:5,checks:[],timings:{}};
let session, endSession, repo;
const check=name=>{if(!result.checks.includes(name)){result.checks.push(name);console.log(name);}};
try {
  await client.connect();const db=rollbackGuard(client,client.db(config.dbName));
  const before = await databaseSnapshot(db);
  for(let run=0;run<result.repetitions;run++) {
  const temporaryIds={address:'performance-'+crypto.randomUUID(),checkout:'performance-'+crypto.randomUUID()}, sessions=[], timings=[];
  const [user,admin,rider,area,products]=await Promise.all([
    db.collection('users').findOne({blockedAt:null}),db.collection('admins').findOne({isActive:{$ne:false}}),
    db.collection('riders').findOne({isActive:{$ne:false},mustChangePassword:{$ne:true}}),
    db.collection('deliveryAreas').findOne({isActive:{$ne:false}}),
    db.collection('products').find({isActive:{$ne:false},stock:{$gt:0}}).limit(20).toArray()
  ]);
  assert.ok(user&&admin&&rider&&area&&products.length,'Existing accounts, area, and products required.');
  const selected=[];let subtotal=0;
  for(const product of products){
    const variant=product.variants?.find(row=>row.isActive!==false&&row.stock>=(product.saleType==='loose'?row.quantityBase:1));
    if(product.variants?.length&&!variant)continue;
    const use=product.saleType==='loose'?variant.quantityBase:1;
    const max=Math.min(10,Math.floor(Math.min(product.stock,variant?.stock??product.stock)/use));
    if(max<1)continue;
    const quantity=Math.min(max,Math.max(1,Math.ceil((Number(area.minimumOrder||0)-subtotal)/(variant?.price??product.price))));
    const line={productId:product.id,variantId:variant?.id||null,quantity};
    subtotal+=resolveLine(product,line,{strict:true}).lineTotal;selected.push(line);
    if(subtotal>=Number(area.minimumOrder||0))break;
  }
  assert.ok(selected.length&&subtotal>=Number(area.minimumOrder||0),'Existing stock must meet the configured minimum.');
  const beforeStock=new Map(products.map(row=>[row.id,row.stock]));
  session=client.startSession();endSession=session.endSession.bind(session);
  session.startTransaction(transactionOptions);
  // The actual ClientSession is retained so every driver write is transactional.
  // Nested application helpers may neither commit nor end this outer session.
  session.withTransaction=async callback=>callback(session);
  session.endSession=async()=>{};
  repo=new MongoRepository(db,{startSession:()=>session});
  const tokens={};
  for(const [kind,owner] of [['customer',user],['admin',admin],['rider',rider]]){
    tokens[kind]=crypto.randomBytes(32).toString('base64url');const idHash=hashSessionId(tokens[kind]);sessions.push(idHash);
    await db.collection('sessions').insertOne({kind,idHash,ownerId:owner.id,authMethod:'password',createdAt:new Date(),expiresAt:new Date(Date.now()+300000)},{session});
  }
  const request=kind=>({headers:{cookie:`${{customer:'sid',admin:'asid',rider:'rsid'}[kind]}=${tokens[kind]}`},socket:{}});
  async function call(kind,route,method='GET',body={},timingLabel){
    const started=performance.now();
    const data=await repo.context.run({session,documents:new Map()},async()=>{
      const owner=await resolveIdentity(repo,request(kind),kind,{write:method!=='GET'});assert.ok(owner);
      const ctx={req:request(kind),route,url:new URL(route,'http://localhost'),method,body,ownerId:user.id,user:kind==='customer'?owner:null,admin:kind==='admin'?owner:null,rider:kind==='rider'?owner:null,headers:{},status:200};
      const data=route==='/api/orders'&&method==='POST'?await checkoutApi(repo,ctx):kind==='admin'?await handleAdminApi(repo,ctx):kind==='rider'?await handleRiderApi(repo,ctx):await handleCustomerApi(repo,ctx);
      assert.ok(ctx.status<400,`Handler returned ${ctx.status}`);await repo.flush();return data;
    });
    timings.push([timingLabel || kind+':'+method+':'+route,performance.now()-started]);return data;
  }
  await db.collection('addresses').insertOne({id:temporaryIds.address,customerId:user.id,label:'Audit transaction only',recipientName:user.name||'Customer',phone:user.phone||'0000000000',line1:'Rollback-only address',city:'Rollback-only city',deliveryAreaId:area.id,isDefault:false},{session});
  await db.collection('shoppingPreferences').updateOne({ownerId:user.id},{$set:{addressId:temporaryIds.address,areaId:area.id},$unset:{couponCode:''}},{upsert:true,session});
  await db.collection('carts').updateOne({ownerId:user.id},{$set:{items:[],version:0}},{upsert:true,session});
  for(const line of selected)await call('customer','/api/cart/items','POST',line);
  const cart=await call('customer','/api/cart');assert.equal(cart.subtotal,subtotal);check('Real session restoration, cart writes, authoritative pricing and selected delivery area');
  const orderResult=await call('customer','/api/orders','POST',{addressId:temporaryIds.address,paymentMethod:'cod',idempotencyKey:temporaryIds.checkout,price:0,total:0},'checkout');
  const order=orderResult.order;assert.ok(order);temporaryIds.order=order.id;assert.equal(order.subtotal,subtotal);assert.equal(order.paymentStatus,'Pay on delivery');
  for(const line of order.items){const product=await db.collection('products').findOne({id:line.id},{session});assert.equal(product.stock,beforeStock.get(line.id)-(line.saleType==='loose'?line.totalBaseQuantity:line.quantity));}
  check('COD order creation ignores client price/total and atomically deducts real stock');
  const replay=await call('customer','/api/orders','POST',{addressId:temporaryIds.address,paymentMethod:'cod',idempotencyKey:temporaryIds.checkout},'checkout-replay');assert.equal(replay.order.id,order.id);assert.equal(replay.idempotentReplay,true);check('Checkout replay creates one order and does not deduct stock twice');
  await db.collection('settings').updateOne({key:'dispatchSettings'},{$set:{value:{designatedRiderId:rider.id}}},{upsert:true,session});
  await db.collection('riders').updateOne({id:rider.id},{$set:{status:'online'}},{session});
  for(const status of ['Being packed','Ready for pickup'])await call('admin',`/api/admin/orders/${order.id}/status`,'PATCH',{status});
  await call('rider',`/api/rider/orders/${order.id}/accept`,'POST',{});
  for(const action of ['pickup','out_for_delivery'])await call('rider',`/api/rider/orders/${order.id}`,'POST',{action});
  await call('rider',`/api/rider/orders/${order.id}/payment`,'POST',{method:'cash',confirmed:true});
  const delivered=await call('rider',`/api/rider/orders/${order.id}`,'POST',{action:'delivered'});assert.equal(delivered.order.status,'Delivered');assert.equal(delivered.order.paymentCollection.amount,order.total);check('Admin preparation, rider acceptance, pickup, COD collection and delivery');
  await session.abortTransaction();check('Outer transaction explicitly aborted');
  assert.equal(await db.collection('orders').countDocuments({id:order.id}),0);
  assert.equal(await db.collection('addresses').countDocuments({id:temporaryIds.address}),0);
  assert.equal(await db.collection('sessions').countDocuments({idHash:{$in:sessions}}),0);
  assert.equal(await db.collection('notifications').countDocuments({orderId:order.id}),0);
  for(const line of selected){const product=await db.collection('products').findOne({id:line.productId});assert.equal(product.stock,beforeStock.get(line.productId));}
  check('Verified no audit order, address, session or notification survived; stock unchanged');
  // Do not retain live order/customer identifiers in the audit artifact.
  for(const [key,value] of timings)(result.timings[key.replaceAll(order.id,':order')] ||= []).push(value);
  await endSession();session=null;endSession=null;
  console.log(`Completed and aborted ${label} transaction ${run+1}/${result.repetitions}`);
  }
  const after = await databaseSnapshot(db);
  assert.deepEqual(after,before,'Persistent database content changed during verification');
  result.databaseSafety={unchanged:true,collections:Object.keys(before).length,snapshot:after};
  result.timings=Object.fromEntries(Object.entries(result.timings).map(([key,samples])=>[key,{medianMs:Number([...samples].sort((a,b)=>a-b)[Math.floor(samples.length/2)].toFixed(2)),samplesMs:samples.map(value=>Number(value.toFixed(2)))}]));
  await fs.writeFile(`performance/live-rollback-${label}.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({label,checkout:result.timings.checkout,databaseUnchanged:true}));
}catch(error){console.error(JSON.stringify({name:error.name,code:error.code||null,status:error.status||null,message:'Rollback-only live check failed; private data withheld.'}));process.exitCode=1;}
finally{if(session?.inTransaction())await session.abortTransaction();if(endSession)await endSession();await client.close();}
