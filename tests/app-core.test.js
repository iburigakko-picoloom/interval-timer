import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  STORE_KEYS,
  advanceTimerSnapshot,
  buildTimerSteps,
  createComboItem,
  loadAppState,
  loadNumberPreference,
  normalizeBlock,
  normalizeTimerSnapshot,
  reconcileLegacyV2,
  saveAppState,
  savePreference,
  writeLegacyV2Mirror
} from '../app-core.js';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries).map(([key, value]) => [key, String(value)]));
    this.failReads = false;
    this.failWrites = false;
    this.failWriteKeys = new Set();
  }

  getItem(key) {
    if (this.failReads) throw new Error('read denied');
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failWrites || this.failWriteKeys.has(key)) throw new Error('quota exceeded');
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.failWrites || this.failWriteKeys.has(key)) throw new Error('quota exceeded');
    this.values.delete(key);
  }

  keys() {
    return [...this.values.keys()];
  }
}

const validBlock = (overrides = {}) => ({
  id: 'menu-a',
  name: 'スクワット',
  work: 30,
  rest: 15,
  repeat: 4,
  ...overrides
});

function seedV3State(storage) {
  const block = validBlock();
  const item = createComboItem(block);
  const saved = saveAppState(storage, {
    version: 3,
    revision: 0,
    blocks: [block],
    combos: [{ id: 'combo-a', name: '朝', items: [item] }]
  }, 0);
  assert.equal(saved.ok, true);
  return saved;
}

test('v2 data migrates to a v3 envelope with snapshot combo items', () => {
  const block = validBlock();
  const storage = new MemoryStorage({
    [STORE_KEYS.BLOCKS_V2]: JSON.stringify([block]),
    [STORE_KEYS.COMBOS_V2]: JSON.stringify([
      { id: 'combo-a', name: '朝', blocks: [block, block] }
    ])
  });

  const loaded = loadAppState(storage);

  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'v2');
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.data.version, 3);
  assert.equal(loaded.data.revision, 0);
  assert.equal(loaded.data.combos[0].items.length, 2);
  assert.equal(loaded.data.combos[0].items[0].sourceId, 'menu-a');
  assert.notEqual(loaded.data.combos[0].items[0].id, 'menu-a');
  assert.notEqual(loaded.data.combos[0].items[0].id, loaded.data.combos[0].items[1].id);
});

test('v1 data is used when v2 is absent', () => {
  const storage = new MemoryStorage({
    [STORE_KEYS.BLOCKS_V1]: JSON.stringify([validBlock()]),
    [STORE_KEYS.COMBOS_V1]: JSON.stringify([])
  });

  const loaded = loadAppState(storage);

  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'v1');
  assert.equal(loaded.data.blocks.length, 1);
});

test('missing or malformed v2 collections fall back independently to v1', () => {
  const storage = new MemoryStorage({
    [STORE_KEYS.BLOCKS_V2]: '{broken',
    [STORE_KEYS.COMBOS_V2]: JSON.stringify([]),
    [STORE_KEYS.BLOCKS_V1]: JSON.stringify([validBlock()]),
    [STORE_KEYS.COMBOS_V1]: JSON.stringify([
      { id: 'old-combo', name: '古い組み合わせ', blocks: [validBlock()] }
    ])
  });

  const loaded = loadAppState(storage);

  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'v2');
  assert.deepEqual(loaded.legacySources, { blocks: 'v1', combos: 'v2' });
  assert.equal(loaded.data.blocks.length, 1);
  assert.equal(loaded.data.combos.length, 0);
});

