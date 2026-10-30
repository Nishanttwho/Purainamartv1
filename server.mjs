import path from 'node:path';
import crypto from 'node:crypto';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { initializeMongo, getMongoClient, closeMongo, mongoConnectionOptions } from './lib/mongodb.mjs';
import { isPasswordHash } from './lib/password.mjs';
import { createHttpServer } from './lib/http-server.mjs';

// Startup never imports data or seeds a demo catalogue.
export async function startServer({ env = process.env, initialize = initializeMongo, getClient = getMongoClient, disconnect = closeMongo, logger = console, workers = true } = {}) {
mongoConnectionOptions(env);
const production = env.NODE_ENV === 'production';
if (typeof crypto.argon2 !== 'function' || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24.7 or later in the Node 24 release line.');
if (production && (!/^\d{10}$/.test(env.ADMIN_PHONE || '') || !isPasswordHash(env.ADMIN_PASSWORD_HASH || ''))) throw new Error('Production requires ADMIN_PHONE and a valid ADMIN_PASSWORD_HASH generated with scripts/hash-password.mjs.');
const devHost = env.DEV_HOST || '127.0.0.1';
if (!production && devHost !== '127.0.0.1') {
  const parts = devHost.split('.').map(Number);
  if (!isIPv4(devHost) || !(parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168)) throw new Error('DEV_HOST must be a private IPv4 address.');
}
const port = Number(env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
let server, application;
try {
  const db = await initialize({ env, logger });
  ({ server, application } = createHttpServer({ db, client: await getClient(), publicDir: path.join(import.meta.dirname, 'public'), env, logger, workers }));
  const host = production ? env.HOST || '0.0.0.0' : devHost;
  server.listen(port, host);
  await once(server, 'listening');
  logger.info?.(`PurainaMart listening at http://${host}:${server.address().port} (${production ? 'production' : 'development'}, MongoDB)`);
} catch (error) {
  await application?.close(); await disconnect();
  throw error;
}
let closing;
function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    const force = setTimeout(() => server.closeAllConnections(), 10000); force.unref();
    try { await new Promise(resolve => server.close(resolve)); await application.close(); }
    finally { clearTimeout(force); await disconnect(); }
  })();
  return closing;
}
function onSignal() { void shutdown().catch(error => { logger.error({ event: 'shutdown_failed', name: error.name, code: error.code || 'UNKNOWN' }); process.exitCode = 1; }); }
server.on('error', error => { logger.error({ event: 'http_server_failed', code: error.code || 'UNKNOWN' }); onSignal(); });
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
return { server, application, shutdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startServer(); }
  catch (error) {
    const configurationError = /^(MONGODB_URI|Production requires|Use Node\.js|DEV_HOST|PORT must)/.test(error.message);
    console.error(configurationError ? error.message : 'MongoDB startup failed. Check MONGODB_URI, permissions, network access, and replica-set transaction support.', { name: error.name, code: error.code || 'UNKNOWN' });
    process.exitCode = 1;
  }
}
