import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';
const zip = promisify(gzip), brotli = promisify(brotliCompress);
export function acceptedEncoding(header = '') {
  const entries = String(header).split(',').map(part => { const [name, ...params]=part.trim().split(';'); const q=Number(params.find(p=>p.trim().startsWith('q='))?.split('=')[1] ?? 1); return {name:name.trim().toLowerCase(),q:Number.isFinite(q)?q:0}; });
  return ['br','gzip'].map(name=>({name,q:entries.find(x=>x.name===name)?.q ?? entries.find(x=>x.name==='*')?.q ?? 0})).filter(x=>x.q>0).sort((a,b)=>b.q-a.q)[0]?.name || null;
}
export async function compress(data, encoding) {
  return encoding === 'br' ? brotli(data,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}) : zip(data,{level:5});
}
export async function jsonReply(req, res, status, body, headers, started) {
  if (res.writableEnded || res.destroyed) return;
  let data = Buffer.from(JSON.stringify(body));
  const encoding = data.length >= 1024 && !req.url.includes('/auth/') ? acceptedEncoding(req.headers['accept-encoding']) : null;
  if (encoding) { data = await compress(data,encoding); headers['content-encoding']=encoding; }
  headers.vary = 'Accept-Encoding';
  headers['server-timing'] = `app;dur=${(performance.now()-started).toFixed(1)}`;
  headers['content-length'] = data.length;
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status,headers); res.end(req.method === 'HEAD' ? undefined : data);
}
