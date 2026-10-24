import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fromMoneyCents, toMoneyCents, validatePricingVariants } from '../lib/product-pricing.mjs';

const root = path.resolve(import.meta.dirname, '..');
let tempDir, storePath, port, child, adminCookie, customerCookie;
const base = () => `http://127.0.0.1:${port}`;
async function freePort() { const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(resolve=>s.close(resolve));return n; }
async function call(route,{method='GET',body,cookie}={}) { const r=await fetch(`${base()}${route}`,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...(body?{origin:base()}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json().catch(()=>({})),cookie:r.headers.get('set-cookie')?.split(';')[0]}; }
async function signIn(prefix,phone) { const a=await call(`${prefix}/auth/request-otp`,{method:'POST',body:{phone}});assert.equal(a.status,200);const b=await call(`${prefix}/auth/verify-otp`,{method:'POST',body:{challengeId:a.data.challengeId,code:a.data.testCode,name:'Pricing Test'}});assert.equal(b.status,200);return b.cookie; }
async function start() { port=await freePort();child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'test',APP_TEST_AUTH:'1',PORT:String(port),STORE_PATH:storePath,DATABASE_URL:'',FCM_PROJECT_ID:'',GOOGLE_APPLICATION_CREDENTIALS:''},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const until=Date.now()+12000;while(Date.now()<until){if(child.exitCode!==null)throw new Error(`Test server exited: ${log}`);try{if((await fetch(`${base()}/api/health`)).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,60));}child.kill();throw new Error(`Test server timeout: ${log}`); }

test('money validation uses integer cents and requires configured reference prices to cover the sale price',()=>{
  assert.equal(toMoneyCents(34.25),3425);assert.equal(fromMoneyCents(3425),34.25);assert.equal(toMoneyCents(-1),null);
  const good=validatePricingVariants('loose','ml',[{id:'v500',label:'500 ml',quantityBase:500,price:34,mrp:42,stock:1000},{id:'v1l',label:'1 litre',quantityBase:1000,price:64,mrp:null,stock:1000}]);
  assert.equal(good.error,undefined);assert.equal(good.variants[1].mrp,null);
  assert.match(validatePricingVariants('packed','g',[{label:'1 kg',quantityBase:1000,price:120,mrp:100,stock:2}]).error,/cannot exceed/);
  assert.match(validatePricingVariants('loose','piece',[{label:'one',quantityBase:1,price:1,stock:1}]).error,/measurement unit/);
  assert.match(validatePricingVariants('loose','g',[{label:'500 g',quantityBase:500,price:1,stock:2.5}]).error,/whole number/);
});

before(async()=>{tempDir=await fs.mkdtemp(path.join(os.tmpdir(),'purainamart-pricing-'));storePath=path.join(tempDir,'isolated.json');await start();adminCookie=await signIn('/api/admin','9000000001');customerCookie=await signIn('/api','9110000091');});
after(async()=>{if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);}if(tempDir)await fs.rm(tempDir,{recursive:true,force:true});});

