export function createSerialRequestQueue() {
  let tail = Promise.resolve();
  let depth = 0;

  return {
    get depth() { return depth; },
    enqueue(callback) {
      const enqueuedAt = Date.now();
      depth++;
      const operation = tail.then(async () => {
        const queueWaitMs = Date.now() - enqueuedAt;
        depth = Math.max(0, depth - 1);
        return callback({ queueWaitMs, queueDepthAtStart: depth });
      });
      // Keep a rejected operation from poisoning later work.
      tail = operation.catch(() => {});
      return operation;
    }
  };
}

export function enqueueWithDeadline(queue, callback, { timeoutMs, onTimeout, shouldSkip = () => false } = {}) {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    onTimeout?.();
  }, timeoutMs);
  timer.unref?.();

  const operation = queue.enqueue(async metrics => {
    clearTimeout(timer);
    if (expired || shouldSkip()) return;
    return callback(metrics);
  });
  operation.finally(() => clearTimeout(timer)).catch(() => {});
  return operation;
}
