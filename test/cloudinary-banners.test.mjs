import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cloudinaryConfig, isCloudinaryImageUrl, signCloudinaryUpload } from '../lib/cloudinary.mjs';
import { defaultHomepageBanners, validateHomepageBanners } from '../lib/homepage-banners.mjs';

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
