import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const assetVersion = source.match(/app\.js\?v=(\d+)/)?.[1];

function workerHarness(options = {}) {
  const listeners = new Map();
  const deleted = [];
  const puts = [];
  const cache = {
    addAll: async () => {},
    put: async (request, response) => {
      puts.push({ request, response });
      if (options.failPut) throw new Error('cache full');
    }
  };

  const context = vm.createContext({
    URL,
    Response,
    fetch: async (request) => options.fetch?.(request) || new Response('network'),
    caches: {
      open: async () => cache,
      keys: async () => options.cacheKeys || [],
      delete: async (key) => {
        deleted.push(key);
        return true;
      },
      match: async (request) => options.match?.(request)
    },
    self: {
      location: { origin: 'https://timer.test' },
      clients: { claim: async () => {} },
      skipWaiting: () => {},
      addEventListener: (name, listener) => listeners.set(name, listener)
    }
  });

  vm.runInContext(source, context, { filename: 'sw.js' });
  return { listeners, deleted, puts };
}

async function dispatchFetch(harness, request) {
  let responsePromise;
  harness.listeners.get('fetch')({
    request,
    respondWith: (promise) => {
      responsePromise = promise;
    }
  });
  assert.ok(responsePromise, 'fetch handler must provide a response');
  return responsePromise;
}

test('activation removes only older interval timer caches', async () => {
  const currentCache = `interval-timer-pwa-v${assetVersion}`;
  const olderCaches = [
    `interval-timer-pwa-v${Number(assetVersion) - 2}`,
    `interval-timer-pwa-v${Number(assetVersion) - 1}`
  ];
  const harness = workerHarness({
    cacheKeys: [...olderCaches, currentCache, 'another-app-v1']
  });
  let activation;
  harness.listeners.get('activate')({ waitUntil: (promise) => { activation = promise; } });
  await activation;

  assert.deepEqual(harness.deleted, olderCaches);
});

test('cached app shell replaces a 5xx navigation response', async () => {
  const harness = workerHarness({
    fetch: async () => new Response('unavailable', { status: 503 }),
    match: async (request) => request === './index.html'
      ? new Response('cached shell')
      : undefined
  });
  const response = await dispatchFetch(harness, {
    method: 'GET',
    mode: 'navigate',
    url: 'https://timer.test/'
  });

  assert.equal(await response.text(), 'cached shell');
});

test('cached asset replaces a 5xx asset response', async () => {
  const request = {
    method: 'GET',
    mode: 'cors',
    url: `https://timer.test/app.js?v=${assetVersion}`
  };
  const harness = workerHarness({
    fetch: async () => new Response('unavailable', { status: 503 }),
    match: async (candidate) => candidate === request
      ? new Response('cached asset')
      : undefined
  });
  const response = await dispatchFetch(harness, request);

  assert.equal(await response.text(), 'cached asset');
});

test('a cache write failure never hides a successful network response', async () => {
  const harness = workerHarness({
    fetch: async () => new Response('fresh asset'),
    failPut: true
  });
  const response = await dispatchFetch(harness, {
    method: 'GET',
    mode: 'cors',
    url: `https://timer.test/styles.css?v=${assetVersion}`
  });

  assert.equal(await response.text(), 'fresh asset');
  assert.equal(harness.puts.length, 1);
});