test('invalid fields are repaired, invalid records discarded, and limits enforced', () => {
  const longName = '長'.repeat(LIMITS.MAX_NAME_LENGTH + 20);
  const blocks = [
    null,
    validBlock({ id: '', name: longName, work: -1, rest: 999999, repeat: 'bad' })
  ];

  for (let index = 0; index < LIMITS.MAX_BLOCKS + 20; index += 1) {
    blocks.push(validBlock({ id: `extra-${index}` }));
  }

  const raw = JSON.stringify({
    version: 3,
    revision: 2,
    updatedAt: 'invalid-date',
    blocks,
    combos: []
  });
  const storage = new MemoryStorage({ [STORE_KEYS.APP_STATE]: raw });

  const loaded = loadAppState(storage);

  assert.equal(loaded.ok, true);
  assert.equal(loaded.repaired, true);
  assert.equal(loaded.data.blocks.length, LIMITS.MAX_BLOCKS);
  assert.equal(loaded.data.blocks[0].name.length, LIMITS.MAX_NAME_LENGTH);
  assert.equal(loaded.data.blocks[0].work, 30);
  assert.equal(loaded.data.blocks[0].rest, LIMITS.MAX_SECONDS);
  assert.equal(loaded.data.blocks[0].repeat, 4);
  assert.equal(storage.getItem(loaded.backupKey), raw);
});

test('combo and combo-item limits count retained records, not discarded records', () => {
  const block = validBlock();
  const manyItems = [
    null,
    ...Array.from(
      { length: LIMITS.MAX_COMBO_ITEMS },
      () => createComboItem(block)
    )
  ];
  const combos = [
    null,
    {
      id: 'combo-0',
      name: '先頭',
      items: manyItems
    },
    ...Array.from({ length: LIMITS.MAX_COMBOS - 1 }, (_, index) => ({
      id: `combo-${index + 1}`,
      name: `組み合わせ ${index + 1}`,
      items: [createComboItem(block)]
    }))
  ];
  const storage = new MemoryStorage({
    [STORE_KEYS.APP_STATE]: JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: new Date().toISOString(),
      blocks: [block],
      combos
    })
  });

  const loaded = loadAppState(storage);

  assert.equal(loaded.data.combos.length, LIMITS.MAX_COMBOS);
  assert.equal(loaded.data.combos[0].items.length, LIMITS.MAX_COMBO_ITEMS);
});

test('duplicate block, combo, and combo item IDs are made unique', () => {
  const item = createComboItem(validBlock());
  const raw = JSON.stringify({
    version: 3,
    revision: 1,
    updatedAt: new Date().toISOString(),
    blocks: [validBlock(), validBlock({ name: 'ランジ' })],
    combos: [
      { id: 'combo-a', name: 'A', items: [item, { ...item }] },
      { id: 'combo-a', name: 'B', items: [{ ...item, id: 'another-item' }] }
    ]
  });
  const loaded = loadAppState(new MemoryStorage({ [STORE_KEYS.APP_STATE]: raw }));

  assert.equal(new Set(loaded.data.blocks.map((block) => block.id)).size, 2);
  assert.equal(new Set(loaded.data.combos.map((combo) => combo.id)).size, 2);
  const itemIds = loaded.data.combos.flatMap((combo) => combo.items.map((entry) => entry.id));
  assert.equal(new Set(itemIds).size, itemIds.length);
});

test('whitespace-normalized IDs are reported and raw v3 is backed up', () => {
  const item = createComboItem(validBlock());
  const raw = JSON.stringify({
    version: 3,
    revision: 1,
    updatedAt: new Date().toISOString(),
    blocks: [validBlock({ id: ' menu-a ' })],
    combos: [{
      id: ' combo-a ',
      name: 'A',
      items: [{ ...item, id: ' item-a ', sourceId: ' menu-a ' }]
    }]
  });
  const storage = new MemoryStorage({ [STORE_KEYS.APP_STATE]: raw });

  const loaded = loadAppState(storage);

  assert.equal(loaded.repaired, true);
  assert.ok(loaded.backupKey);
  assert.equal(loaded.data.blocks[0].id, 'menu-a');
  assert.equal(loaded.data.combos[0].id, 'combo-a');
  assert.equal(loaded.data.combos[0].items[0].id, 'item-a');
  assert.equal(loaded.data.combos[0].items[0].sourceId, 'menu-a');
});

