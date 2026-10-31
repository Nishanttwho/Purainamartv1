// Existing configured database only. All writes share one guarded session per
// scenario, commit is disabled, no workers run, and external HTTP is forbidden.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { mongoConnectionOptions } from '../lib/mongodb.mjs';
import { MongoRepository, transactionOptions } from '../lib/mongo-repository.mjs';
import { checkoutApi, cancellationApi, handleCustomerApi } from '../lib/api-customer.mjs';
import { handleRiderApi } from '../lib/api-rider.mjs';
import { handleAdminApi } from '../lib/api-admin.mjs';
import { rollbackGuard, databaseSnapshot } from './performance-safety.mjs';

if (!process.argv.includes('--rollback-only')) throw Error('Requires --rollback-only; commits are unsupported.');
globalThis.fetch=async()=>{throw Error('External HTTP is forbidden in database verification');};
const config=mongoConnectionOptions(),client=new MongoClient(config.uri,config.options);
const report={checkedAt:new Date().toISOString(),checks:[],transactionsAborted:0,externalRequests:0,commits:0};
const check=name=>{report.checks.push(name);console.log(name);};
let session,closeSession;
try {
  await client.connect();const db=rollbackGuard(client,client.db(config.dbName));
  const before=await databaseSnapshot(db);
  // Read-only inspection, without storing customer or rider personal data.
  report.historicalStatuses=await db.collection('orders').aggregate([{$group:{_id:{status:'$status',paymentStatus:'$paymentStatus'},count:{$sum:1}}}]).toArray();
  const admin=await db.collection('admins').findOne({isActive:{$ne:false}},{projection:{_id:0}});
  assert.ok(admin,'An existing admin account is required for authorization');
  for(const scenario of ['delivery','release','cancellation']) {
    session=client.startSession();closeSession=session.endSession.bind(session);session.startTransaction(transactionOptions);
    session.withTransaction=async callback=>callback(session);session.endSession=async()=>{};
    // The repository and nested checkout/cancellation helpers all use this exact session.
    const repo=new MongoRepository(db,{startSession:()=>session});
    const seed=crypto.randomUUID(),id=part=>`verify-${seed}-${part}`;
    const user={id:id('user'),name:'Rollback verification',phone:'8'+crypto.randomInt(100000000,999999999),createdAt:new Date().toISOString()};
    const riders=[1,2].map(n=>({id:id('rider'+n),name:'Verification rider '+n,phone:'7'+crypto.randomInt(100000000,999999999),status:'online',isActive:true,mustChangePassword:false}));
    const product={id:id('product'),name:'Rollback-only product',price:100,mrp:120,stock:5,isActive:true,category:id('category')};
    const area={id:id('area'),name:'Rollback-only area',deliveryCharge:20,minimumOrder:0,etaMinMinutes:10,etaMaxMinutes:20,isActive:true};
    const address={id:id('address'),customerId:user.id,recipientName:user.name,phone:user.phone,line1:'Transaction verification only',city:'Verification',deliveryAreaId:area.id};
    for(const [name,row] of [['users',user],...riders.map(r=>['riders',r]),['products',product],['categories',{id:product.category,name:'Verification',isActive:true}],['deliveryAreas',area],['addresses',address]])await db.collection(name).insertOne(row,{session});
    await db.collection('carts').insertOne({ownerId:user.id,version:0,items:[{productId:product.id,quantity:1}]},{session});
    await db.collection('shoppingPreferences').insertOne({ownerId:user.id,addressId:address.id,areaId:area.id},{session});
    const call=async(kind,route,method='GET',body={},rider=riders[0])=>repo.context.run({session,documents:new Map()},async()=>{
      // These internal handlers normally receive identities from resolveIdentity;
      // no login/session or external authentication request is needed here.
      const ctx={route:route.split('?')[0],url:new URL(route,'http://localhost'),method,body,req:{headers:{},socket:{}},headers:{},status:200,ownerId:user.id,user:kind==='customer'?await repo.one('users',{id:user.id}):null,admin:kind==='admin'?admin:null,rider:kind==='rider'?await repo.one('riders',{id:rider.id}):null,publicDir:path.resolve('public')};
      let value;
      if(route==='/api/orders'&&method==='POST')value=await checkoutApi(repo,ctx);
      else if(route.endsWith('/cancel')&&kind==='customer')value=await cancellationApi(repo,ctx,route.split('/')[3],'customer');
      else value=await (kind==='rider'?handleRiderApi:kind==='admin'?handleAdminApi:handleCustomerApi)(repo,ctx);
      assert.ok(ctx.status<400,JSON.stringify(value));await repo.flush();return value;
    });
    // Checkout reauthorizes its own identity inside the transaction.
    // Provide an ephemeral hashed session used only by those nested helpers.
    const token=crypto.randomBytes(32).toString('hex');
    const idHash=crypto.createHash('sha256').update(token).digest('hex');
    await db.collection('sessions').insertOne({kind:'customer',idHash,ownerId:user.id,authMethod:'password',createdAt:new Date(),expiresAt:new Date(Date.now()+300000)},{session});
    // Build checkout with the same guarded request identity as a real request.
    const checkout=()=>repo.context.run({session,documents:new Map()},async()=>{
      const ctx={req:{headers:{cookie:`sid=${token}`},socket:{}},route:'/api/orders',url:new URL('http://localhost/api/orders'),method:'POST',body:{addressId:address.id,paymentMethod:'cod',idempotencyKey:id('checkout'),total:0},headers:{},status:200,user,ownerId:user.id};
      const result=await checkoutApi(repo,ctx);assert.ok(ctx.status<400,JSON.stringify(result));await repo.flush();return result;
    });
    const {order}=await checkout();assert.equal(order.status,'New');assert.equal(order.total,122);assert.equal(order.workflowVersion,2);
    assert.equal((await checkout()).idempotentReplay,true);
    const inbox=(await call('rider','/api/rider/bootstrap?limit=200')).availableOrders;
    assert.ok(inbox.some(o=>o.id===order.id));
    const oldIds=(await db.collection('orders').find({workflowVersion:{$ne:2},riderId:null},{session,projection:{id:1}}).toArray()).map(o=>o.id);
    assert.ok(inbox.every(o=>!oldIds.includes(o.id)));check(`${scenario}: authoritative checkout, replay and legacy inbox exclusion`);
    const details=await call('rider',`/api/rider/orders/${order.id}`);assert.equal(details.order.address.line1,address.line1);assert.equal(details.order.subtotal,100);
    if(scenario==='cancellation') {
      const cancelled=await repo.context.run({session,documents:new Map()},async()=>{
        const ctx={req:{headers:{cookie:`sid=${token}`},socket:{}},body:{},headers:{},status:200,user,ownerId:user.id};
        const value=await cancellationApi(repo,ctx,order.id,'customer');assert.equal(ctx.status,200);await repo.flush();return value;
      });
      assert.equal(cancelled.order.status,'Cancelled');assert.equal((await db.collection('products').findOne({id:product.id},{session})).stock,5);
      check('Customer cancellation of an unaccepted New order restores inventory inside the same transaction');
    } else {
    await call('rider',`/api/rider/orders/${order.id}/accept`,'POST');
    await assert.rejects(()=>call('rider',`/api/rider/orders/${order.id}/accept`,'POST',{},riders[1]),e=>e.status===409);
    assert.ok(!(await call('rider','/api/rider/bootstrap','GET',{},riders[1])).availableOrders.some(o=>o.id===order.id));
    check(`${scenario}: atomic acceptance predicate denies second rider and updates competing inbox`);
    if(scenario==='release') {
      await call('rider',`/api/rider/orders/${order.id}/release`,'POST',{reason:'Rollback-only release'});
      const released=await db.collection('orders').findOne({id:order.id},{session});assert.equal(released.status,'New');assert.equal(released.riderId,null);assert.equal(released.cancellation,undefined);assert.equal(released.paymentStatus,'Pay on delivery');
      await call('rider',`/api/rider/orders/${order.id}/accept`,'POST',{},riders[1]);
      await call('rider',`/api/rider/orders/${order.id}`,'POST',{action:'out_for_delivery'},riders[1]);
      await call('rider',`/api/rider/orders/${order.id}/release`,'POST',{reason:'Rollback-only handoff'},riders[1]);
      const final=await db.collection('orders').findOne({id:order.id},{session});assert.equal(final.deliveryReleases.length,2);assert.equal(final.inventoryReconciliationRequired,true);assert.equal((await db.collection('products').findOne({id:product.id},{session})).stock,4);
      check('Release and reassignment retain customer order, historical acceptance events, pending COD and deducted stock');
    } else {
      await call('rider',`/api/rider/orders/${order.id}`,'POST',{action:'out_for_delivery'});
      await assert.rejects(()=>call('rider',`/api/rider/orders/${order.id}/payment`,'POST',{method:'cash',confirmed:true,amount:1}),e=>e.status===400);
      await assert.rejects(()=>call('rider',`/api/rider/orders/${order.id}`,'POST',{action:'delivered'}),e=>e.status===409);
      await call('rider',`/api/rider/orders/${order.id}/payment`,'POST',{method:'cash',confirmed:true,amount:122});
      await assert.rejects(()=>call('rider',`/api/rider/orders/${order.id}/payment`,'POST',{method:'cash',confirmed:true,amount:122}),e=>e.status===409);
      const delivered=await call('rider',`/api/rider/orders/${order.id}`,'POST',{action:'delivered'});assert.equal(delivered.order.paymentCollection.amount,122);assert.equal(delivered.order.status,'Delivered');
      const overview=await call('admin','/api/admin/bootstrap?view=overview');assert.ok(overview.metrics.byStatus.Delivered>=1);
      check('Live handlers enforce exact COD, deny duplicate collection and report delivered sales');
    }
    }
    await session.abortTransaction();report.transactionsAborted++;await closeSession();session=null;
    assert.equal(await db.collection('orders').countDocuments({id:order.id}),0);assert.equal(await db.collection('users').countDocuments({id:user.id}),0);assert.equal(await db.collection('products').countDocuments({id:product.id}),0);
  }
  const after=await databaseSnapshot(db);assert.deepEqual(after,before,'Database counts and document digests must be unchanged');
  report.databaseUnchanged=true;report.collections=Object.keys(after).length;
  check('All transactions aborted; all collection counts and document digests unchanged');
  await fs.writeFile('verification/admin-redesign-live.json',JSON.stringify(report,null,2)+'\n');
  await fs.writeFile('verification/admin-redesign-db-before.json',JSON.stringify(before,null,2)+'\n');
  await fs.writeFile('verification/admin-redesign-db-after.json',JSON.stringify(after,null,2)+'\n');
} finally {if(session){if(session.inTransaction())await session.abortTransaction();await closeSession();}await client.close();}
