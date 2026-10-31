import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/api-fixture.mjs';
import { addRider } from './support/workflow-fixture.mjs';
import { orderStatus, customerCanCancel } from '../public/order-status.js';

const riderCall=(f,id,action,body={},as='rider')=>f.call(`/api/rider/orders/${id}${action?'/'+action:''}`,{as,method:'POST',body});
test('New checkout broadcasts once, excludes legacy records, and admits exactly one competing rider', async t=>{
  const f=await fixture(t); addRider(f,'r2');
  const placed=await f.order(),id=placed.data.order.id;
  assert.equal(placed.status,201); assert.equal(placed.data.order.workflowVersion,2);
  const legacy={...structuredClone(placed.data.order),id:'legacy',idempotencyKey:'legacy-key',workflowVersion:undefined,status:'Order received',createdAt:'2025-01-01T00:00:00.000Z',timeline:[{label:'Order received',complete:true,at:'2025-01-01T00:00:00.000Z'}]};
  f.docs.orders.push(legacy); const before=structuredClone(legacy);
  for(const as of ['rider','r2']) {
    assert.deepEqual((await f.call('/api/rider/bootstrap',{as})).data.availableOrders.map(o=>o.id),[id]);
    assert.equal((await f.call('/api/rider/orders/legacy',{as})).status,404);
  }
  assert.equal((await riderCall(f,'legacy','accept')).status,409);
  const attempts=await Promise.all([riderCall(f,id,'accept'),riderCall(f,id,'accept',{},'r2')]);
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  const order=f.docs.orders.find(o=>o.id===id),loser=order.riderId==='r1'?'r2':'rider';
  assert.equal(order.status,'Accepted'); assert.equal(order.paymentStatus,'Pay on delivery');
  assert.equal((await f.call(`/api/rider/orders/${id}`,{as:loser})).status,404);
  assert.equal(order.timeline.filter(s=>s.label==='Accepted'&&s.complete).length,1);
  assert.deepEqual(f.docs.orders.find(o=>o.id==='legacy'),before);
  const availableEvents=f.docs.notificationEvents.filter(e=>e.eventType==='rider_order');
  assert.equal(availableEvents.length,2); assert.equal(new Set(availableEvents.map(e=>e.id)).size,2);
});

test('Rejection is unique, alerts admin when all riders decline, and preserves inventory and payment',async t=>{
  const f=await fixture(t);addRider(f,'r2');const {data:{order}}=await f.order();
  assert.equal((await riderCall(f,order.id,'reject',{})).status,400);
  assert.equal((await riderCall(f,order.id,'reject',{reason:'Unavailable'})).status,200);
  assert.equal((await riderCall(f,order.id,'reject',{reason:'Retry'})).status,409);
  assert.equal((await riderCall(f,order.id,'reject',{reason:'Unavailable'},'r2')).status,200);
  const saved=f.docs.orders[0];assert.equal(saved.riderRejections.length,2);assert.equal(saved.status,'New');assert.equal(saved.paymentStatus,'Pay on delivery');assert.equal(f.docs.products[0].stock,19);
  assert.ok(f.docs.notificationEvents.some(e=>e.ownerType==='admin'&&e.title==='No rider available'));
});

for(const started of [false,true]) test(`Release ${started?'during delivery':'before delivery'} permits another rider without restocking or rewriting history`,async t=>{
  const f=await fixture(t);addRider(f,'r2');const {data:{order}}=await f.order();
  await riderCall(f,order.id,'accept');
  if(started)assert.equal((await riderCall(f,order.id,'',{action:'out_for_delivery'})).status,200);
  const history=structuredClone(f.docs.orders[0].timeline.filter(s=>s.complete));
  assert.equal((await riderCall(f,order.id,'release',{})).status,400);
  assert.equal((await riderCall(f,order.id,'release',{reason:'Vehicle problem'})).status,200);
  assert.equal(f.docs.orders[0].status,'New');assert.equal(f.docs.orders[0].riderId,null);assert.equal(f.docs.orders[0].cancellation,undefined);assert.equal(f.docs.products[0].stock,19);
  assert.equal(customerCanCancel(f.docs.orders[0]),!started);
  assert.equal((await riderCall(f,order.id,'release',{reason:'Duplicate'})).status,404);
  assert.equal((await riderCall(f,order.id,'accept',{},'r2')).status,200);
  for(const event of history)assert.ok(f.docs.orders[0].timeline.some(s=>JSON.stringify(s)===JSON.stringify(event)));
  assert.equal(f.docs.orders[0].timeline.filter(s=>s.label==='Accepted'&&s.complete).length,2);
  if(started) {
    const cancelled=await f.call(`/api/admin/orders/${order.id}/status`,{as:'admin',method:'PATCH',body:{status:'Cancelled',reason:'Unable to deliver'}});
    assert.equal(cancelled.status,200);assert.equal(f.docs.products[0].stock,19);assert.equal(cancelled.data.order.inventoryReconciliationRequired,true);
  }
});

