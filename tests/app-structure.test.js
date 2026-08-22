import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('HTML ids are unique and every literal app lookup has a matching element', () => {
  const ids = [...index.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id in index.html');

  const lookedUpIds = [...app.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  const missing = [...new Set(lookedUpIds)].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, []);
});

test('forms expose bounded validation instead of silently replacing invalid input', () => {
  for (const id of ['quickWork', 'quickRest', 'quickRepeat', 'menuWork', 'menuRest', 'menuRepeat']) {
    const tag = index.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, 'i'))?.[0] || '';
    assert.match(tag, /\srequired(?:\s|>)/i, `${id} must be required`);
    assert.match(tag, /\smin="1"/i, `${id} must have a visible lower bound`);
    assert.match(tag, /\smax="\d+"/i, `${id} must have a visible upper bound`);
  }

  for (const id of ['quickName', 'menuName', 'comboName']) {
    const tag = index.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, 'i'))?.[0] || '';
    assert.match(tag, /\smaxlength="60"/i, `${id} must bound long names`);
  }
});

test('the deployed app shell uses one matching cache-busting version', () => {
  const styleVersion = index.match(/styles\.css\?v=(\d+)/)?.[1];
  const appVersion = index.match(/app\.js\?v=(\d+)/)?.[1];
  const coreVersion = app.match(/app-core\.js\?v=(\d+)/)?.[1];
  const lockVersion = app.match(/storage-lock\.js\?v=(\d+)/)?.[1];
  const audioVersion = app.match(/audio-player\.js\?v=(\d+)/)?.[1];

  assert.ok(styleVersion);
  assert.equal(appVersion, styleVersion);
  assert.equal(coreVersion, styleVersion);
  assert.equal(lockVersion, styleVersion);
  assert.equal(audioVersion, styleVersion);
  assert.match(worker, new RegExp(`styles\\.css\\?v=${styleVersion}`));
  assert.match(worker, new RegExp(`app\\.js\\?v=${styleVersion}`));
  assert.match(worker, new RegExp(`app-core\\.js\\?v=${styleVersion}`));
  assert.match(worker, new RegExp(`storage-lock\\.js\\?v=${styleVersion}`));
  assert.match(worker, new RegExp(`audio-player\\.js\\?v=${styleVersion}`));
});

test('application logic is externalized and unsafe HTML rendering is absent', () => {
  const scriptTags = [...index.matchAll(/<script\b([^>]*)>/g)];
  assert.equal(scriptTags.length, 1, 'the app shell should not contain inline scripts');
  assert.match(scriptTags[0][1], /\ssrc=/);
  assert.match(index, /<script type="module" src="\.\/app\.js\?v=\d+"><\/script>/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.doesNotMatch(app, /\balert\s*\(/);
});

test('notification sound uses HTML media with a Web Audio fallback', () => {
  assert.match(app, /AudioClass:\s*window\.Audio/);
  assert.match(app, /cuePlayer\.prepare\('ready'\)/);
  assert.match(app, /AudioContextClass:\s*window\.AudioContext\s*\|\|\s*window\.webkitAudioContext/);
  assert.match(app, /mediaParent:\s*document\.body/);
  assert.match(app, /preferWebAudio:\s*\/Android\/i\.test\(navigator\.userAgent\)/);
});

test('timer recovery uses a sleep-aware wall clock and single-tab ownership', () => {
  assert.doesNotMatch(app, /performance\.now\(\)/);
  assert.match(app, /ownerId:\s*TIMER_OWNER_ID/);
  assert.match(app, /event\.key === TIMER_KEY/);
  assert.match(app, /paused:\s*true/);
});

test('legacy v2 storage stays synchronized without bypassing the v3 state lock', () => {
  assert.match(app, /reconcileLegacyV2/);
  assert.match(app, /writeLegacyV2Mirror/);
  assert.match(app, /withCollectionStorageLock\(\(\) => synchronizeStoredCollections/);
  assert.match(
    app,
    /STORE_KEYS\.APP_STATE,\s+STORE_KEYS\.BLOCKS_V2,\s+STORE_KEYS\.COMBOS_V2,\s+STORE_KEYS\.LEGACY_SYNC_V2/
  );
  assert.match(app, /await storageInitialization/);
  assert.match(
    app,
    /const requestedRevision = state\.revision;\s+const requestedFingerprint[\s\S]+await storageInitialization/
  );
  assert.match(app, /withCrossTabStorageMutex/);
  assert.match(app, /result\.mirror\?\.needsReload/);
  assert.match(app, /collectionStateMatches\(synced\.data\)/);
});

test('service worker only removes its own caches and falls back on server errors', () => {
  assert.match(worker, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.doesNotMatch(worker, /keys\.filter\(\(key\) => key !== CACHE_NAME\)/);
  assert.ok(
    (worker.match(/response\.status >= 500/g) || []).length >= 2,
    'navigation and asset requests should both fall back on 5xx responses'
  );
});
