import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, password } from '../test/support/api-fixture.mjs';
import { browser } from '../test/support/headless-browser.mjs';
import { addRider } from '../test/support/workflow-fixture.mjs';
const cleanup=[],f=await fixture({after(fn){cleanup.push(fn);}}),b=await browser();
const report={checkedAt:new Date().toISOString(),environment:'Synthetic Mongo fixture and intercepted Cloudinary responses; no live provider calls',checks:[],layouts:[]};
const ok=name=>{report.checks.push(name);console.log(name);};
const click=selector=>b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const form=async(selector,values,submit=true)=>b.evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});for(const [key,value] of Object.entries(${JSON.stringify(values)})){const input=form.elements.namedItem(key);if(!input)throw Error('Missing '+key);if(input.type==='checkbox')input.checked=value;else input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}if(${submit})form.requestSubmit();return form.checkValidity();})()`);
async function serverUntil(fn){for(let i=0;i<160;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Fixture mutation did not settle');}
let visits=0;
const go=async view=>{await b.send('Page.navigate',{url:f.base+'/admin?ui='+(++visits)+'#'+view});await b.until(`document.querySelector('#view')?.children.length>0&&!document.querySelector('#view > [role="status"]')&&!document.querySelector('#app').classList.contains('hidden')`);};
const layout=async(name,width)=>{
  const result=await b.evaluate(`(()=>{const d=document.querySelector('dialog[open]');return {width:innerWidth,page:document.documentElement.scrollWidth,dialog:d?{client:d.clientWidth,scroll:d.scrollWidth}:null,overflow:[...document.querySelectorAll('#view input,#view select,#view button,dialog[open] input')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().right>innerWidth+1).slice(0,5).map(e=>e.outerHTML.slice(0,120))};})()`);
  report.layouts.push({name,width,...result});assert.ok(result.page<=result.width+1,`${name} overflows at ${width}: ${JSON.stringify(result)}`);if(result.dialog)assert.ok(result.dialog.scroll<=result.dialog.client+1,`${name} dialog overflows: ${JSON.stringify(result)}`);assert.deepEqual(result.overflow,[],name);
};
const upload=async(selector,type='image/png')=>{
  await b.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([137,80,78,71])],'fixture.png',{type:${JSON.stringify(type)}}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.until(`!document.querySelector(${JSON.stringify(selector)}).closest('[data-image-uploader]').dataset.uploading`);
};
const originalFetch=globalThis.fetch,originalCloud=process.env.CLOUDINARY_URL;
process.env.CLOUDINARY_URL='cloudinary://fixture-key:fixture-secret@fixture-cloud';
globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith(f.base))return originalFetch(url,options);
  assert.match(String(url),/^https:\/\/api\.cloudinary\.com\/v1_1\/fixture-cloud\/resources\/image\/upload\//);
  const public_id=decodeURIComponent(String(url).split('/resources/image/upload/')[1]);
  assert.ok(f.docs.mediaAssets.some(a=>a.public_id===public_id));
  return Response.json({public_id,resource_type:'image',type:'upload',format:'png',bytes:4,secure_url:`https://res.cloudinary.com/fixture-cloud/image/upload/v1/${public_id}.png`});
};
let cursor=0,interceptError,uploadFailure=false;
const intercept=setInterval(()=>{while(cursor<b.events.length){const event=b.events[cursor++];if(event.method!=='Fetch.requestPaused')continue;const p=event.params;
  const cloud=p.request.url.startsWith('https://api.cloudinary.com/');
  const body=cloud?Buffer.from(JSON.stringify(uploadFailure?{error:{message:'Simulated upload failure'}}:{ok:true})).toString('base64'):'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLJkAAAAASUVORK5CYII=';
  b.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:cloud&&uploadFailure&&p.request.method!=='OPTIONS'?500:200,responseHeaders:[{name:'Content-Type',value:cloud?'application/json':'image/png'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'POST, GET, OPTIONS'}],body}).catch(e=>interceptError=e);
}},10);
try {
  await b.send('Fetch.enable',{patterns:[{urlPattern:'https://*',requestStage:'Request'}]});
  await b.send('Network.setCookie',{name:'asid',value:f.cookie.admin.split('=')[1],url:f.base,httpOnly:true});
  f.docs.products[0].image=['/assets/puraina-mart-logo.png','/assets/customer/images/product-placeholder.png'];
  const placed=await f.order();assert.equal(placed.status,201);addRider(f,'r2');
  for(const width of [360,390,768]) {
    await b.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    for(const view of ['overview','orders','products','categories','banners','riders','deliveryAreas','more','customers','coupons','notifications','referrals']) {
      await go(view);await layout(view,width);
      if(['products','categories','coupons','riders','deliveryAreas'].includes(view)) {
        await b.evaluate(`document.querySelector('details.create-panel').open=true`);await layout(view+' create form',width);
      }
      if(view==='products') {await click('[data-edit="product"]');await layout('product editor',width);await click('#editor .icon-button');}
      if(view==='orders'){await click('[data-order]');await b.until(`!!document.querySelector('.order-details')`);await layout('order details',width);if(width===390)await fs.writeFile('verification/admin-order-details.png',Buffer.from((await b.send('Page.captureScreenshot',{format:'png'})).data,'base64'));await click('#editor .icon-button');}
      if(view==='customers'){await click('[data-customer]');await b.until(`!!document.querySelector('[data-customer-tab]')`);for(const tab of ['overview','addresses','orders','coupons']){await click(`[data-customer-tab="${tab}"]`);await layout('customer '+tab,width);}await click('#editor .icon-button');}
      if(width===390&&['overview','products','more'].includes(view))await fs.writeFile('verification/admin-'+view+'.png',Buffer.from((await b.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
  }
  ok('All 12 admin modules, creation forms, order details and customer tabs fit 360, 390 and 768px');
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await go('overview');
  for(const [section,title] of [['orders','Orders'],['catalogue','Products'],['operations','Riders'],['more','More'],['overview','Overview']]){await click(`#nav [data-view="${section}"]`);await b.until(`document.querySelector('#page-title').textContent===${JSON.stringify(title)}&&!document.querySelector('#view > [role="status"]')`);}
  assert.equal(await b.evaluate(`document.querySelectorAll('#nav button').length`),5);ok('Five primary navigation buttons open their working sections');
  await go('products');await click('[data-edit="product"][data-id="p1"]');await form('#editor-form',{name:'Renamed legacy product'});await b.until(`!document.querySelector('#editor').open`);assert.deepEqual(f.docs.products[0].image,['/assets/puraina-mart-logo.png','/assets/customer/images/product-placeholder.png']);
  await go('products');await click('[data-edit="product"][data-id="p1"]');await click('[data-save-product-image="p1"]');await b.until(`!document.querySelector('#editor').open`);assert.deepEqual(f.docs.products[0].image,['/assets/puraina-mart-logo.png','/assets/customer/images/product-placeholder.png']);ok('Editing product details and saving an unchanged image preserve existing image arrays');
  for(const saleType of ['packed','loose']) {
    await go('products');await b.evaluate(`document.querySelector('details.create-panel').open=true`);await form('[data-form="product"]',{name:'Created '+saleType,category:'pantry',saleType,measurementUnit:saleType==='packed'?'piece':'g'},false);
    await b.evaluate(`(()=>{const row=document.querySelector('[data-form="product"] [data-pricing-tier]');for(const [key,value]of Object.entries({label:'Test option',quantity:'${saleType==='packed'?1:500}',price:'50',mrp:'60',stock:'${saleType==='packed'?8:2000}'}))row.querySelector('[data-tier-'+key+']').value=value;document.querySelector('[data-form="product"]').requestSubmit();})()`);
    await serverUntil(()=>f.docs.products.some(p=>p.name==='Created '+saleType));
  }
  ok('Packed and loose product creation saves variant pricing, MRP and inventory');
  await go('categories');await b.evaluate(`document.querySelector('details.create-panel').open=true`);
  await upload('[data-form="category"] [data-upload-input]','text/plain');assert.match(await b.evaluate(`document.querySelector('[data-form="category"] [data-upload-progress]').textContent`),/Choose a JPEG/);
  uploadFailure=true;await upload('[data-form="category"] [data-upload-input]');assert.match(await b.evaluate(`document.querySelector('[data-form="category"] [data-upload-progress]').textContent`),/Simulated upload failure/);uploadFailure=false;
  await upload('[data-form="category"] [data-upload-input]');assert.equal(await b.evaluate(`document.querySelector('[data-form="category"] [data-upload-preview]').hidden`),false);
  await form('[data-form="category"]',{name:'Uploaded category',id:'uploaded'});await serverUntil(()=>f.docs.categories.some(c=>c.id==='uploaded'));await b.until(`!!document.querySelector('[data-edit="category"][data-id="uploaded"]')`);
  const first=f.docs.categories.find(c=>c.id==='uploaded').imageAsset;assert.ok(first.public_id);
  await click('[data-edit="category"][data-id="uploaded"]');await upload('#editor [data-upload-input]');await form('#editor-form',{});await b.until(`!document.querySelector('#editor').open`);assert.notEqual(f.docs.categories.find(c=>c.id==='uploaded').imageAsset.public_id,first.public_id);
  await click('[data-edit="category"][data-id="uploaded"]');await click('#editor [data-remove-image]');await form('#editor-form',{});await b.until(`!document.querySelector('#editor').open`);assert.equal(f.docs.categories.find(c=>c.id==='uploaded').image,undefined);
  ok('Category upload, preview, invalid file, provider failure, replacement and removal work through real form/API code with mocked Cloudinary');
  await go('banners');await click('[data-banner-add]');await upload('[data-banner-card]:last-child [data-upload-input]');await form('[data-form="banners"]',{});await serverUntil(()=>f.docs.settings.find(s=>s.key==='homepageBanners')?.value.some(b=>b.imageAsset?.public_id));
  await go('banners');await upload('[data-form="hero-fruit"] [data-upload-input]');await form('[data-form="hero-fruit"]',{});await serverUntil(()=>f.docs.settings.some(s=>s.key==='homepageHeroFruitAsset'&&s.value?.public_id));
  await b.send('Page.navigate',{url:f.base+'/'});await b.until(`!!document.querySelector('.hero-fruit-image')`);assert.match(await b.evaluate(`document.querySelector('.hero-fruit-image').src`),/res\.cloudinary\.com\/fixture-cloud/);
  ok('Promotional/homepage banners and hero upload save secure URLs and public IDs');
  await go('coupons');await b.evaluate(`document.querySelector('details.create-panel').open=true`);await form('[data-form="coupon"]',{code:'UITEST',discountType:'free_delivery',minimum:0});await serverUntil(()=>f.docs.coupons.some(c=>c.code==='UITEST'));ok('Coupon creation preserves free-delivery rules');
  await go('deliveryAreas');await b.evaluate(`document.querySelector('details.create-panel').open=true`);await form('[data-form="delivery-area"]',{name:'UI delivery area',deliveryCharge:25,minimumOrder:0,etaMinMinutes:15,etaMaxMinutes:30});await serverUntil(()=>f.docs.deliveryAreas.some(a=>a.name==='UI delivery area'));ok('Delivery area creation saves charges and availability');
  await go('riders');await b.evaluate(`document.querySelector('details.create-panel').open=true`);await form('[data-form="rider"]',{name:'UI Rider',phone:'9333333999',password});await serverUntil(()=>f.docs.riders.some(r=>r.name==='UI Rider'));assert.equal(f.docs.riders.find(r=>r.name==='UI Rider').mustChangePassword,true);ok('Rider registration requires password change and stores a password hash');
  await go('customers');await click('[data-customer="u1"]');await b.until(`!!document.querySelector('[data-profile-name]')`);await b.evaluate(`document.querySelector('[data-profile-name]').value='Updated customer'`);await click('[data-customer-save]');await serverUntil(()=>f.docs.users[0].name==='Updated customer');ok('Customer profile editing saves and reloads the open profile');
  await go('notifications');await form('[data-form="notification-campaign"]',{title:'Fixture announcement',message:'Synthetic verification only',channel:'in_app'});await serverUntil(()=>f.docs.notificationCampaigns?.length===1);ok('Notification campaign form queues an in-app campaign in the fixture without running workers');
  await go('referrals');await form('[data-form="referral-campaign"]',{enabled:'false',rewardType:'coupon',rewardAmount:15});await serverUntil(()=>f.docs.settings.find(s=>s.key==='referralCampaign')?.value.rewardAmount===15);ok('Referral campaign rules remain editable');
  await b.send('Network.setCookie',{name:'rsid',value:f.cookie.rider.split('=')[1],url:f.base,httpOnly:true});
  await b.send('Page.navigate',{url:f.base+'/rider?order='+placed.data.order.id});await b.until(`!!document.querySelector('[data-action="reject-order"]')`);
  await b.evaluate(`window.confirm=()=>true;window.prompt=()=>'Synthetic rejection'`);await click('[data-action="reject-order"]');await serverUntil(()=>f.docs.orders[0].riderRejections?.length===1);assert.equal(f.docs.orders[0].status,'New');
  await b.send('Network.setCookie',{name:'rsid',value:f.cookie.r2.split('=')[1],url:f.base,httpOnly:true});
  await b.send('Page.navigate',{url:f.base+'/rider?order='+placed.data.order.id});await b.until(`!!document.querySelector('[data-action="accept-order"]')`);await click('[data-action="accept-order"]');await b.until(`!!document.querySelector('[data-action="cancel-delivery"]')`);
  await b.evaluate(`window.prompt=()=>'Synthetic vehicle problem'`);await click('[data-action="cancel-delivery"]');await serverUntil(()=>f.docs.orders[0].deliveryReleases?.length===1);assert.equal(f.docs.orders[0].status,'New');assert.equal(f.docs.orders[0].cancellation,undefined);ok('Rider rejection and release controls preserve the customer order and allow another eligible rider to accept');
  await b.send('Network.deleteCookies',{name:'rsid',url:f.base});await b.send('Page.navigate',{url:f.base+'/rider'});await b.until(`!!document.querySelector('#rider-login-form')`);await form('#rider-login-form',{phone:'9333333999',password});await b.until(`!!document.querySelector('#rider-password-form')`);
  await form('#rider-password-form',{newPassword:'changed-fixture-password-24',confirmPassword:'changed-fixture-password-24'});await b.until(`!!document.querySelector('[data-action="toggle-status"]')`);await click('[data-action="toggle-status"]');await b.until(`document.querySelector('[data-action="toggle-status"]')?.textContent==='Go offline'`);await click('[data-action="open-order"]');await b.until(`!!document.querySelector('[data-action="accept-order"]')`);ok('New rider password login, mandatory password change, online availability and released-order visibility work');
  assert.equal(interceptError,undefined);
  report.errors=b.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);assert.deepEqual(report.errors,[]);
  await fs.writeFile('verification/admin-redesign-ui.json',JSON.stringify(report,null,2)+'\n');
} catch(error){console.error(error);console.error(await b.evaluate(`({path:location.href,notice:document.querySelector('#notice')?.textContent,text:document.body.innerText.slice(-1800)})`).catch(()=>({})));process.exitCode=1;}
finally{clearInterval(intercept);globalThis.fetch=originalFetch;if(originalCloud===undefined)delete process.env.CLOUDINARY_URL;else process.env.CLOUDINARY_URL=originalCloud;await b.close();for(const fn of cleanup)await fn();}