test('corrupt v3 raw data is backed up before legacy recovery', () => {
  const corruptRaw = '{not-json';
  const storage = new MemoryStorage({
    [STORE_KEYS.APP_STATE]: corruptRaw,
    [STORE_KEYS.BLOCKS_V2]: JSON.stringify([validBlock()]),
    [STORE_KEYS.COMBOS_V2]: JSON.stringify([])
  });

  const loaded = loadAppState(storage);

  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'v2');
  assert.equal(loaded.recoveredFromCorruptV3, true);
  assert.match(loaded.backupKey, new RegExp(`^${STORE_KEYS.CORRUPT_BACKUP_PREFIX}`));
  assert.equal(storage.getItem(loaded.backupKey), corruptRaw);
});

test('corrupt v3 is never replaced when its raw backup cannot be written', () => {
  const corruptRaw = '{not-json';
  const storage = new MemoryStorage({ [STORE_KEYS.APP_STATE]: corruptRaw });
  storage.failWrites = true;

  const loaded = loadAppState(storage);

  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'BACKUP_FAILED');
  assert.equal(storage.getItem(STORE_KEYS.APP_STATE), corruptRaw);
});

test('save failure is returned without throwing', () => {
  const storage = new MemoryStorage();
  storage.failWrites = true;

  const result = saveAppState(
    storage,
    { version: 3, revision: 0, updatedAt: null, blocks: [validBlock()], combos: [] },
    0
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'WRITE_FAILED');
  assert.match(result.error, /quota exceeded/);
});

test('stale revision returns a conflict and does not overwrite current data', () => {
  const storage = new MemoryStorage();
  const first = saveAppState(
    storage,
    { version: 3, revision: 0, updatedAt: null, blocks: [validBlock()], combos: [] },
    0
  );
  const storedAfterFirst = storage.getItem(STORE_KEYS.APP_STATE);
  const stale = saveAppState(
    storage,
    { ...first.data, blocks: [validBlock({ name: '上書き' })] },
    0
  );

  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal(stale.actualRevision, 1);
  assert.equal(storage.getItem(STORE_KEYS.APP_STATE), storedAfterFirst);
});

test('v3 state is mirrored with the legacy v2 combo blocks schema and a marker', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);

  const mirrored = writeLegacyV2Mirror(storage, saved.data);
  const legacyBlocks = JSON.parse(storage.getItem(STORE_KEYS.BLOCKS_V2));
  const legacyCombos = JSON.parse(storage.getItem(STORE_KEYS.COMBOS_V2));
  const marker = JSON.parse(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2));

  assert.equal(mirrored.ok, true);
  assert.deepEqual(mirrored.writes, { blocks: true, combos: true, marker: true });
  assert.deepEqual(legacyBlocks, [validBlock()]);
  assert.equal('items' in legacyCombos[0], false);
  assert.equal(Array.isArray(legacyCombos[0].blocks), true);
  assert.equal(legacyCombos[0].blocks[0].id, 'menu-a');
  assert.equal(marker.v3Revision, saved.data.revision);
  assert.equal(marker.fingerprints.blocks.algorithm, 'fnv1a64-utf16');

  const unchanged = reconcileLegacyV2(storage, saved.data);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.code, 'LEGACY_V2_UNCHANGED');
});

test('unmarked legacy data is preserved unless destructive initialization is explicit', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);
  const oldBlocksRaw = JSON.stringify([validBlock({ name: '旧タブだけの変更' })]);
  const oldCombosRaw = JSON.stringify([{
    id: 'old-combo',
    name: '旧タブだけの組み合わせ',
    blocks: [validBlock({ name: '旧タブだけの変更' })]
  }]);
  storage.setItem(STORE_KEYS.BLOCKS_V2, oldBlocksRaw);
  storage.setItem(STORE_KEYS.COMBOS_V2, oldCombosRaw);

  const refused = writeLegacyV2Mirror(storage, saved.data);

  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'LEGACY_UNMARKED_V2_DATA');
  assert.deepEqual(refused.pendingCollections, ['blocks', 'combos']);
  assert.equal(refused.requiresInitialization, true);
  assert.deepEqual(refused.writes, { blocks: false, combos: false, marker: false });
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), oldBlocksRaw);
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), oldCombosRaw);
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), null);

  const initialized = writeLegacyV2Mirror(
    storage,
    saved.data,
    { allowUnmarkedOverwrite: true }
  );
  assert.equal(initialized.ok, true);
  assert.deepEqual(JSON.parse(storage.getItem(STORE_KEYS.BLOCKS_V2)), saved.data.blocks);
});

