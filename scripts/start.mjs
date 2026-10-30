import { spawn, spawnSync } from 'node:child_process';

if (process.env.DATABASE_URL) {
  console.info('[startup] Applying pending PostgreSQL migrations before starting the app.');
  const migration = spawnSync(process.execPath, ['scripts/migrate-postgres.mjs'], {
    stdio: 'inherit',
    env: process.env
  });
  if (migration.error) {
    console.error('[startup] Could not launch the database migration runner:', migration.error.message);
    process.exit(1);
  }
  if (migration.status !== 0) {
    console.error('[startup] Database migrations failed; the application will not start.');
    process.exit(migration.status ?? 1);
  }
  console.info('[startup] Database schema is up to date.');
} else if (process.env.NODE_ENV === 'production') {
  console.error('[startup] DATABASE_URL is required in production; refusing to start without PostgreSQL.');
  process.exit(1);
}

const server = spawn(process.execPath, ['server.mjs'], {
  stdio: 'inherit',
  env: process.env
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.kill(signal));
}

server.once('error', error => {
  console.error('[startup] Could not launch the application server:', error.message);
  process.exitCode = 1;
});

server.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
