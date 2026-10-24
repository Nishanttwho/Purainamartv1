import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { cloudinaryConfig, isCloudinaryImageUrl, signCloudinaryUpload } from '../lib/cloudinary.mjs';
import { defaultHomepageBanners, validateHomepageBanners } from '../lib/homepage-banners.mjs';

const root=path.resolve(import.meta.dirname,'..');let tempDir,port,child,cookie;
const base=()=>`http://127.0.0.1:${port}`;
const json=(route,options={})=>fetch(base()+route,{...options,headers:{...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});
before(async()=>{
  tempDir=await fs.mkdtemp(path.join(os.tmpdir(),'purainamart-banners-'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'test',APP_TEST_AUTH:'1',PORT:String(port),STORE_PATH:path.join(tempDir,'store.json'),DATABASE_URL:'',CLOUDINARY_URL:'',CLOUDINARY_CLOUD_NAME:'',CLOUDINARY_API_KEY:'',CLOUDINARY_API_SECRET:''},stdio:'ignore'});
  const deadline=Date.now()+15000;while(Date.now()<deadline){try{if((await fetch(base()+'/api/health')).ok)return;}catch{}if(child.exitCode!==null)throw new Error('Disposable banner test server exited early');await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Disposable banner test server did not start');
});
after(async()=>{if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);}if(tempDir)await fs.rm(tempDir,{recursive:true,force:true});});

test('Cloudinary settings stay server-side and signatures are generated from canonical signed fields',()=>{
  const config=cloudinaryConfig({CLOUDINARY_URL:'cloudinary://key:secret@my-cloud'});
  assert.deepEqual(config,{cloudName:'my-cloud',apiKey:'key',apiSecret:'secret'});
  assert.equal(cloudinaryConfig({CLOUDINARY_CLOUD_NAME:'name',CLOUDINARY_API_KEY:'key'}),null);
  const signed=signCloudinaryUpload(config,1700000000);
  assert.equal(signed.signature,crypto.createHash('sha1').update('folder=purainamart&timestamp=1700000000secret').digest('hex'));
  assert.equal('apiSecret' in signed,false);
  assert.equal(isCloudinaryImageUrl('https://res.cloudinary.com/my-cloud/image/upload/v123/image.png','my-cloud'),true);
  assert.equal(isCloudinaryImageUrl('http://res.cloudinary.com/my-cloud/image/upload/image.png'),false);
  assert.equal(isCloudinaryImageUrl('https://res.cloudinary.com/other/image/upload/image.png','my-cloud'),false);
});

test('homepage banner validation preserves defaults and rejects unsafe destinations or missing records',()=>{
  const defaults=defaultHomepageBanners();
  const options={isAllowedImage:image=>image.startsWith('/assets/')||isCloudinaryImageUrl(image),products:[{id:'p1',isActive:true}],categories:[{id:'c1',isActive:true}]};
  const valid=validateHomepageBanners([{...defaults[0],action:{type:'product',id:'p1'}},{...defaults[1],order:0,action:{type:'external',url:'https://shop.example/path'}}],options);
  assert.equal(valid.banners[0].order,0);assert.equal(valid.banners[0].action.id,'p1');assert.equal(valid.banners[1].order,1);
  assert.match(validateHomepageBanners([{...defaults[0],action:{type:'external',url:'javascript:alert(1)'}}],options).error,/HTTPS/);
  assert.match(validateHomepageBanners([{...defaults[0],action:{type:'product',id:'missing'}}],options).error,/active product/);
  assert.equal(validateHomepageBanners(defaults,options).banners.length,2);
  assert.equal(validateHomepageBanners([{...defaults[0],action:{type:'category',id:'c1'}}],options).banners[0].action.id,'c1');
  assert.equal(validateHomepageBanners([{...defaults[0],action:{type:'page',page:'categories'}}],options).banners[0].action.page,'categories');
});

test('Admin banner routes require auth, retain valid promotions, reject bad URLs and preserve product pricing on image patch',async()=>{
  const health=await json('/api/health');assert.match(health.headers.get('content-security-policy')||'',/https:\/\/api\.cloudinary\.com/);
  assert.equal((await json('/api/admin/cloudinary/signature')).status,401);
  assert.equal((await json('/api/admin/banners',{method:'PATCH',body:JSON.stringify({banners:[]})})).status,401);
  const start=await json('/api/admin/auth/request-otp',{method:'POST',body:JSON.stringify({phone:'9000000001'})});assert.equal(start.status,200);const challenge=await start.json();
  const verify=await json('/api/admin/auth/verify-otp',{method:'POST',body:JSON.stringify({challengeId:challenge.challengeId,code:'246810'})});assert.equal(verify.status,200);cookie=verify.headers.get('set-cookie').split(';')[0];
  assert.equal((await json('/api/admin/cloudinary/signature',{headers:{cookie}})).status,503,'missing server credentials are reported without contacting Cloudinary');
  const before=await json('/api/admin/bootstrap',{headers:{cookie}}),snapshot=await before.json();
  const current=defaultHomepageBanners().map((row,index)=>({...row,order:index}));
  assert.equal((await json('/api/admin/banners',{method:'PATCH',headers:{cookie},body:JSON.stringify({banners:[{...current[0],action:{type:'external',url:'javascript:alert(1)'}}]})})).status,400);
  const saved=await json('/api/admin/banners',{method:'PATCH',headers:{cookie},body:JSON.stringify({banners:current})});assert.equal(saved.status,200);assert.equal((await saved.json()).banners.length,2);
  const home=await json('/api/bootstrap'),homeData=await home.json();assert.deepEqual(homeData.homepageBanners.map(row=>row.id),['everyday-low-prices','paan-corner']);
  const heroImage='https://res.cloudinary.com/demo/image/upload/v123/purainamart/hero-fruit.png';
  assert.equal((await json('/api/admin/hero-fruit',{method:'PATCH',body:JSON.stringify({image:heroImage})})).status,401,'hero image changes require Admin authentication');
  assert.equal((await json('/api/admin/hero-fruit',{method:'PATCH',headers:{cookie},body:JSON.stringify({image:'https://example.com/not-cloudinary.png'})})).status,400,'untrusted image sources are rejected');
  assert.equal((await json('/api/admin/hero-fruit',{method:'PATCH',headers:{cookie},body:JSON.stringify({image:heroImage})})).status,200);
  assert.equal(JSON.parse(await fs.readFile(path.join(tempDir,'store.json'),'utf8')).homepageHeroFruitImage,heroImage,'hero setting is written to the disposable JSON store for restart persistence');
  assert.equal((await (await json('/api/bootstrap')).json()).homepageHeroFruitImage,heroImage,'saved hero graphic appears in customer bootstrap');
  assert.equal((await (await json('/api/admin/bootstrap',{headers:{cookie}})).json()).homepageHeroFruitImage,heroImage,'saved hero graphic remains in Admin configuration');
  assert.equal((await json('/api/admin/hero-fruit',{method:'PATCH',headers:{cookie},body:JSON.stringify({image:null})})).status,200,'Admin can restore the built-in hero fruit');
  const product=snapshot.products[0];assert.ok(product);
  const image='https://res.cloudinary.com/demo/image/upload/v123/purainamart/test.png';
  const updated=await json(`/api/admin/products/${encodeURIComponent(product.id)}`,{method:'PATCH',headers:{cookie},body:JSON.stringify({image})});assert.equal(updated.status,200);
  const changed=(await updated.json()).product;assert.equal(changed.image,image);assert.equal(changed.price,product.price);assert.equal(changed.stock,product.stock);assert.deepEqual(changed.variants||[],product.variants||[]);
});
