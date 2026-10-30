import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePostgresConnectionString } from '../lib/postgres-config.mjs';

test('PostgreSQL legacy SSL aliases become explicit verify-full without dropping URL parameters', () => {
  const normalized = new URL(normalizePostgresConnectionString('postgresql://user:pass@example.invalid/store?sslmode=require&application_name=app'));
  assert.equal(normalized.searchParams.get('sslmode'), 'verify-full');
  assert.equal(normalized.searchParams.get('application_name'), 'app');
  assert.equal(normalized.username, 'user');
  assert.equal(normalized.password, 'pass');
});

test('PostgreSQL connection strings without a legacy SSL alias are unchanged', () => {
  const input = 'postgres://user:pass@example.invalid/store?sslmode=verify-full';
  assert.equal(normalizePostgresConnectionString(input), input);
});

test('non-PostgreSQL connection URLs are rejected', () => {
  assert.throws(() => normalizePostgresConnectionString('https://example.invalid'), /postgres or postgresql/);
});
