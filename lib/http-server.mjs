import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApplication, securityHeaders } from './application.mjs';
import { acceptedEncoding, compress } from './http-performance.mjs';

const customerRoute = /^\/(?:home|cart|account|referral|referrals|orders(?:\/[A-Za-z0-9_-]+)?|checkout|categories(?:\/[A-Za-z0-9_-]+)?|search|wishlist|offers|notifications|products\/[A-Za-z0-9_-]+|rewards\/[A-Za-z0-9_-]+\/checkout)?\/?$/;
const mime = file => ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.avif': 'image/avif', '.gif': 'image/gif', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
export function createHttpServer(options) {
  const application = createApplication(options), publicDir = path.resolve(options.publicDir), production = options.env?.NODE_ENV === 'production';
  const encodedFiles = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) { void application.handle(req, res); return; }
    for (const [key, value] of Object.entries(securityHeaders(production))) res.setHeader(key, value);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end('Method not allowed'); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); res.end(); return; }
    let requested = pathname;
    if (/^\/rider\/?$/.test(pathname)) requested = '/rider.html';
    else if (/^\/admin\/?$/.test(pathname)) requested = '/admin.html';
    else if (customerRoute.test(pathname)) requested = '/index.html';
    const file = path.resolve(publicDir, '.' + requested);
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    let stat;
    try { stat = await fs.promises.stat(file); if (!stat.isFile()) throw new Error(); }
    catch {
      if (!path.extname(requested)) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); res.end(); return; }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`, lastModified = stat.mtime.toUTCString();
    const asset = requested.startsWith('/assets/'), versioned = asset && /-v\d+\.(?:avif|webp|jpe?g|png)$/i.test(requested);
    const headers = { 'content-type': mime(file), 'content-length': stat.size, 'cache-control': versioned ? 'public, max-age=31536000, immutable' : asset ? 'public, max-age=86400, stale-while-revalidate=604800' : 'no-cache', etag, 'last-modified': lastModified, vary: 'Accept-Encoding' };
    const etags = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim()), since = Date.parse(req.headers['if-modified-since'] || '');
    if (etags.includes('*') || etags.includes(etag) || !req.headers['if-none-match'] && Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) { delete headers['content-length']; res.writeHead(304, headers); res.end(); return; }
    const encoding = stat.size > 1024 && stat.size < 1024*1024 && /\.(?:html|css|js|svg|json)$/.test(file) ? acceptedEncoding(req.headers['accept-encoding']) : null;
    if (encoding) {
      try {
        const key = file+etag+encoding;
        let compressed = encodedFiles.get(key);
        if (!compressed) { compressed=compress(await fs.promises.readFile(file),encoding); if(encodedFiles.size>=32)encodedFiles.delete(encodedFiles.keys().next().value); encodedFiles.set(key,compressed); }
        const data=await compressed;
        headers['content-encoding']=encoding; headers['content-length']=data.length;
        res.writeHead(200,headers); res.end(req.method==='HEAD'?undefined:data); return;
      } catch { res.writeHead(503,{'cache-control':'no-store'});res.end('Asset temporarily unavailable');return; }
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
  });
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return { server, application };
}
