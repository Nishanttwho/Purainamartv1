import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root=path.resolve(import.meta.dirname,'..');
let tempDir,storePath,port,child,customerCookie,adminCookie,riderCookie,customerId;
const base=()=>`http://127.0.0.1:${port}`;
async function freePort(){const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const value=listener.address().port;await new Promise(resolve=>listener.close(resolve));return value;}
async function start(){port=await freePort();const env={...process.env,DATABASE_URL:'',POSTGRES_TEST_DATABASE_URL:'',NODE_ENV:'test',APP_TEST_AUTH:'1',PORT:String(port),STORE_PATH:storePath,FCM_PROJECT_ID:'',GOOGLE_APPLICATION_CREDENTIALS:'',FCM_WEB_API_KEY:'',FCM_WEB_AUTH_DOMAIN:'',FCM_WEB_PROJECT_ID:'',FCM_WEB_MESSAGING_SENDER_ID:'',FCM_WEB_APP_ID:'',FCM_WEB_VAPID_KEY:''};child=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const end=Date.now()+12000;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`Isolated notification test server failed: ${output}`);try{if((await fetch(`${base()}/api/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,75));}child.kill();throw new Error(`Isolated notification test server timeout: ${output}`);}
async function stop(){if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2500))]);child=null;}}
async function call(route,{method='GET',body,cookie}={}){const response=await fetch(`${base()}${route}`,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json().catch(()=>({})),cookie:response.headers.get('set-cookie')?.split(';')[0],csp:response.headers.get('content-security-policy')};}
async function otpLogin(endpoint,phone){const challenge=await call(endpoint,{method:'POST',body:{phone}});assert.equal(challenge.status,200);const verified=await call(endpoint.replace('/request-otp','/verify-otp'),{method:'POST',body:{phone,challengeId:challenge.data.challengeId,code:challenge.data.testCode}});assert.equal(verified.status,200,JSON.stringify(verified.data));return verified.cookie;}
before(async()=>{tempDir=await fs.mkdtemp(path.join(os.tmpdir(),'zepto-notification-test-'));storePath=path.join(tempDir,'isolated-store.json');await start();customerCookie=await otpLogin('/api/auth/request-otp','9200000001');adminCookie=await otpLogin('/api/admin/auth/request-otp','9000000001');riderCookie=await otpLogin('/api/rider/auth/request-otp','9000000000');customerId=(await call('/api/bootstrap',{cookie:customerCookie})).data.user.id;});
after(async()=>{await stop();if(tempDir)await fs.rm(tempDir,{recursive:true,force:true});});

test('notification config and CSP work without Firebase secrets; registration and preferences require account sessions',async()=>{
  const config=await call('/api/notifications/config');assert.equal(config.status,200);assert.equal(config.data.enabled,false);assert.equal(config.data.firebase,null);
  assert.match(config.csp,/firebaseinstallations\.googleapis\.com/);assert.match(config.csp,/www\.gstatic\.com/);
  assert.equal((await call('/api/notifications/devices',{method:'POST',body:{fid:'x'.repeat(30),deviceKey:'123e4567-e89b-12d3-a456-426614174000',platform:'web'}})).status,401);
  assert.equal((await call('/api/notifications/preferences',{cookie:customerCookie})).data.preferences.promotions,false);
  const changed=await call('/api/notifications/preferences',{method:'PATCH',cookie:customerCookie,body:{promotions:true}});assert.equal(changed.status,200);assert.equal(changed.data.preferences.promotions,true);
  assert.equal((await call('/api/admin/notifications',{cookie:customerCookie})).status,401);
});

test('authorized browser registration is private, customer-targeted in-app campaigns deduplicate, and rider alerts stay account-scoped',async()=>{
  const fid='test_installation_12345678901234567890',deviceKey='123e4567-e89b-12d3-a456-426614174000';
  const registered=await call('/api/notifications/devices',{method:'POST',cookie:customerCookie,body:{fid,deviceKey,platform:'web',metadata:{language:'en'}}});assert.equal(registered.status,200);
  const adminBootstrap=await call('/api/admin/bootstrap',{cookie:adminCookie});assert.equal(adminBootstrap.status,200);assert.equal(JSON.stringify(adminBootstrap.data).includes(fid),false);
  await call('/api/notifications/preferences',{method:'PATCH',cookie:customerCookie,body:{announcements:false}});
  const suppressedPayload={title:'Preference suppressed notice',message:'This category is disabled.',category:'announcements',channel:'in_app',target:{type:'customer',id:customerId}};
  assert.equal((await call('/api/admin/notifications',{method:'POST',cookie:adminCookie,body:suppressedPayload})).status,202);
  await new Promise(r=>setTimeout(r,350));
  assert.equal((await call('/api/notifications',{cookie:customerCookie})).data.notifications.some(x=>x.title===suppressedPayload.title),false);
  await call('/api/notifications/preferences',{method:'PATCH',cookie:customerCookie,body:{announcements:true}});
  const payload={title:'Isolated test notice',message:'Stored in-app only; this test sends no FCM traffic.',category:'announcements',channel:'in_app',target:{type:'customer',id:customerId},destination:'/#notifications'};
  const queued=await call('/api/admin/notifications',{method:'POST',cookie:adminCookie,body:payload});assert.equal(queued.status,202,JSON.stringify(queued.data));assert.equal(queued.data.estimatedRecipients,1);
  const duplicate=await call('/api/admin/notifications',{method:'POST',cookie:adminCookie,body:payload});assert.equal(duplicate.status,409);
  let customerUpdates=[];for(let i=0;i<40;i++){customerUpdates=(await call('/api/notifications',{cookie:customerCookie})).data.notifications;if(customerUpdates.some(x=>x.title===payload.title))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(customerUpdates.some(x=>x.title===payload.title));
  const riderPayload={...payload,title:'Rider test notice',target:{type:'rider',id:'demo-rider'}};
  const riderQueued=await call('/api/admin/notifications',{method:'POST',cookie:adminCookie,body:riderPayload});assert.equal(riderQueued.status,202,JSON.stringify(riderQueued.data));
  let riderUpdates=[];for(let i=0;i<40;i++){riderUpdates=(await call('/api/rider/notifications',{cookie:riderCookie})).data.notifications;if(riderUpdates.some(x=>x.title===riderPayload.title))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(riderUpdates.some(x=>x.title===riderPayload.title));
  const marked=await call(`/api/rider/notifications/${encodeURIComponent(riderUpdates.find(x=>x.title===riderPayload.title).id)}/read`,{method:'POST',cookie:riderCookie});assert.equal(marked.status,200);
  const schedule={...payload,title:'Scheduled test notice',scheduledAt:new Date(Date.now()+180000).toISOString()};const future=await call('/api/admin/notifications',{method:'POST',cookie:adminCookie,body:schedule});assert.equal(future.status,202);assert.equal(future.data.campaign.status,'scheduled');
  const cancelled=await call(`/api/admin/notifications/campaigns/${encodeURIComponent(future.data.campaign.id)}/cancel`,{method:'POST',cookie:adminCookie,body:{}});assert.equal(cancelled.status,200);assert.equal(cancelled.data.campaign.status,'cancelled');
  assert.equal((await call('/api/notifications/devices/deactivate',{method:'POST',cookie:customerCookie,body:{deviceKey}})).status,200);
  const loggedOut=await call('/api/auth/logout',{method:'POST',cookie:customerCookie,body:{}});assert.equal(loggedOut.status,200);
  const finalAdmin=await call('/api/admin/bootstrap',{cookie:adminCookie});assert.equal(finalAdmin.status,200);assert.equal(finalAdmin.data.notificationCenter.devices.customer,0,'logout deactivates this account browser registration');
});