test('Cash confirmation requires exact amount, survives failed delivery, and cannot be collected twice',async t=>{
  const f=await fixture(t);const {data:{order}}=await f.order();await riderCall(f,order.id,'accept');
  assert.equal((await riderCall(f,order.id,'payment',{method:'cash',confirmed:true,amount:order.total})).status,409);
  await riderCall(f,order.id,'',{action:'out_for_delivery'});
  for(const body of [{method:'cash',confirmed:true},{method:'cash',confirmed:true,amount:1},{method:'cash',confirmed:false,amount:order.total},{method:'cash',confirmed:true,amount:String(order.total)}]) assert.equal((await riderCall(f,order.id,'payment',body)).status,400);
  assert.equal((await riderCall(f,order.id,'',{action:'delivered'})).status,409);
  const cash={method:'cash',confirmed:true,amount:order.total};
  const results=await Promise.all([riderCall(f,order.id,'payment',cash),riderCall(f,order.id,'payment',cash)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await riderCall(f,order.id,'release',{reason:'Cannot continue'})).status,409);
  assert.equal((await riderCall(f,order.id,'',{action:'delivered'})).status,200);
  assert.equal((await riderCall(f,order.id,'',{action:'delivered'})).status,409);
  assert.equal(f.docs.orders[0].paymentCollection.amount,order.total);
});

test('Historical assigned orders retain dates and status labels and accept the next supported action',async t=>{
  const f=await fixture(t);const {data:{order}}=await f.order();
  Object.assign(f.docs.orders[0],{workflowVersion:undefined,status:'Rider assigned',riderId:'r1',assignedAt:'2025-01-01T01:00:00.000Z',timeline:[{label:'Accepted by rider',complete:true,at:'2025-01-01T01:00:00.000Z'}]});
  assert.equal(orderStatus(f.docs.orders[0]),'Accepted');
  assert.equal((await riderCall(f,order.id,'',{action:'out_for_delivery'})).status,200);
  assert.equal(f.docs.orders[0].assignedAt,'2025-01-01T01:00:00.000Z');
  assert.deepEqual(f.docs.orders[0].timeline[0],{label:'Accepted by rider',complete:true,at:'2025-01-01T01:00:00.000Z'});
});

test('Every scoped admin module loads and historical filters match without changing stored orders',async t=>{
  const f=await fixture(t);const {data:{order}}=await f.order();
  f.docs.orders.push({...structuredClone(order),id:'legacy-packed',status:'Being packed',workflowVersion:undefined});
  f.docs.orders.push({...structuredClone(order),id:'legacy-delivered',status:'Delivered',deliveredAt:new Date().toISOString(),paymentStatus:'Cash collected'});
  const before=structuredClone(f.docs.orders);
  for(const view of ['overview','orders','products','categories','banners','riders','deliveryAreas','more','customers','coupons','notifications','referrals'])assert.equal((await f.call('/api/admin/bootstrap?view='+view,{as:'admin'})).status,200,view);
  const overview=(await f.call('/api/admin/bootstrap?view=overview',{as:'admin'})).data;
  assert.equal(overview.metrics.orders,3);assert.equal(overview.metrics.byStatus.New,1);assert.equal(overview.metrics.byStatus.Accepted,1);assert.equal(overview.metrics.sales,order.total);assert.equal(overview.metrics.todaySales,order.total);
  const accepted=(await f.call('/api/admin/bootstrap?view=orders&status=Accepted',{as:'admin'})).data.orders;
  assert.deepEqual(accepted.map(o=>o.id),['legacy-packed']);assert.deepEqual(f.docs.orders,before);
});

test('Historical prepaid cancellation keeps payment evidence and flags review without inventing a refund',async t=>{
  const f=await fixture(t);const {data:{order}}=await f.order();
  Object.assign(f.docs.orders[0],{status:'Order received',workflowVersion:undefined,paymentMethod:'UPI',paymentStatus:'Paid',paymentVerification:{status:'verified',transactionReference:'historical-provider-reference'}});
  const cancelled=await f.call(`/api/admin/orders/${order.id}/status`,{as:'admin',method:'PATCH',body:{status:'Cancelled',reason:'Customer requested cancellation'}});
  assert.equal(cancelled.status,200);assert.equal(cancelled.data.order.paymentStatus,'Paid');assert.equal(cancelled.data.order.paymentVerification.transactionReference,'historical-provider-reference');assert.equal(cancelled.data.order.paymentReconciliation.status,'review_required');
});
