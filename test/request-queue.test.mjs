import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSerialRequestQueue, enqueueWithDeadline } from '../lib/serial-request-queue.mjs';

test('a queue deadline responds promptly and a timed-out mutation is skipped when it reaches the head', async () => {
  const queue = createSerialRequestQueue();
  let releaseBlocker;
  const blocker = queue.enqueue(() => new Promise(resolve => { releaseBlocker = resolve; }));
  let timedOut = false;
  let mutationRan = false;
  const staleRequest = enqueueWithDeadline(queue, () => { mutationRan = true; }, {
    timeoutMs: 15,
    onTimeout: () => { timedOut = true; },
    shouldSkip: () => false
  });

  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(timedOut, true, 'the request timeout fires while the database operation is still queued');
  assert.equal(mutationRan, false);

  releaseBlocker();
  await Promise.all([blocker, staleRequest]);
  assert.equal(mutationRan, false, 'the expired mutation must not execute after its 503 response');
  assert.equal(queue.depth, 0);
});

test('the serialized queue recovers after a rejected operation and reports queue wait metrics', async () => {
  const queue = createSerialRequestQueue();
  await assert.rejects(queue.enqueue(() => { throw new Error('isolated failure'); }), /isolated failure/);
  const result = await queue.enqueue(metrics => ({ value: 'ready', metrics }));
  assert.equal(result.value, 'ready');
  assert.equal(Number.isFinite(result.metrics.queueWaitMs), true);
  assert.equal(result.metrics.queueDepthAtStart, 0);
});

test('customer and Admin sign-in failures remain visible and controls recover after requests settle', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const [customer, admin] = await Promise.all([
    fs.readFile(path.join(root, 'public', 'app.js'), 'utf8'),
    fs.readFile(path.join(root, 'public', 'admin.js'), 'utf8')
  ]);

  assert.match(customer, /if \(authError\) authError\.textContent = error\.message/);
  assert.match(customer, /finally \{\s*if \(submitButton\?\.isConnected\) \{ submitButton\.disabled = false;/);
  assert.match(customer, /authRequestSucceeded\) renderBootstrapError\(error\)/,
    'a successful login followed by a failed refresh must show a retry state outside the closed modal');

  assert.match(admin, /note\.textContent = error\.message \|\| 'Sign-in could not be completed/);
  assert.match(admin, /finally \{\s*if \(button\?\.isConnected\) \{ button\.disabled = false;/);
  assert.match(admin, /Signed in, but the Admin dashboard could not load:/,
    'a failed dashboard refresh after successful Admin authentication must be visible in the Admin app');
});
