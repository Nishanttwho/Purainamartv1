import test from 'node:test';
import assert from 'node:assert/strict';
import { createCartController, estimateCart } from '../public/cart-controller.js';
import { createApiClient } from '../public/api-client.js';
import { MongoRepository } from '../lib/mongo-repository.mjs';
import { acceptedEncoding } from '../lib/http-performance.mjs';
import { fixture } from './support/api-fixture.mjs';
import { fakeMongo } from './support/fake-mongo.mjs';
const line={id:'rice',variantId:null,price:10.25,quantity:1};
const summary=items=>({items,count:items.reduce((n,x)=>n+x.quantity,0),subtotal:items.reduce((n,x)=>n+x.price*x.quantity,0),delivery:0,platform:2,total:0});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('cart paints synchronously, coalesces clicks, and preserves other pending lines',async()=>{
  let cart=summary([]);const requests=[];
  const controller=createCartController({getCart:()=>cart,setCart:value=>{cart=value;},send:body=>new Promise(resolve=>requests.push({body,resolve})),read:async()=>cart});
  controller.set(line,1);assert.equal(cart.count,1);
  controller.set(line,2);controller.set(line,3);await tick();
  assert.equal(requests.length,1);assert.equal(requests[0].body.quantity,3);
  controller.set(line,4);controller.set({...line,id:'milk'},2);
  requests[0].resolve(summary([{...line,quantity:3}]));await tick();
  assert.equal(cart.items.find(x=>x.id==='rice').quantity,4);assert.equal(cart.items.find(x=>x.id==='milk').quantity,2);
  assert.equal(requests[1].body.quantity,4);
  requests[1].resolve(summary([{...line,quantity:4}]));await tick();
  requests[2].resolve(summary([{...line,quantity:4},{...line,id:'milk',quantity:2}]));await controller.flush();
  assert.equal(cart.count,6);assert.equal(cart.pending,false);
});
test('failed cart writes roll back; an ambiguous response reconciles once without replay',async()=>{
  let cart=summary([line]),reads=0,sends=0;
  const controller=createCartController({getCart:()=>cart,setCart:v=>{cart=v;},send:async()=>{sends++;throw new TypeError('Network lost');},read:async()=>{reads++;return summary([{...line,quantity:2}]);}});
  controller.set(line,2);await assert.rejects(controller.flush(),/Network lost/);
  assert.equal(cart.count,2);assert.equal(reads,1);assert.equal(sends,1);
  const rejected=createCartController({getCart:()=>cart,setCart:v=>{cart=v;},send:async()=>{throw Object.assign(new Error('Out of stock'),{status:409});},read:async()=>{throw new Error('Must not reread a rejected write');}});
  rejected.set(line,3);await assert.rejects(rejected.flush(),/Out of stock/);assert.equal(cart.count,2);
});
test('cart estimates use integer cents and recalculate minimum and free delivery',()=>{
  const value=estimateCart({deliveryAvailable:true,minimumOrder:10,freeDeliveryThreshold:30,deliveryArea:{deliveryCharge:20}},[{...line,quantity:3}]);
  assert.equal(value.subtotal,30.75);assert.equal(value.total,32.75);assert.equal(value.delivery,0);assert.equal(value.minimumOrderMet,true);
});
test('a concurrent tab conflict rebases the outstanding increment instead of overwriting it',async()=>{
  let cart=summary([line]),calls=[];
  const controller=createCartController({getCart:()=>cart,setCart:value=>{cart=value;},send:async body=>{calls.push(body);if(calls.length===1)throw Object.assign(new Error('Changed'),{status:409,code:'CART_CONFLICT'});return summary([{...line,quantity:body.quantity}]);},read:async()=>summary([{...line,quantity:3}])});
  controller.set(line,2);await controller.flush();assert.equal(cart.count,4);assert.equal(calls[0].expectedQuantity,1);assert.equal(calls[1].expectedQuantity,3);
});
test('request coalescing caches only public data and invalidates on writes',async()=>{
  const calls=[];const api=createApiClient(async(url)=>{calls.push(url);await tick();return {url};});
  await Promise.all([api('/api/cart'),api('/api/cart')]);assert.equal(calls.length,1);
  await api('/api/cart');assert.equal(calls.length,2);
  await api('/api/products');await api('/api/products');assert.equal(calls.length,3);
  await api('/api/cart/items',{method:'POST'});await api('/api/products');assert.equal(calls.length,5);
});
test('request-local reads coalesce and forget invalidates negative cached entries',async()=>{
  const mongo=fakeMongo();const repo=new MongoRepository(mongo.db,mongo.client);
  await repo.context.run({documents:new Map(),readCache:new Map()},async()=>{
    await Promise.all([repo.one('settings',{key:'a'}),repo.one('settings',{key:'a'})]);
    assert.equal(mongo.operations.length,1);await repo.setSetting('a',1);repo.forget('settings');assert.equal((await repo.one('settings',{key:'a'})).value,1);
  });
});
test('public catalogue skips session hydration and never shares private caches',async t=>{
  const f=await fixture(t);f.operations.length=0;
  const response=await f.call('/api/products?limit=24');assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/^public/);assert.equal(response.cookie,null);
  assert.equal(f.operations.some(row=>row.name==='sessions'||row.name==='users'),false);
  const count=f.operations.length;await f.call('/api/products?limit=24',{as:'customer2'});assert.equal(f.operations.length,count);
  const one=await f.call('/api/bootstrap?compact=1&limit=24'),two=await f.call('/api/bootstrap?compact=1&limit=24',{as:'customer2'});
  assert.notEqual(one.data.user.id,two.data.user.id);assert.equal(one.headers.get('cache-control'),'no-store');
  await f.call('/api/admin/products/p1',{as:'admin',method:'PATCH',body:{price:101}});
  assert.equal((await f.call('/api/products?limit=24')).data.products.find(row=>row.id==='p1').price,101);
});
test('admin screens bound records, preserve category counts and avoid unrelated collections',async t=>{
  const f=await fixture(t);
  for(let i=0;i<55;i++)f.docs.products.push({...f.docs.products[0],id:'extra-'+i,name:'Page product '+i});
  f.operations.length=0;
  const first=await f.call('/api/admin/bootstrap?view=products&limit=25&offset=0',{as:'admin'});
  assert.equal(first.data.products.length,25);assert.equal(first.data.total,57);assert.equal(first.data.orders.length,0);assert.equal(first.headers.get('cache-control'),'no-store');
  assert.equal(f.operations.some(row=>['orders','users','notificationDevices','notificationCampaigns'].includes(row.name)),false);
  const last=await f.call('/api/admin/bootstrap?view=products&limit=25&offset=50',{as:'admin'});assert.equal(last.data.products.length,7);
  const search=await f.call('/api/admin/bootstrap?view=products&limit=25&q=Page%20product%2054',{as:'admin'});assert.equal(search.data.products.length,1);
  const categories=await f.call('/api/admin/bootstrap?view=categories&limit=25',{as:'admin'});assert.equal(categories.data.categories[0].productCount,57);
  assert.equal(JSON.stringify(first.data).includes('passwordHash'),false);
});
test('admin customer summaries use batch aggregations independent of page population',async t=>{
  const f=await fixture(t);for(let i=0;i<30;i++)f.docs.users.push({id:'page-user-'+i,name:'Page user'});
  f.operations.length=0;const result=await f.call('/api/admin/customers?limit=25',{as:'admin'});assert.equal(result.data.customers.length,25);
  assert.equal(f.operations.filter(row=>row.name==='orders'&&row.operation==='aggregate').length,1);
  assert.equal(f.operations.filter(row=>row.name==='notifications'&&row.operation==='aggregate').length,1);
});
test('compact cart mutation returns authoritative totals with fewer reads',async t=>{
  const f=await fixture(t);await f.call('/api/cart/items',{method:'POST',body:{productId:'p1',quantity:1}});f.operations.length=0;
  const result=await f.call('/api/cart/items?offers=0',{method:'POST',body:{productId:'p1',quantity:2,price:0}});
  assert.equal(result.data.subtotal,200);assert.equal(f.operations.filter(row=>row.name==='products').length,1);assert.equal(f.operations.some(row=>row.name==='coupons'),false);
});
test('compression honors quality exclusions and serves equivalent static content',async t=>{
  assert.equal(acceptedEncoding('br;q=0,gzip;q=0'),null);assert.equal(acceptedEncoding('gzip;q=1,br;q=0.5'),'gzip');
  const f=await fixture(t);const response=await fetch(f.base+'/app.js',{headers:{'accept-encoding':'br'}});assert.equal(response.headers.get('content-encoding'),'br');const body=await response.text();assert.match(body,/createCartController/);assert.ok(Number(response.headers.get('content-length'))<Buffer.byteLength(body)/2);
  const api=await f.call('/api/bootstrap');assert.match(api.headers.get('server-timing'),/app;dur=/);
  const revalidated=await fetch(f.base+'/app.js',{headers:{'accept-encoding':'br','if-none-match':response.headers.get('etag')}});
  assert.equal(revalidated.status,304);assert.equal(revalidated.headers.get('vary'),'Accept-Encoding');
  assert.equal(revalidated.headers.get('content-length'),null);
});
