import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

// Uses the existing Edge installation and a dedicated disposable profile.
export async function browser() {
  const profile = await fs.mkdtemp(path.resolve('tmp', 'performance-edge-'));
  const executable = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const child = spawn(executable, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { windowsHide:true, stdio:'ignore' });
  let port;
  for (let i=0;i<100;i++) {
    try { port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]); break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!port) { child.kill(); throw new Error('Headless Edge did not start.'); }
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target=targets.find(row=>row.type==='page');
  const ws=new WebSocket(target.webSocketDebuggerUrl); await once(ws,'open');
  let sequence=0; const pending=new Map(), events=[];
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if (message.id) { const cb=pending.get(message.id); pending.delete(message.id); if(message.error) cb?.reject(new Error(message.error.message)); else cb?.resolve(message.result); }
    else events.push(message);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression)=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  return {send,evaluate,events,async until(expression,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Browser condition timed out: '+expression);},async close(){try{await send('Browser.close');}catch{}ws.close();child.kill();}};
}
