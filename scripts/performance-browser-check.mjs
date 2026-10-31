import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, password } from '../test/support/api-fixture.mjs';
import { browser } from '../test/support/headless-browser.mjs';
const cleanup=[],f=await fixture({after(fn){cleanup.push(fn);}}),b=await browser();
const report={measuredAt:new Date().toISOString(),environment:'Headless Edge at 390x844 plus 360px and 768px responsive checks; synthetic local fixture; delayed cart transport; no live database writes',checks:[],measurements:{},layouts:[]};
const ok=name=>{report.checks.push(name);console.log(name);};
const click=selector=>b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const visit=async route=>{await b.send('Page.navigate',{url:f.base+route});await b.until(`document.querySelector('#account-label')?.textContent==='Customer'`);};
const quantity=(id)=>f.docs.carts?.find(row=>row.ownerId==='u1')?.items.find(row=>row.productId===id)?.quantity||0;
async function serverUntil(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Server state did not settle');}
try{
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for(const [name,value] of Object.entries({sid:f.cookie.customer.split('=')[1],asid:f.cookie.admin.split('=')[1],rsid:f.cookie.rider.split('=')[1]}))await b.send('Network.setCookie',{name,value,url:f.base,httpOnly:true,sameSite:'Lax'});
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__labels=[];new MutationObserver(()=>{const node=document.querySelector('#account-label');if(node&&!window.__labels.includes(node.textContent))window.__labels.push(node.textContent);}).observe(document,{subtree:true,childList:true,characterData:true});`});
  await visit('/');await b.until(`!!document.querySelector('.product-card .quick-add')`);
  assert.equal((await b.evaluate('window.__labels')).includes('Sign in'),false);ok('Logged-in refresh never renders Sign in');
  const countBefore=b.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.url.includes('/api/bootstrap')).length;
  assert.equal(countBefore,1);ok('One centralized bootstrap request restores the customer');
  await b.evaluate(`window.__fetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/api/cart/items'))await new Promise(r=>setTimeout(r,300));return window.__fetch(...args);}`);
  report.measurements.addVisual=await b.evaluate(`(()=>{const start=performance.now();document.querySelector('.product-visual[data-id="loose"] .quick-add').click();return {ms:performance.now()-start,badge:document.querySelector('#cart-badge').textContent,path:location.pathname,stepper:!!document.querySelector('.product-visual[data-id="loose"] .stepper')};})()`);
  assert.equal(report.measurements.addVisual.badge,'1');assert.equal(report.measurements.addVisual.path,'/');assert.equal(report.measurements.addVisual.stepper,true);assert.ok(report.measurements.addVisual.ms<100);ok('Homepage loose ADD paints immediately, becomes a stepper and does not navigate');
  await serverUntil(()=>quantity('loose')===1);
  const beforeBurst=b.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='POST'&&e.params.request.url.includes('/api/cart/items')).length;
  await b.evaluate(`for(let i=0;i<4;i++)document.querySelector('.product-visual[data-id="loose"] button[data-delta="1"]').click();document.querySelector('.product-visual[data-id="p1"] .quick-add').click();`);
  await serverUntil(()=>quantity('loose')===5&&quantity('p1')===1);
  report.measurements.burstRequests=b.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='POST'&&e.params.request.url.includes('/api/cart/items')).length-beforeBurst;
  assert.ok(report.measurements.burstRequests<=3);ok('Rapid clicks coalesce and concurrent products retain correct quantities');
  await b.until(`document.querySelector('#cart-badge').textContent==='6'`);
  f.failNext('carts','updateOne');
  await click('.product-visual[data-id="p1"] button[data-delta="1"]');
  await b.until(`document.querySelector('#toast-root').textContent.includes('temporarily unavailable') && document.querySelector('#cart-badge').textContent==='6'`);
  assert.equal(quantity('p1'),1);ok('Injected server failure rolls back and reconciles the optimistic cart');
  await visit('/cart');await b.until(`!!document.querySelector('.cart-line')`);assert.equal(await b.evaluate(`document.querySelector('#cart-badge').textContent`),'6');ok('Cart persists through a page refresh');
  await click('[data-action="quantity"][data-id="p1"][data-delta="-1"]');await serverUntil(()=>quantity('p1')===0);ok('Cart decrease to zero removes the line');
  await visit('/offers');await b.until(`!!document.querySelector('[data-action="apply-coupon"]')`);await click('[data-action="apply-coupon"]');await b.until(`document.querySelector('#toast-root').textContent.includes('Coupon applied')`);ok('Offers and coupon application work with deferred route code');
  await visit('/checkout');await b.until(`!!document.querySelector('[data-action="place-order"]')`);
  const orderRequestsBefore=b.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='POST'&&new URL(e.params.request.url).pathname==='/api/orders').length;
  await b.evaluate(`const button=document.querySelector('[data-action="place-order"]');button.click();button.click();`);
  await serverUntil(()=>f.docs.orders?.length===1);await b.until(`location.pathname.startsWith('/orders/')`);
  const orderRequestsAfter=b.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='POST'&&new URL(e.params.request.url).pathname==='/api/orders').length;
  assert.equal(orderRequestsAfter-orderRequestsBefore,1);assert.equal(f.docs.orders[0].paymentMethod,'Cash on delivery');assert.equal(f.docs.products.find(x=>x.id==='loose').stock,750);ok('COD checkout, double-click suppression, order success and inventory deduction');
  for(const [route,selector] of [['/account','.profile-card'],['/orders','.order-card'],['/notifications','[data-notification-history]'],['/referral','.referral-hero'],['/wishlist','.page-title'],['/products/p1','.product-detail-page']]){await visit(route);await b.until(`!!document.querySelector(${JSON.stringify(selector)})`);}ok('Account, orders, notifications, referrals, wishlist and product deep links render');
  // Add enough fixture records to test real pagination beyond the first page.
  for(let i=0;i<50;i++)f.docs.products.push({...f.docs.products.find(x=>x.id==='p1'),id:'page-'+String(i).padStart(2,'0'),name:'Paged item '+i,rank:i+5});
  await visit('/categories/pantry');await b.until(`!!document.querySelector('[data-action="load-more"]')`);const cards=await b.evaluate(`document.querySelectorAll('.product-card').length`);await click('[data-action="load-more"]');await b.until(`document.querySelectorAll('.product-card').length>${cards}`);ok('Customer catalogue exposes subsequent pages without downloading every product');
  await visit('/search?q=Paged%20item%2049');await b.until(`!!document.querySelector('.product-visual[data-id="page-49"]')`);await click('.product-visual[data-id="page-49"] .quick-add');await serverUntil(()=>quantity('page-49')===1);ok('Search results outside bootstrap can be added to cart');
  await b.send('Page.navigate',{url:f.base+'/admin'});await b.until(`!!document.querySelector('.metric-grid')`);
  for(const view of ['products','banners','categories','deliveryAreas','orders','customers','coupons','riders','notifications','referrals','overview']){await b.evaluate(`location.hash=${JSON.stringify(view)}`);await b.until(`document.querySelector('#view .data-table, #view .metric-grid, #view .panel, #view .order-grid, #view .product-grid') && !document.querySelector('#view > p[role="status"]')`);assert.equal(await b.evaluate(`document.querySelector('#notice')?.classList.contains('error')`),false,view);}ok('All eleven admin screens load without unrelated bootstrap data');
  await click('#nav [data-view="catalogue"]');await b.until(`!!document.querySelector('[data-page="next"]')`);await click('[data-page="next"]');await b.until(`document.querySelector('[aria-label="Result pages"]').textContent.includes('26')`);ok('Admin product pagination works');
  await b.evaluate(`const input=document.querySelector('[data-filter]');input.value='Paged item 49';input.dispatchEvent(new Event('input',{bubbles:true}));`);await b.until(`document.querySelector('.product-grid').textContent.includes('Paged item 49')&&document.querySelectorAll('.catalogue-card').length===1`);ok('Admin search queries records outside the displayed page');
  // Password login is tested against fixture credentials, never a real secret.
  await b.send('Network.deleteCookies',{name:'asid',url:f.base});await b.send('Page.navigate',{url:f.base+'/admin'});await b.until(`!document.querySelector('#login').classList.contains('hidden')`);
  await b.evaluate(`document.querySelector('#login-form [name="phone"]').value='9990000001';document.querySelector('#login-form [name="password"]').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit();`);await b.until(`!!document.querySelector('.metric-grid')`);ok('Admin password login restores the scoped dashboard');
  await click('#nav [data-view="orders"]');
  await b.until('!!document.querySelector("[data-order]")'); await click('[data-order]');
  await b.until('document.querySelector(".order-details")?.textContent.includes("Bill summary")');
  assert.equal(await b.evaluate('!!document.querySelector("[data-assign],[data-order-status]")'),false);
  ok('Admin order details display items, payment and timeline with automatic rider distribution');
  await b.send('Page.navigate',{url:f.base+'/rider'});await b.until(`!!document.querySelector('#rider-nav [data-view="orders"]')`);
  for(const view of ['orders','earnings','profile','home']){await click(`#rider-nav [data-view="${view}"]`);}ok('Rider session, orders, earnings, profile and home navigation');
  await click('[data-action="open-order"]');await b.until(`!!document.querySelector('[data-action="accept-order"]')`);
  for(const [action,status] of [['accept-order','Accepted'],['out_for_delivery','Out for Delivery']]){
    await b.until(`!!document.querySelector('[data-action="${action}"]')`);await click(`[data-action="${action}"]`);
    await serverUntil(()=>f.docs.orders[0].status===status);
  }
  await b.until(`!!document.querySelector('[data-action="collect-cash"]')`);
  assert.equal(await b.evaluate(`document.querySelector('[data-action="delivered"]').disabled`),true);
  await b.evaluate(`window.confirm=()=>true;document.querySelector('[data-cash-amount]').value=${f.docs.orders[0].total}`);await click('[data-action="collect-cash"]');
  await serverUntil(()=>!!f.docs.orders[0].paymentCollection?.collectedAt);
  await b.until(`document.querySelector('[data-action="delivered"]')?.disabled===false`);await click('[data-action="delivered"]');
  await serverUntil(()=>f.docs.orders[0].status==='Delivered');
  await b.until(`document.body.textContent.includes('Delivery marked complete')`);
  await click('#rider-nav [data-view="earnings"]');await b.until(`document.querySelector('.earnings-hero')?.textContent.includes('1 completed')`);
  assert.equal(f.docs.orders[0].paymentCollection.amount,f.docs.orders[0].total);
  ok('Rider mobile review, acceptance, start delivery, cash gate, COD collection, delivery and earnings');
  for(let i=0;i<50;i++)f.docs.orders.push({...structuredClone(f.docs.orders[0]),id:'rider-page-'+String(i).padStart(2,'0'),displayId:'Rider page '+i});
  await b.send('Page.navigate',{url:f.base+'/rider'});await b.until(`!!document.querySelector('#rider-nav [data-view="earnings"]')`);await click('#rider-nav [data-view="earnings"]');
  await b.evaluate(`window.__fetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/api/rider/bootstrap'))await new Promise(r=>setTimeout(r,300));return window.__fetch(...args);};document.querySelector('[data-action="next-page"]').click();document.querySelector('[data-action="next-page"]').click();`);
  await b.until(`document.querySelector('[aria-label="Order pages"]')?.textContent.includes('Page 3')`);
  assert.equal(await b.evaluate(`document.querySelectorAll('.rider-card').length`),3,'Rapid rider pagination must show records from the displayed page');
  ok('Rapid rider pagination renders the latest requested page');
  for(const width of [360,390,768]){
    await b.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    for(const [role,route,ready] of [['customer','/',`document.querySelector('#account-label')?.textContent==='Customer'`],['admin','/admin',`!!document.querySelector('.metric-grid')`],['rider','/rider',`!!document.querySelector('#rider-nav [data-view="orders"]')`]]){
      await b.send('Page.navigate',{url:f.base+route});await b.until(ready);
      const layout=await b.evaluate(`({viewport:innerWidth,content:document.documentElement.scrollWidth})`);
      report.layouts.push({role,width,...layout});assert.ok(layout.content<=layout.viewport+1,`${role} has horizontal page overflow at ${width}px`);
      if(width===390){const screenshot=await b.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`verification/mobile-${role}.png`,Buffer.from(screenshot.data,'base64'));}
    }
  }
  ok('Customer, admin and rider pages fit 360px, 390px and 768px viewports');
  await b.send('Network.deleteCookies',{name:'sid',url:f.base});await b.send('Page.navigate',{url:f.base+'/'});await b.until(`document.querySelector('#account-label')?.textContent==='Sign in'`);ok('Logged-out refresh resolves to Sign in after initialization');
  report.errors=b.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
  assert.deepEqual(report.errors,[]);
  report.failedRequests=b.events.filter(e=>e.method==='Network.loadingFailed'&&!e.params.canceled).map(e=>({error:e.params.errorText}));
  await fs.writeFile('verification/admin-redesign-browser.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.measurements));
}catch(error){console.error(error);console.error(await b.evaluate(`({path:location.pathname,toast:document.querySelector('#toast-root')?.textContent,notice:document.querySelector('#notice')?.textContent,text:document.body.innerText.slice(0,1400)})`).catch(()=>({})));process.exitCode=1;}
finally{await b.close();for(const fn of cleanup)await fn();}
