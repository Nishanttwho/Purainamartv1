// Only public catalogue GETs are retained, in memory, for this page's lifetime.
export function createApiClient(request) {
  const inFlight = new Map(), cache = new Map();
  let generation = 0;
  function clear() { generation++; cache.clear(); inFlight.clear(); }
  const api = (url, options = {}) => {
    if ((options.method || 'GET').toUpperCase() !== 'GET') {
      clear();
      return request(url, options).finally(clear);
    }
    const path = new URL(url, 'http://localhost').pathname;
    const publicData = /^\/api\/(products(?:\/[^/]+)?|categories|delivery-areas)$/.test(path);
    const hit = cache.get(url);
    if (publicData && hit && hit.expires > Date.now()) return Promise.resolve(structuredClone(hit.value));
    if (inFlight.has(url)) return inFlight.get(url).then(structuredClone);
    const epoch = generation;
    const promise = request(url, options).then(value => {
      if (publicData && generation === epoch) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(url, { value, expires: Date.now() + 15000 });
      }
      return value;
    }).finally(() => { if (inFlight.get(url) === promise) inFlight.delete(url); });
    inFlight.set(url, promise);
    return promise.then(structuredClone);
  };
  api.clear = clear;
  return api;
}
