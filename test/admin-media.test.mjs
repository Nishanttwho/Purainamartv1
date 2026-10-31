import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixture } from './support/api-fixture.mjs';
import { cleanupMedia } from '../lib/admin-media.mjs';
import { optimizedImage } from '../public/product-images.js';

async function mediaFixture(t) {
  const f=await fixture(t), saved={};
  for(const key of ['CLOUDINARY_URL','CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET']) {saved[key]=process.env[key];delete process.env[key];}
  process.env.CLOUDINARY_URL='cloudinary://test-key:test-secret@test-cloud';
  t.after(()=>{for(const [key,value] of Object.entries(saved))value===undefined?delete process.env[key]:process.env[key]=value;});
  const fetch=globalThis.fetch;
  const uploads=new Map();
  globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith(f.base))return fetch(url,options);
    assert.ok(String(url).startsWith('https://api.cloudinary.com/v1_1/test-cloud/resources/image/upload/'),'Unexpected external request');
    const public_id=decodeURIComponent(String(url).split('/resources/image/upload/')[1]);
    assert.ok(uploads.has(public_id),'Only synthetic uploads may be verified');
    return Response.json(uploads.get(public_id));
  };
  t.after(()=>{globalThis.fetch=fetch;});
  const call=(route,body={},method='POST')=>f.call(route,{as:'admin',method,body});
  async function upload(overrides={}) {
    const signed=await call('/api/admin/media/uploads',{type:'image/png',size:32});assert.equal(signed.status,200,JSON.stringify(signed.data));
    const public_id=signed.data.params.public_id;
    uploads.set(public_id,{public_id,resource_type:'image',type:'upload',format:'png',bytes:32,secure_url:`https://res.cloudinary.com/test-cloud/image/upload/v1/${public_id}.png`,...overrides});
    return {signed:signed.data,complete:()=>call(`/api/admin/media/uploads/${signed.data.uploadId}/complete`)};
  }
  return {...f,callAdmin:call,upload};
}

test('Signed media lease validates inputs, hides secrets and verifies Cloudinary metadata before attachment',async t=>{
  const f=await mediaFixture(t);
  for(const body of [{type:'image/svg+xml',size:20},{type:'image/png',size:0},{type:'image/png',size:11*1024*1024}]) assert.equal((await f.callAdmin('/api/admin/media/uploads',body)).status,400);
  assert.equal((await f.call('/api/admin/media/uploads',{as:'rider',method:'POST',body:{type:'image/png',size:20}})).status,401);
  const upload=await f.upload(),signed=upload.signed;
  assert.equal(signed.params.overwrite,false);assert.equal(JSON.stringify(signed).includes('test-secret'),false);
  assert.equal(signed.signature,crypto.createHash('sha1').update(Object.entries(signed.params).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('&')+'test-secret').digest('hex'));
  const verified=await upload.complete();assert.equal(verified.status,200);assert.equal(verified.data.imageAsset.public_id,signed.params.public_id);
  const product=await f.callAdmin('/api/admin/products/p1',{image:verified.data.image},'PATCH');assert.equal(product.status,200);assert.deepEqual(product.data.product.imageAsset,verified.data.imageAsset);assert.equal(f.docs.mediaAssets[0].status,'attached');
  assert.equal((await f.callAdmin('/api/admin/media/uploads/'+signed.uploadId,{},'DELETE')).status,409);
  assert.equal((await f.callAdmin('/api/admin/products/p1',{image:'https://res.cloudinary.com/test-cloud/image/upload/forged.png'},'PATCH')).status,400);
});

test('Invalid remote metadata, foreign ownership and expired leases cannot attach to records',async t=>{
  const f=await mediaFixture(t);
  for(const overrides of [{bytes:11*1024*1024},{resource_type:'raw'},{format:'svg'},{secure_url:'http://res.cloudinary.com/test-cloud/image/upload/unsafe.png'},{public_id:'unexpected'}]) {
    const upload=await f.upload(overrides);assert.equal((await upload.complete()).status,400);
  }
  const upload=await f.upload(),verified=await upload.complete();
  f.docs.mediaAssets.find(a=>a.id===upload.signed.uploadId).ownerId='another-admin';
  assert.equal((await f.callAdmin('/api/admin/products/p1',{image:verified.data.image},'PATCH')).status,400);
  assert.equal((await upload.complete()).status,404);
});

