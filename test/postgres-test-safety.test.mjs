import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestTargetSafety } from '../lib/postgres-test-safety.mjs';

const url = 'postgresql://tester:secret@ep-test.neon.tech:5432/zepto_test?sslmode=require';
const base = { POSTGRES_TEST_DATABASE_URL: url, NODE_ENV: 'test', POSTGRES_TEST_CONFIRM_DATABASE: 'zepto_test' };

test('PostgreSQL destructive integration setup requires test environment and exact target confirmation', () => {
  assert.equal(postgresTestTargetSafety({}).enabled, false);
  assert.equal(postgresTestTargetSafety({ ...base, NODE_ENV: 'production' }).enabled, false);
  assert.equal(postgresTestTargetSafety({ ...base, POSTGRES_TEST_CONFIRM_DATABASE: '' }).enabled, false);
  assert.equal(postgresTestTargetSafety({ ...base, POSTGRES_TEST_CONFIRM_DATABASE: 'other_test' }).enabled, false);
  assert.equal(postgresTestTargetSafety({ ...base, POSTGRES_TEST_DATABASE_URL: url.replace('zepto_test', 'zepto_contest') }).enabled, false);
  assert.equal(postgresTestTargetSafety({ ...base, DATABASE_URL: url }).enabled, false);
  assert.deepEqual(postgresTestTargetSafety(base), { enabled: true, databaseName: 'zepto_test', reason: '' });
});