test('legacy mirroring rejects invalid input without erasing existing v2 data', () => {
  const blocksRaw = JSON.stringify([validBlock({ name: '保持するメニュー' })]);
  const combosRaw = JSON.stringify([]);
  const storage = new MemoryStorage({
    [STORE_KEYS.BLOCKS_V2]: blocksRaw,
    [STORE_KEYS.COMBOS_V2]: combosRaw
  });

  const mirrored = writeLegacyV2Mirror(storage, undefined);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'INVALID_CURRENT_STATE');
  assert.deepEqual(mirrored.writes, { blocks: false, combos: false, marker: false });
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), blocksRaw);
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), combosRaw);
});

test('a same-revision fork cannot be mirrored over the actual stored v3 state', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);
  const fork = {
    ...saved.data,
    blocks: [validBlock({ name: '保存されていない分岐' })]
  };

  const mirrored = writeLegacyV2Mirror(storage, fork);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'APP_STATE_MISMATCH');
  assert.deepEqual(mirrored.writes, { blocks: false, combos: false, marker: false });
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), null);
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), null);
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), null);
});

test('detached combo snapshots never reuse a real block id in the v2 projection', () => {
  const storage = new MemoryStorage();
  const block = validBlock({ id: 'shared-id' });
  const saved = saveAppState(storage, {
    version: 3,
    revision: 0,
    updatedAt: null,
    blocks: [block],
    combos: [{
      id: 'combo-a',
      name: '独立スナップショット',
      items: [{
        id: 'shared-id',
        sourceId: null,
        name: '独立メニュー',
        work: 20,
        rest: 10,
        repeat: 2
      }]
    }]
  }, 0);
  assert.equal(saved.ok, true);

  const mirrored = writeLegacyV2Mirror(storage, saved.data);
  const legacyItem = JSON.parse(storage.getItem(STORE_KEYS.COMBOS_V2))[0].blocks[0];

  assert.equal(mirrored.ok, true);
  assert.notEqual(legacyItem.id, block.id);
  assert.match(legacyItem.id, /^orphan_[0-9a-f]{16}/);
});

test('legacy reconciliation imports only a changed blocks collection', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, saved.data).ok, true);

  storage.setItem(STORE_KEYS.BLOCKS_V2, JSON.stringify([
    validBlock({ name: '旧タブで更新', work: 45 }),
    validBlock({ id: 'menu-b', name: 'ランジ' })
  ]));
  const v3BeforeReconcile = storage.getItem(STORE_KEYS.APP_STATE);
  const reconciled = reconcileLegacyV2(storage, saved.data);

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.changed, true);
  assert.deepEqual(reconciled.changedCollections, ['blocks']);
  assert.equal(reconciled.data.blocks.length, 2);
  assert.equal(reconciled.data.blocks[0].name, '旧タブで更新');
  assert.deepEqual(reconciled.data.combos, saved.data.combos);
  assert.equal(reconciled.data.revision, saved.data.revision);
  assert.equal(storage.getItem(STORE_KEYS.APP_STATE), v3BeforeReconcile);

  const committed = saveAppState(
    storage,
    reconciled.data,
    reconciled.data.revision
  );
  assert.equal(committed.ok, true);
  assert.equal(writeLegacyV2Mirror(storage, committed.data).ok, true);
  assert.equal(reconcileLegacyV2(storage, committed.data).code, 'LEGACY_V2_UNCHANGED');
});

test('legacy reconciliation imports old combo blocks as independent snapshot items', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, saved.data).ok, true);

  storage.setItem(STORE_KEYS.COMBOS_V2, JSON.stringify([{
    id: 'combo-old',
    name: '旧タブの組み合わせ',
    blocks: [validBlock(), validBlock()]
  }]));
  const reconciled = reconcileLegacyV2(storage, saved.data);

  assert.equal(reconciled.ok, true);
  assert.deepEqual(reconciled.changedCollections, ['combos']);
  assert.deepEqual(reconciled.data.blocks, saved.data.blocks);
  assert.equal(reconciled.data.combos[0].items.length, 2);
  assert.equal(reconciled.data.combos[0].items[0].sourceId, 'menu-a');
  assert.notEqual(reconciled.data.combos[0].items[0].id, 'menu-a');
  assert.notEqual(
    reconciled.data.combos[0].items[0].id,
    reconciled.data.combos[0].items[1].id
  );
});

