const LEGACY_SSL_MODES = new Set(['prefer', 'require', 'verify-ca']);

/**
 * pg-connection-string currently treats these modes as verify-full, but warns
 * that its next major will change their meaning. Make the current TLS behavior
 * explicit while leaving other URL options and credentials untouched.
 */
export function normalizePostgresConnectionString(connectionString) {
  const url = new URL(String(connectionString));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new TypeError('DATABASE_URL must use the postgres or postgresql protocol.');
  }
  const sslmode = url.searchParams.get('sslmode')?.toLowerCase();
  if (LEGACY_SSL_MODES.has(sslmode)) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

export function configurePostgresPool(pool, schemaName = process.env.PG_SCHEMA) {
  if (!schemaName) return pool;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schemaName)) {
    throw new TypeError('PG_SCHEMA must be a simple PostgreSQL schema identifier.');
  }
  const connect = pool.connect.bind(pool);
  const setSchema = client => client.query(`SET search_path TO "${schemaName}", public`);
  pool.connect = callback => {
    if (typeof callback === 'function') {
      return connect((error, client, release) => {
        if (error) return callback(error);
        setSchema(client).then(() => callback(null, client, release), setupError => {
          release(setupError);
          callback(setupError);
        });
      });
    }
    return connect().then(async client => {
      try { await setSchema(client); return client; }
      catch (error) { client.release(error); throw error; }
    });
  };
  return pool;
}