test('Replacement and removal cover product, category, banners and hero while preserving unchanged local references',async t=>{
  const f=await mediaFixture(t),local='/assets/puraina-mart-logo.png';
  f.docs.categories[0].image=local;f.docs.products[0].image=local;
  assert.equal((await f.callAdmin('/api/admin/categories/pantry',{name:'Updated',image:local},'PATCH')).data.category.image,local);
  const upload=await f.upload(),verified=(await upload.complete()).data;
  for(const route of ['/api/admin/products/p1','/api/admin/categories/pantry'])assert.equal((await f.callAdmin(route,{image:verified.image},'PATCH')).status,200);
  const banner={id:'promotion',title:'Promotion',image:verified.image,enabled:true,action:{type:'none'}};
  const banners=await f.callAdmin('/api/admin/banners',{banners:[banner]},'PATCH');assert.equal(banners.status,200);assert.deepEqual(banners.data.banners[0].imageAsset,verified.imageAsset);
  const removed=await f.callAdmin('/api/admin/banners',{banners:[{...banner,image:'',enabled:false}]},'PATCH');assert.equal(removed.status,200);assert.equal(removed.data.banners[0].imageAsset,null);
  assert.equal((await f.callAdmin('/api/admin/hero-fruit',{image:verified.image},'PATCH')).status,200);
  for(const route of ['/api/admin/products/p1','/api/admin/categories/pantry','/api/admin/hero-fruit'])assert.equal((await f.callAdmin(route,{image:null},'PATCH')).status,200);
  assert.equal((await f.callAdmin('/api/admin/banners',{banners:[]},'PATCH')).status,200);
  assert.ok(f.docs.mediaAssets[0].cleanupAfter);
  f.docs.mediaAssets[0].cleanupAfter='2000-01-01T00:00:00.000Z';
  const destroyed=[];await cleanupMedia(f.application.repo,{destroy:async(_,id)=>destroyed.push(id)});
  assert.deepEqual(destroyed,[verified.imageAsset.public_id]);assert.equal(f.docs.mediaAssets[0].status,'deleted');
});

test('Cleanup protects shared and historical images, retries failures, and never performs remote deletion in a transaction',async t=>{
  const f=await mediaFixture(t),upload=await f.upload(),verified=(await upload.complete()).data;
  await f.callAdmin('/api/admin/products/p1',{image:verified.image},'PATCH');
  f.docs.orders=[{id:'historical',status:'Delivered',items:[{image:verified.image}]}];
  await f.callAdmin('/api/admin/products/p1',{image:null},'PATCH');
  const asset=f.docs.mediaAssets[0];asset.cleanupAfter='2000-01-01T00:00:00.000Z';
  let deletions=0;
  const destroy=async()=>{assert.equal(f.application.repo.context.getStore()?.session,undefined);deletions++;};
  await cleanupMedia(f.application.repo,{destroy});assert.equal(deletions,0);assert.equal(f.docs.mediaAssets[0].status,'attached');
  // A separate abandoned upload is never referenced by the historical order.
  const abandoned=await f.upload();await f.callAdmin('/api/admin/media/uploads/'+abandoned.signed.uploadId,{},'DELETE');
  const row=f.docs.mediaAssets.find(a=>a.id===abandoned.signed.uploadId);assert.equal(row.status,'abandoned');assert.ok(Date.parse(row.cleanupAfter)>Date.now()+3600000);row.cleanupAfter='2000-01-01T00:00:00.000Z';
  await cleanupMedia(f.application.repo,{destroy:async()=>{throw Error('Provider offline');}});
  assert.equal(f.docs.mediaAssets.find(a=>a.id===row.id).status,'deleting');
  f.docs.mediaAssets.find(a=>a.id===row.id).cleanupAfter='2000-01-01T00:00:00.000Z';
  await cleanupMedia(f.application.repo,{destroy});assert.equal(deletions,1);
});

test('Cloudinary missing configuration gives a clear error and transformations preserve local URLs',async t=>{
  const f=await mediaFixture(t);delete process.env.CLOUDINARY_URL;
  const response=await f.callAdmin('/api/admin/media/uploads',{type:'image/png',size:32});assert.equal(response.status,503);assert.match(response.data.error,/Configure Cloudinary/);
  const local='/assets/puraina-mart-logo.png';assert.equal(optimizedImage(local,300),local);
  assert.match(optimizedImage('https://res.cloudinary.com/test-cloud/image/upload/v1/test.png',300),/f_auto,q_auto/);
});