test('legacy reconciliation rejects a mixed snapshot when both v2 collections change mid-read', () => {
  class ReconcileRacingStorage extends MemoryStorage {
    getItem(key) {
      const value = super.getItem(key);
      if (this.raceEnabled && !this.raced && key === STORE_KEYS.BLOCKS_V2) {
        this.raced = true;
        this.values.set(STORE_KEYS.BLOCKS_V2, this.nextBlocksRaw);
        this.values.set(STORE_KEYS.COMBOS_V2, this.nextCombosRaw);
      }
      return value;
    }
  }

  const storage = new ReconcileRacingStorage();
  const saved = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, saved.data).ok, true);
  const nextBlock = validBlock({ id: 'menu-new', name: '同時更新メニュー' });
  storage.nextBlocksRaw = JSON.stringify([nextBlock]);
  storage.nextCombosRaw = JSON.stringify([{
    id: 'combo-new',
    name: '同時更新の組み合わせ',
    blocks: [nextBlock]
  }]);
  storage.raceEnabled = true;

  const raced = reconcileLegacyV2(storage, saved.data);

  assert.equal(raced.ok, false);
  assert.equal(raced.code, 'RECONCILE_RACE');
  assert.equal(raced.needsReconciliation, true);
  assert.deepEqual(raced.data, saved.data);
  assert.deepEqual(raced.changedCollections, []);

  storage.raceEnabled = false;
  const retried = reconcileLegacyV2(storage, saved.data);
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.changedCollections, ['blocks', 'combos']);
  assert.equal(retried.data.blocks[0].name, '同時更新メニュー');
  assert.equal(retried.data.combos[0].items[0].sourceId, 'menu-new');
});

test('missing or stale sync markers never roll current v3 state back', () => {
  const noMarkerStorage = new MemoryStorage();
  const initial = seedV3State(noMarkerStorage);
  noMarkerStorage.setItem(STORE_KEYS.BLOCKS_V2, JSON.stringify([]));

  const noMarker = reconcileLegacyV2(noMarkerStorage, initial.data);
  assert.equal(noMarker.ok, true);
  assert.equal(noMarker.code, 'LEGACY_SYNC_MARKER_MISSING');
  assert.equal(noMarker.needsMirror, true);
  assert.deepEqual(noMarker.data, initial.data);

  const storage = new MemoryStorage();
  const first = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, first.data).ok, true);
  const second = saveAppState(storage, {
    ...first.data,
    blocks: [...first.data.blocks, validBlock({ id: 'menu-new', name: '新しいv3メニュー' })]
  }, first.data.revision);
  assert.equal(second.ok, true);
  storage.setItem(
    STORE_KEYS.BLOCKS_V2,
    JSON.stringify([validBlock({ name: '古いv2側の変更' })])
  );

  const stale = reconcileLegacyV2(storage, second.data);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'LEGACY_SYNC_MARKER_STALE');
  assert.equal(stale.needsMirror, true);
  assert.deepEqual(stale.data, second.data);
});

