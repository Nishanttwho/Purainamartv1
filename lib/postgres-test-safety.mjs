function identity(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${database}`;
  } catch { return null; }
}

export function postgresTestTargetSafety(env = process.env) {
  const configured = env.POSTGRES_TEST_DATABASE_URL || '';
  if (!configured) return { enabled: false, databaseName: '', reason: 'POSTGRES_TEST_DATABASE_URL is not set.' };
  const testIdentity = identity(configured);
  if (!testIdentity) return { enabled: false, databaseName: '', reason: 'POSTGRES_TEST_DATABASE_URL is not a valid PostgreSQL URL.' };
  const databaseName = decodeURIComponent(new URL(configured).pathname.replace(/^\//, ''));
  if (env.NODE_ENV !== 'test') return { enabled: false, databaseName, reason: 'NODE_ENV must be exactly "test" before the disposable schema is created.' };
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) return { enabled: false, databaseName, reason: 'The database name must contain "test" as a separate token.' };
  if (env.POSTGRES_TEST_CONFIRM_DATABASE !== databaseName) return { enabled: false, databaseName, reason: 'Set POSTGRES_TEST_CONFIRM_DATABASE to the exact disposable database name.' };
  if (env.DATABASE_URL && identity(env.DATABASE_URL) === testIdentity) return { enabled: false, databaseName, reason: 'The disposable test target must differ from DATABASE_URL.' };
  return { enabled: true, databaseName, reason: '' };
}
