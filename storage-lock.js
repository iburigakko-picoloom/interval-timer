const INDEXED_DB_STORE = 'mutex';
const indexedDbConnections = new Map();

function mutexFailure(message, cause, taskStarted = false, retryable = false) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.mutexTaskStarted = taskStarted;
  error.mutexRetryable = retryable;
  return error;
}

function openMutexDatabase(indexedDb, databaseName) {
  if (indexedDbConnections.has(databaseName)) return indexedDbConnections.get(databaseName);

  const connection = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDb.open(databaseName, 1);
    } catch (error) {
      reject(mutexFailure('保存ロック用データベースを開けませんでした。', error));
      return;
    }

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(INDEXED_DB_STORE)) {
        request.result.createObjectStore(INDEXED_DB_STORE);
      }
    };
    request.onerror = () => reject(
      mutexFailure('保存ロック用データベースを開けませんでした。', request.error)
    );
    request.onblocked = () => reject(
      mutexFailure('保存ロック用データベースの更新がブロックされました。')
    );
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (indexedDbConnections.get(databaseName) === connection) {
          indexedDbConnections.delete(databaseName);
        }
      };
      resolve(database);
    };
  }).catch((error) => {
    indexedDbConnections.delete(databaseName);
    throw error;
  });

  indexedDbConnections.set(databaseName, connection);
  return connection;
}

async function withIndexedDbMutex(indexedDb, options, task) {
  const databaseName = options?.databaseName || 'interval-timer-storage-lock-v1';
  const lockName = options?.lockName || 'collections';
  const connection = openMutexDatabase(indexedDb, databaseName);
  const database = await connection;

  return new Promise((resolve, reject) => {
    let transaction;
    let taskStarted = false;
    let taskResult;
    let taskError = null;

    try {
      transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
    } catch (error) {
      const retryable = error?.name === 'InvalidStateError';
      if (retryable) {
        database.close();
        if (indexedDbConnections.get(databaseName) === connection) {
          indexedDbConnections.delete(databaseName);
        }
      }
      reject(mutexFailure('保存ロックを開始できませんでした。', error, false, retryable));
      return;
    }

    transaction.oncomplete = () => {
      if (taskError) reject(taskError);
      else resolve(taskResult);
    };
    transaction.onerror = () => {
      if (taskError) reject(taskError);
      else if (taskStarted) resolve(taskResult);
      else reject(mutexFailure('保存ロックの処理に失敗しました。', transaction.error));
    };
    transaction.onabort = () => {
      if (taskError) reject(taskError);
      else if (taskStarted) resolve(taskResult);
      else reject(mutexFailure('保存ロックの処理を中止しました。', transaction.error));
    };

    const store = transaction.objectStore(INDEXED_DB_STORE);
    const request = store.get(lockName);
    request.onerror = () => {
      taskError = mutexFailure('保存ロックを取得できませんでした。', request.error);
    };
    request.onsuccess = () => {
      taskStarted = true;
      try {
        taskResult = task();
        if (taskResult && typeof taskResult.then === 'function') {
          throw new TypeError('保存ロック内の処理は同期処理である必要があります。');
        }
      } catch (error) {
        taskError = mutexFailure('保存ロック内の処理に失敗しました。', error, true);
        try {
          transaction.abort();
        } catch {
          reject(taskError);
        }
      }
    };
  });
}

export async function withCrossTabStorageMutex(indexedDb, options, task) {
  if (typeof task !== 'function') {
    throw new TypeError('保存ロック内の同期処理が必要です。');
  }
  if (Object.prototype.toString.call(task) === '[object AsyncFunction]') {
    throw new TypeError('保存ロック内の処理は同期処理である必要があります。');
  }
  if (!indexedDb?.open) {
    throw new Error('このブラウザでは安全な保存処理を利用できません。');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withIndexedDbMutex(indexedDb, options, task);
    } catch (error) {
      if (attempt === 0 && error?.mutexRetryable && !error?.mutexTaskStarted) continue;
      throw (error?.cause || error);
    }
  }

  throw new Error('保存ロックを開始できませんでした。');
}