test('corrupt markers and legacy collections are explicit and preserve v3 data', () => {
  const markerStorage = new MemoryStorage();
  const markerState = seedV3State(markerStorage);
  assert.equal(writeLegacyV2Mirror(markerStorage, markerState.data).ok, true);
  markerStorage.setItem(STORE_KEYS.LEGACY_SYNC_V2, '{broken');
  markerStorage.setItem(STORE_KEYS.BLOCKS_V2, JSON.stringify([]));

  const corruptMarker = reconcileLegacyV2(markerStorage, markerState.data);
  assert.equal(corruptMarker.ok, false);
  assert.equal(corruptMarker.code, 'LEGACY_SYNC_MARKER_CORRUPT');
  assert.deepEqual(corruptMarker.data, markerState.data);
  const refusedMirror = writeLegacyV2Mirror(markerStorage, markerState.data);
  assert.equal(refusedMirror.ok, false);
  assert.equal(refusedMirror.code, 'LEGACY_SYNC_MARKER_CORRUPT');
  assert.deepEqual(JSON.parse(markerStorage.getItem(STORE_KEYS.BLOCKS_V2)), []);

  const legacyStorage = new MemoryStorage();
  const legacyState = seedV3State(legacyStorage);
  assert.equal(writeLegacyV2Mirror(legacyStorage, legacyState.data).ok, true);
  legacyStorage.setItem(STORE_KEYS.COMBOS_V2, '{broken');

  const corruptLegacy = reconcileLegacyV2(legacyStorage, legacyState.data);
  assert.equal(corruptLegacy.ok, false);
  assert.equal(corruptLegacy.code, 'LEGACY_V2_CORRUPT');
  assert.deepEqual(corruptLegacy.data, legacyState.data);
});

test('unusable nonempty legacy collections cannot erase current v3 data', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, saved.data).ok, true);
  storage.setItem(STORE_KEYS.BLOCKS_V2, JSON.stringify([null, 'broken']));

  const reconciled = reconcileLegacyV2(storage, saved.data);
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.code, 'LEGACY_V2_BLOCKS_UNUSABLE');
  assert.deepEqual(reconciled.data, saved.data);
});

test('partial legacy mirror failures never advance the synchronization marker', () => {
  const storage = new MemoryStorage();
  const first = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, first.data).ok, true);
  const originalMarker = storage.getItem(STORE_KEYS.LEGACY_SYNC_V2);
  const originalBlocks = storage.getItem(STORE_KEYS.BLOCKS_V2);
  const originalCombos = storage.getItem(STORE_KEYS.COMBOS_V2);
  const second = saveAppState(storage, {
    ...first.data,
    blocks: [...first.data.blocks, validBlock({ id: 'menu-b', name: '追加' })]
  }, first.data.revision);
  assert.equal(second.ok, true);

  storage.failWriteKeys.add(STORE_KEYS.COMBOS_V2);
  const mirrored = writeLegacyV2Mirror(storage, second.data);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'LEGACY_MIRROR_WRITE_FAILED');
  assert.deepEqual(mirrored.writes, { blocks: true, combos: false, marker: false });
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), originalMarker);
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), originalBlocks);
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), originalCombos);
  assert.match(mirrored.backupKey, new RegExp(`^${STORE_KEYS.LEGACY_SYNC_BACKUP_PREFIX}`));
  assert.equal(mirrored.recovery.blocks.status, 'restored');
  assert.equal(mirrored.recovery.combos.status, 'unchanged');
});

test('a marker write failure is explicit even after both legacy collections are written', () => {
  const storage = new MemoryStorage();
  const saved = seedV3State(storage);
  storage.failWriteKeys.add(STORE_KEYS.LEGACY_SYNC_V2);

  const mirrored = writeLegacyV2Mirror(storage, saved.data);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'LEGACY_SYNC_MARKER_WRITE_FAILED');
  assert.deepEqual(mirrored.writes, { blocks: true, combos: true, marker: false });
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), null);
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), null);
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), null);
  assert.match(mirrored.backupKey, new RegExp(`^${STORE_KEYS.LEGACY_SYNC_BACKUP_PREFIX}`));
  const backup = JSON.parse(storage.getItem(mirrored.backupKey));
  assert.equal(backup.before.blocksRaw, null);
  assert.equal(Array.isArray(JSON.parse(backup.after.blocksRaw)), true);
  assert.equal(mirrored.recovery.blocks.status, 'restored');
  assert.equal(mirrored.recovery.combos.status, 'restored');
  assert.equal(mirrored.recovery.marker.status, 'unchanged');
});

