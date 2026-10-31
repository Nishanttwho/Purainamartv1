import fs from 'node:fs/promises';
import { fixture } from '../test/support/api-fixture.mjs';
import { browser } from '../test/support/headless-browser.mjs';
const label=process.argv[2];
if(!['before','after'].includes(label))throw new Error('Specify before or after');
const cleanup=[]; const f=await fixture({after(fn){cleanup.push(fn);}});
const b=await browser();
const report={label,environment:'Headless Edge, 390x844 mobile viewport, synthetic local Mongo fixture, no production writes',samples:[]};
try{
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,isMobile:true,mobile:true});
  await b.send('Network.setCookie',{name:'sid',value:f.cookie.customer.split('=')[1],url:f.base,httpOnly:true,sameSite:'Lax'});
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__authLabels=[];new MutationObserver(()=>{const n=document.querySelector('#account-label');if(n&&!window.__authLabels.some(x=>x.label===n.textContent))window.__authLabels.push({label:n.textContent,ms:performance.now()});}).observe(document,{subtree:true,childList:true,characterData:true});`});
  for(let i=0;i<3;i++){
    await b.send('Page.navigate',{url:f.base+'/'});
    await b.until(`document.querySelector('.product-card') && document.querySelector('#account-label').textContent==='Customer'`);
    report.samples.push(await b.evaluate(`({authLabels:window.__authLabels,navigation:performance.getEntriesByType('navigation')[0].toJSON(),paint:performance.getEntriesByType('paint').map(x=>x.toJSON()),resources:performance.getEntriesByType('resource').filter(x=>x.name.includes('/api/')||/\\.js$/.test(x.name)).map(x=>({url:new URL(x.name).pathname,ms:x.duration,bytes:x.transferSize}))})`));
  }
  // Observe actual ADD routing with loose products, without assuming the fix.
  await b.evaluate(`document.querySelector('.product-card .product-visual[data-id="loose"] .quick-add').click()`);
  await new Promise(resolve=>setTimeout(resolve,400));
  report.looseAdd=await b.evaluate(`({path:location.pathname,badge:document.querySelector('#cart-badge').textContent,stepper:!!document.querySelector('.product-visual[data-id="loose"] .stepper')})`);
  report.errors=b.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
  await fs.mkdir('performance',{recursive:true});
  await fs.writeFile(`performance/browser-${label}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({label,auth:report.samples.map(x=>x.authLabels),loadMs:report.samples.map(x=>x.navigation.loadEventEnd),looseAdd:report.looseAdd,errors:report.errors}));
}finally{await b.close();for(const fn of cleanup)await fn();}
