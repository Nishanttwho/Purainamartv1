import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { configurePostgresPool, normalizePostgresConnectionString } from '../lib/postgres-config.mjs';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the intended development, test, or production database.');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = path.join(root, 'db', 'migrations');
const pool = configurePostgresPool(new Pool({ connectionString: normalizePostgresConnectionString(process.env.DATABASE_URL), max: 1, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 }));
try {
  const identity = await pool.query('SELECT current_database() AS database, current_user AS role');
  console.log(`Applying explicit schema migration to database "${identity.rows[0].database}" as role "${identity.rows[0].role}".`);
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await fs.readdir(migrationsDirectory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  if (!files.length) throw new Error('No versioned SQL migrations were found.');
  for (const file of files) {
    const version = Number(file.match(/^(\d+)_/)[1]);
    const name = file.replace(/\.sql$/i, '');
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
    if (applied.rowCount) { console.log(`${name} is already applied.`); continue; }
    const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [1718343473]);
      // Recheck under the migration lock so parallel deploys cannot apply the same version twice.
      const locked = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
      if (!locked.rowCount) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version,name) VALUES ($1,$2)', [version, name]);
        await client.query('COMMIT');
        console.log(`Applied ${name}.`);
      } else { await client.query('COMMIT'); console.log(`${name} was applied by another process.`); }
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
} finally { await pool.end(); }
