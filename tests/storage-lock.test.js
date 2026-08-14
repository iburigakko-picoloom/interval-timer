import assert from 'node:assert/strict';
import test from 'node:test';

import { withCrossTabStorageMutex } from '../storage-lock.js';

function fakeIndexedDb({ afterTask = 'complete', invalidStateOnce = false } = {}) {
  let transactionCalls = 0;
  const database = {
    onversionchange: null,
    close() {},
    transaction() {
      transactionCalls += 1;
      if (invalidStateOnce && transactionCalls === 1) {
        const error = new Error('connection closed');
        error.name = 'InvalidStateError';
        throw error;
      }
      const transaction = {
        error: afterTask === 'complete' ? null : new Error('transaction failed'),
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          setTimeout(() => transaction.onabort?.(), 0);
        },
        objectStore() {
          return {
            get() {
              const request = { error: null, onsuccess: null, onerror: null };
              setTimeout(() => {
                request.onsuccess?.();
                setTimeout(() => {
                  if (afterTask === 'error') transaction.onerror?.();
                  else if (afterTask === 'abort') transaction.onabort?.();
                  else transaction.oncomplete?.();
                }, 0);
              }, 0);
              return request;
            }
          };
        }
      };
      return transaction;
    }
  };

  const factory = {
    openCount: 0,
    database,
    open() {
      factory.openCount += 1;
      const request = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null
      };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    }
  };
  return factory;
}

test('IndexedDB mutex runs a synchronous task once and returns its result', async () => {
  let calls = 0;
  const result = await withCrossTabStorageMutex(
    fakeIndexedDb(),
    { databaseName: 'lock-test-success' },
    () => {
      calls += 1;
      return 'saved';
    }
  );

  assert.equal(result, 'saved');
  assert.equal(calls, 1);
});

test('IndexedDB mutex never switches to an unrelated fallback protocol', async () => {
  let calls = 0;
  const unavailableIndexedDb = {
    open() {
      throw new Error('unavailable');
    }
  };

  await assert.rejects(
    withCrossTabStorageMutex(
      unavailableIndexedDb,
      { databaseName: 'lock-test-unavailable' },
      () => {
        calls += 1;
      }
    ),
    /unavailable/
  );
  assert.equal(calls, 0);
});

test('missing IndexedDB fails closed before a storage task starts', async () => {
  let calls = 0;
  await assert.rejects(
    withCrossTabStorageMutex(null, {}, () => {
      calls += 1;
    }),
    /安全な保存処理/
  );
  assert.equal(calls, 0);
});

test('a transaction error after the task does not report a completed save as failed', async () => {
  let calls = 0;
  const result = await withCrossTabStorageMutex(
    fakeIndexedDb({ afterTask: 'error' }),
    { databaseName: 'lock-test-post-task-error' },
    () => {
      calls += 1;
      return { ok: true };
    }
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('async tasks are rejected because the IndexedDB transaction cannot span them safely', async () => {
  let calls = 0;
  await assert.rejects(
    withCrossTabStorageMutex(
      fakeIndexedDb(),
      { databaseName: 'lock-test-async-task' },
      async () => {
        calls += 1;
        return 'not-safe';
      }
    ),
    /同期処理/
  );
  assert.equal(calls, 0);
});

test('a closed cached connection is reopened once before the task starts', async () => {
  const indexedDb = fakeIndexedDb({ invalidStateOnce: true });
  let calls = 0;
  const result = await withCrossTabStorageMutex(
    indexedDb,
    { databaseName: 'lock-test-reopen' },
    () => {
      calls += 1;
      return 'saved';
    }
  );

  assert.equal(result, 'saved');
  assert.equal(calls, 1);
  assert.equal(indexedDb.openCount, 2);
});

test('version changes evict the closed connection from the cache', async () => {
  const indexedDb = fakeIndexedDb();
  const options = { databaseName: 'lock-test-versionchange' };
  await withCrossTabStorageMutex(indexedDb, options, () => 'first');
  indexedDb.database.onversionchange();
  const result = await withCrossTabStorageMutex(indexedDb, options, () => 'second');

  assert.equal(result, 'second');
  assert.equal(indexedDb.openCount, 2);
});