test('a v3 save cannot overwrite pending changes from an old v2 tab', () => {
  const storage = new MemoryStorage();
  const first = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, first.data).ok, true);
  const oldTabBlocks = JSON.stringify([validBlock({ name: '旧タブの未取り込み変更' })]);
  storage.setItem(STORE_KEYS.BLOCKS_V2, oldTabBlocks);
  const originalMarker = storage.getItem(STORE_KEYS.LEGACY_SYNC_V2);

  const second = saveAppState(storage, {
    ...first.data,
    combos: [{ ...first.data.combos[0], name: '新タブの変更' }]
  }, first.data.revision);
  assert.equal(second.ok, true);
  const mirrored = writeLegacyV2Mirror(storage, second.data);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'LEGACY_V2_CHANGES_PENDING');
  assert.deepEqual(mirrored.pendingCollections, ['blocks']);
  assert.deepEqual(mirrored.writes, { blocks: false, combos: false, marker: false });
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), oldTabBlocks);
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), originalMarker);
});

test('a concurrent v2 write during mirror verification is reported without marking it synced', () => {
  class RacingStorage extends MemoryStorage {
    setItem(key, value) {
      super.setItem(key, value);
      if (this.raceEnabled && key === STORE_KEYS.COMBOS_V2) {
        this.values.set(
          STORE_KEYS.BLOCKS_V2,
          JSON.stringify([validBlock({ name: '旧タブの同時変更' })])
        );
      }
    }
  }

  const storage = new RacingStorage();
  const saved = seedV3State(storage);
  storage.raceEnabled = true;
  const mirrored = writeLegacyV2Mirror(storage, saved.data);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'LEGACY_MIRROR_RACE');
  assert.equal(mirrored.needsReconciliation, true);
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), null);
  assert.equal(
    JSON.parse(storage.getItem(STORE_KEYS.BLOCKS_V2))[0].name,
    '旧タブの同時変更'
  );
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), null);
  assert.match(mirrored.backupKey, new RegExp(`^${STORE_KEYS.LEGACY_SYNC_BACKUP_PREFIX}`));
  assert.equal(mirrored.recovery.blocks.status, 'preserved');
  assert.equal(mirrored.recovery.combos.status, 'restored');
});

test('a foreign completed marker prevents rollback of another mirror result', () => {
  class MarkerRacingStorage extends MemoryStorage {
    setItem(key, value) {
      super.setItem(key, value);
      if (this.raceEnabled && key === STORE_KEYS.LEGACY_SYNC_V2) {
        const foreignMarker = JSON.parse(String(value));
        foreignMarker.syncedAt = new Date(
          Date.parse(foreignMarker.syncedAt) + 1
        ).toISOString();
        this.values.set(key, JSON.stringify(foreignMarker));
      }
    }
  }

  const storage = new MarkerRacingStorage();
  const first = seedV3State(storage);
  assert.equal(writeLegacyV2Mirror(storage, first.data).ok, true);
  const second = saveAppState(storage, {
    ...first.data,
    blocks: [...first.data.blocks, validBlock({ id: 'menu-b', name: '新しい状態' })]
  }, first.data.revision);
  assert.equal(second.ok, true);
  storage.raceEnabled = true;

  const raced = writeLegacyV2Mirror(storage, second.data);

  assert.equal(raced.ok, false);
  assert.equal(raced.code, 'LEGACY_SYNC_MARKER_VERIFY_FAILED');
  assert.equal(raced.recovery.blocks.status, 'preserved');
  assert.equal(raced.recovery.blocks.reason, 'foreign-marker');
  assert.equal(raced.recovery.combos.status, 'preserved');
  assert.equal(raced.recovery.marker.status, 'preserved');
  assert.equal(JSON.parse(storage.getItem(STORE_KEYS.BLOCKS_V2)).length, 2);

  storage.raceEnabled = false;
  const reconciled = reconcileLegacyV2(storage, second.data);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.code, 'LEGACY_V2_UNCHANGED');
});