test('Admin pricing, concurrent loose-tier cart additions, base stock, checkout retry, and immutable order prices',async()=>{
  const area=await call('/api/admin/delivery-areas',{method:'POST',cookie:adminCookie,body:{name:'Pricing Test Area',deliveryCharge:0,minimumOrder:0,etaMinMinutes:10,etaMaxMinutes:20}});assert.equal(area.status,201,JSON.stringify(area.data));
  const address=await call('/api/addresses',{method:'POST',cookie:customerCookie,body:{label:'Home',recipientName:'Pricing Test',phone:'9110000091',line1:'1 Sample Street',city:'Sampletown',deliveryAreaId:area.data.area.id}});assert.equal(address.status,201,JSON.stringify(address.data));
  const product=await call('/api/admin/products',{method:'POST',cookie:adminCookie,body:{name:'Tier Milk',detail:'Milk',category:'dairy',saleType:'loose',measurementUnit:'ml',variants:[{id:'v250',label:'250 ml',quantityBase:250,price:18,mrp:22,stock:500},{id:'v500',label:'500 ml',quantityBase:500,price:34,mrp:42,stock:1500}],description:'Pricing fixture'}});assert.equal(product.status,201,JSON.stringify(product.data));
  const bad=await call(`/api/admin/products/${product.data.product.id}`,{method:'PATCH',cookie:adminCookie,body:{saleType:'loose',measurementUnit:'ml',variants:[{id:'v250',label:'250 ml',quantityBase:250,price:23,mrp:22,stock:500}]}});assert.equal(bad.status,400);
  const calls=await Promise.all([1,2].map(()=>call('/api/cart/items',{method:'POST',cookie:customerCookie,body:{productId:product.data.product.id,variantId:'v250',delta:1}})));assert.deepEqual(calls.map(row=>row.status).sort(),[200,200]);
  const third=await call('/api/cart/items',{method:'POST',cookie:customerCookie,body:{productId:product.data.product.id,variantId:'v250',delta:1}});assert.equal(third.status,409);
  const cart=await call('/api/cart',{cookie:customerCookie});const line=cart.data.items.find(row=>row.variantId==='v250');assert.equal(line.quantity,2);assert.equal(line.baseQuantityTotal,500);assert.equal(line.price,18);assert.equal(line.lineTotal,36);assert.equal(cart.data.itemSavings,8);
  const order=await call('/api/orders',{method:'POST',cookie:customerCookie,body:{addressId:address.data.address.id,paymentMethod:'cod',idempotencyKey:'pricing-order-retry-0001'}});assert.equal(order.status,201,JSON.stringify(order.data));const item=order.data.order.items[0];assert.equal(item.variantId,'v250');assert.equal(item.quantityPerUnit,250);assert.equal(item.totalBaseQuantity,500);assert.equal(item.price,18);assert.equal(item.mrp,22);assert.equal(item.lineTotal,36);
  assert.equal(order.data.order.subtotal,36);assert.equal(order.data.order.total,38);const stockAfterOrder=JSON.parse(await fs.readFile(storePath,'utf8')).products.find(row=>row.id===product.data.product.id).variants.find(row=>row.id==='v250').stock;assert.equal(stockAfterOrder,0);
  const retry=await call('/api/orders',{method:'POST',cookie:customerCookie,body:{addressId:address.data.address.id,paymentMethod:'cod',idempotencyKey:'pricing-order-retry-0001'}});assert.equal(retry.status,200);assert.equal(retry.data.idempotentReplay,true);const stockAfterRetry=JSON.parse(await fs.readFile(storePath,'utf8')).products.find(row=>row.id===product.data.product.id).variants.find(row=>row.id==='v250').stock;assert.equal(stockAfterRetry,0);
  const edited=await call(`/api/admin/products/${product.data.product.id}`,{method:'PATCH',cookie:adminCookie,body:{saleType:'loose',measurementUnit:'ml',variants:[{id:'v250',label:'250 ml',quantityBase:250,price:20,mrp:25,stock:500},{id:'v500',label:'500 ml',quantityBase:500,price:40,mrp:null,stock:1500}]}});assert.equal(edited.status,200,JSON.stringify(edited.data));
  const historical=await call(`/api/orders/${order.data.order.id}`,{cookie:customerCookie});assert.equal(historical.data.order.items[0].price,18);assert.equal(historical.data.order.items[0].mrp,22);assert.equal(historical.data.order.items[0].lineTotal,36);
  const noMrp=await call('/api/cart/items',{method:'POST',cookie:customerCookie,body:{productId:product.data.product.id,variantId:'v500',delta:1}});assert.equal(noMrp.status,200);const noMrpLine=noMrp.data.items.find(row=>row.variantId==='v500');assert.equal(noMrpLine.mrp,null);assert.equal(noMrpLine.price,40);assert.equal(noMrpLine.lineTotal,40);assert.equal(noMrp.data.itemSavings,0);
  const packed=await call('/api/admin/products',{method:'POST',cookie:adminCookie,body:{name:'Packed Test',category:'dairy',saleType:'packed',measurementUnit:'g',variants:[{id:'pack500',label:'500 g pack',quantityBase:500,price:90,mrp:100,stock:2}]}});assert.equal(packed.status,201,JSON.stringify(packed.data));const packs=await call('/api/cart/items',{method:'POST',cookie:customerCookie,body:{productId:packed.data.product.id,variantId:'pack500',delta:2}});assert.equal(packs.status,200);assert.equal(packs.data.items.find(row=>row.variantId==='pack500').lineTotal,180);assert.equal((await call('/api/cart/items',{method:'POST',cookie:customerCookie,body:{productId:packed.data.product.id,variantId:'pack500',delta:1}})).status,409);
  const packedUpdate=await call(`/api/admin/products/${packed.data.product.id}`,{method:'PATCH',cookie:adminCookie,body:{saleType:'packed',measurementUnit:'g',variants:[{id:'pack500',label:'500 g pack',quantityBase:500,price:88,mrp:100,stock:2}]}});assert.equal(packedUpdate.status,200);assert.equal(packedUpdate.data.product.variants[0].stock,2);
});