test('a concurrent v3 save aborts the mirror and rolls back its legacy writes', () => {
  class V3RacingStorage extends MemoryStorage {
    setItem(key, value) {
      super.setItem(key, value);
      if (this.raceEnabled && key === STORE_KEYS.COMBOS_V2) {
        this.values.set(STORE_KEYS.APP_STATE, JSON.stringify(this.nextState));
      }
    }
  }

  const storage = new V3RacingStorage();
  const saved = seedV3State(storage);
  storage.nextState = {
    ...saved.data,
    revision: saved.data.revision + 1,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
    blocks: [...saved.data.blocks, validBlock({ id: 'menu-b', name: '別タブの保存' })]
  };
  storage.raceEnabled = true;

  const mirrored = writeLegacyV2Mirror(storage, saved.data);

  assert.equal(mirrored.ok, false);
  assert.equal(mirrored.code, 'CURRENT_STATE_STALE');
  assert.equal(storage.getItem(STORE_KEYS.BLOCKS_V2), null);
  assert.equal(storage.getItem(STORE_KEYS.COMBOS_V2), null);
  assert.equal(storage.getItem(STORE_KEYS.LEGACY_SYNC_V2), null);
  assert.deepEqual(JSON.parse(storage.getItem(STORE_KEYS.APP_STATE)), storage.nextState);
  assert.equal(mirrored.recovery.blocks.status, 'restored');
  assert.equal(mirrored.recovery.combos.status, 'restored');
});

test('timer advancement crosses phases and completes deterministically', () => {
  const steps = buildTimerSteps([
    validBlock({ work: 3, rest: 2, repeat: 1 })
  ]);
  const snapshot = normalizeTimerSnapshot({
    active: true,
    paused: false,
    title: '短いセット',
    steps,
    index: 0,
    remaining: 5
  });

  const duringWork = advanceTimerSnapshot(snapshot, 6);
  assert.equal(duringWork.active, true);
  assert.equal(duringWork.index, 1);
  assert.equal(duringWork.steps[duringWork.index].phase, 'WORK');
  assert.equal(duringWork.remaining, 2);

  const completed = advanceTimerSnapshot(duringWork, 4);
  assert.equal(completed.active, false);
  assert.equal(completed.index, completed.steps.length);
  assert.equal(completed.totalLeft, 0);
});

test('timer snapshot rejects a corrupt step instead of shifting its index', () => {
  const steps = buildTimerSteps([validBlock({ repeat: 1 })]);
  steps.splice(1, 0, { phase: 'UNKNOWN', duration: 10 });

  assert.equal(
    normalizeTimerSnapshot({ active: true, steps, index: 2, remaining: 10 }),
    null
  );
});

test('timer snapshot rejects an oversized persisted step list', () => {
  const step = {
    phase: 'WORK',
    duration: 1,
    block: '大量データ',
    blockId: 'menu-a',
    round: 1,
    repeat: 1
  };
  const steps = Array.from({ length: LIMITS.MAX_TIMER_STEPS + 1 }, () => step);

  assert.equal(normalizeTimerSnapshot({ active: true, steps, index: 0, remaining: 1 }), null);
});

test('huge repeat and oversized block arrays cannot create unbounded timer steps', () => {
  const huge = validBlock({ repeat: Number.MAX_SAFE_INTEGER });
  const single = buildTimerSteps([huge]);
  assert.equal(single.length, 1 + LIMITS.MAX_REPEAT * 2);

  const many = Array.from(
    { length: LIMITS.MAX_COMBO_ITEMS + 50 },
    (_, index) => validBlock({ id: `menu-${index}`, repeat: LIMITS.MAX_REPEAT })
  );
  const bounded = buildTimerSteps(many);
  assert.ok(bounded.length <= LIMITS.MAX_TIMER_STEPS);
});

test('number preferences clamp values and storage errors are results', () => {
  const storage = new MemoryStorage({ volume: '150' });
  const loaded = loadNumberPreference(storage, 'volume', 50, 0, 100);
  assert.deepEqual(
    { ok: loaded.ok, value: loaded.value, repaired: loaded.repaired },
    { ok: true, value: 100, repaired: true }
  );

  storage.failWrites = true;
  const saved = savePreference(storage, 'volume', 80);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'WRITE_FAILED');
});

test('normalizeBlock accepts legacy aliases and returns a bounded canonical block', () => {
  const block = normalizeBlock({
    name: '  朝   トレ  ',
    workSeconds: '60',
    restSeconds: '20',
    repeats: '3'
  });

  assert.equal(block.name, '朝 トレ');
  assert.equal(block.work, 60);
  assert.equal(block.rest, 20);
  assert.equal(block.repeat, 3);
  assert.ok(block.id);
});
