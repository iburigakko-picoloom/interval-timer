const APP_STATE_VERSION = 3;
const LEGACY_SYNC_MARKER_VERSION = 1;
const LEGACY_FINGERPRINT_ALGORITHM = 'fnv1a64-utf16';

export const STORE_KEYS = Object.freeze({
  APP_STATE: 'interval_timer_app_v3',
  BLOCKS_V2: 'interval_blocks_single_v2',
  COMBOS_V2: 'interval_combos_single_v2',
  BLOCKS_V1: 'interval_blocks_single_v1',
  COMBOS_V1: 'interval_combos_single_v1',
  SOUND_VOLUME: 'interval_sound_volume_v1',
  LEGACY_SYNC_V2: 'interval_timer_v2_sync_marker_v1',
  LEGACY_SYNC_BACKUP_PREFIX: 'interval_timer_v2_sync_backup_',
  CORRUPT_BACKUP_PREFIX: 'interval_timer_app_v3_corrupt_'
});

export const LIMITS = Object.freeze({
  MAX_BLOCKS: 200,
  MAX_COMBOS: 100,
  MAX_COMBO_ITEMS: 100,
  MAX_NAME_LENGTH: 80,
  MAX_ID_LENGTH: 128,
  MIN_SECONDS: 1,
  MAX_SECONDS: 86400,
  MIN_REPEAT: 1,
  MAX_REPEAT: 100,
  MAX_TIMER_STEPS: 20001
});

const DEFAULT_BLOCK = Object.freeze({
  name: 'メニュー',
  work: 30,
  rest: 15,
  repeat: 4
});

let fallbackIdCounter = 0;
const normalizedTimerSnapshots = new WeakSet();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '不明なエラー');
}

function normalizePrefix(value) {
  const prefix = typeof value === 'string' ? value.trim() : '';
  return /^[a-z][a-z0-9_-]*$/i.test(prefix) ? prefix : 'id';
}

export function createId(prefix = 'id') {
  const safePrefix = normalizePrefix(prefix);

  try {
    if (globalThis.crypto?.randomUUID) {
      return `${safePrefix}_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // The time/random fallback below remains available in restricted contexts.
  }

  fallbackIdCounter = (fallbackIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12);
  return `${safePrefix}_${time}_${fallbackIdCounter.toString(36)}_${random}`;
}

function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > LIMITS.MAX_ID_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function uniqueId(preferred, usedIds, prefix) {
  let id = normalizeId(preferred);

  if (id && !usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }

  do {
    id = createId(prefix);
  } while (usedIds.has(id));

  usedIds.add(id);
  return id;
}

function normalizeName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const name = value.trim().replace(/\s+/g, ' ');
  return (name || fallback).slice(0, LIMITS.MAX_NAME_LENGTH);
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedInteger(value, fallback, min, max) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  const integer = Math.trunc(number);
  if (integer < min) return fallback;
  return Math.min(integer, max);
}

function boundedNumber(value, fallback, min, max) {
  const number = finiteNumber(value);
  if (number === null || number < min) return fallback;
  return Math.min(number, max);
}

function blockFields(value, fallbackName = DEFAULT_BLOCK.name) {
  const workValue = value.work ?? value.workSeconds;
  const restValue = value.rest ?? value.restSeconds;
  const repeatValue = value.repeat ?? value.repeats;

  return {
    name: normalizeName(value.name, fallbackName),
    work: boundedInteger(
      workValue,
      DEFAULT_BLOCK.work,
      LIMITS.MIN_SECONDS,
      LIMITS.MAX_SECONDS
    ),
    rest: boundedInteger(
      restValue,
      DEFAULT_BLOCK.rest,
      LIMITS.MIN_SECONDS,
      LIMITS.MAX_SECONDS
    ),
    repeat: boundedInteger(
      repeatValue,
      DEFAULT_BLOCK.repeat,
      LIMITS.MIN_REPEAT,
      LIMITS.MAX_REPEAT
    )
  };
}

export function normalizeBlock(value) {
  if (!isRecord(value)) return null;
  return {
    id: normalizeId(value.id) || createId('menu'),
    ...blockFields(value)
  };
}

export function createComboItem(block, sourceId = block?.sourceId ?? block?.id) {
  const normalized = normalizeBlock(block);
  if (!normalized) return null;

  return {
    id: createId('item'),
    sourceId: normalizeId(sourceId) || normalized.id,
    name: normalized.name,
    work: normalized.work,
    rest: normalized.rest,
    repeat: normalized.repeat
  };
}

function warnIfBlockRepaired(raw, normalized, path, warnings) {
  if (raw.id !== normalized.id) warnings.push(`${path}.id:repaired`);
  if (raw.name !== normalized.name) {
    warnings.push(`${path}.name:repaired`);
  }

  const rawFields = {
    work: raw.work ?? raw.workSeconds,
    rest: raw.rest ?? raw.restSeconds,
    repeat: raw.repeat ?? raw.repeats
  };
  for (const key of Object.keys(rawFields)) {
    if (rawFields[key] !== normalized[key]) {
      warnings.push(`${path}.${key}:repaired`);
    }
  }
}

function normalizeBlockList(value, warnings) {
  if (!Array.isArray(value)) {
    warnings.push('blocks:not-array');
    return { blocks: [], sourceIdMap: new Map() };
  }

  const usedIds = new Set();
  const sourceIdMap = new Map();
  const blocks = [];

  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) {
      warnings.push(`blocks[${index}]:discarded`);
      continue;
    }

    if (blocks.length >= LIMITS.MAX_BLOCKS) {
      warnings.push('blocks:truncated');
      break;
    }

    const originalId = normalizeId(raw.id);
    const normalized = normalizeBlock(raw);
    normalized.id = uniqueId(originalId, usedIds, 'menu');

    if (originalId && !sourceIdMap.has(originalId)) {
      sourceIdMap.set(originalId, normalized.id);
    }

    warnIfBlockRepaired(raw, normalized, `blocks[${index}]`, warnings);
    blocks.push(normalized);
  }

  return { blocks, sourceIdMap };
}

function normalizeComboItem(raw, legacyItem, sourceIdMap, usedItemIds, path, warnings) {
  if (!isRecord(raw)) {
    warnings.push(`${path}:discarded`);
    return null;
  }

  const snapshot = blockFields(raw);
  const preferredItemId = legacyItem ? null : normalizeId(raw.id);
  const id = uniqueId(preferredItemId, usedItemIds, 'item');
  const rawSourceValue = legacyItem ? raw.id : raw.sourceId ?? raw.sourceMenuId;
  const rawSourceId = normalizeId(rawSourceValue);
  const sourceId = rawSourceId
    ? sourceIdMap.get(rawSourceId) || rawSourceId
    : null;

  if (legacyItem || raw.id !== id) warnings.push(`${path}.id:repaired`);
  if (!legacyItem && rawSourceValue != null && rawSourceValue !== sourceId) {
    warnings.push(`${path}.sourceId:repaired`);
  }
  if (raw.name !== snapshot.name) warnings.push(`${path}.name:repaired`);

  const rawFields = {
    work: raw.work ?? raw.workSeconds,
    rest: raw.rest ?? raw.restSeconds,
    repeat: raw.repeat ?? raw.repeats
  };
  for (const key of Object.keys(rawFields)) {
    if (rawFields[key] !== snapshot[key]) warnings.push(`${path}.${key}:repaired`);
  }

  return {
    id,
    sourceId,
    ...snapshot
  };
}

function normalizeComboList(value, sourceIdMap, warnings) {
  if (!Array.isArray(value)) {
    warnings.push('combos:not-array');
    return [];
  }

  const usedComboIds = new Set();
  const usedItemIds = new Set();
  const combos = [];

  for (let comboIndex = 0; comboIndex < value.length; comboIndex += 1) {
    const raw = value[comboIndex];
    if (!isRecord(raw)) {
      warnings.push(`combos[${comboIndex}]:discarded`);
      continue;
    }

    if (combos.length >= LIMITS.MAX_COMBOS) {
      warnings.push('combos:truncated');
      break;
    }

    const hasV3Items = Array.isArray(raw.items);
    const rawItems = hasV3Items ? raw.items : Array.isArray(raw.blocks) ? raw.blocks : [];
    if (!hasV3Items) warnings.push(`combos[${comboIndex}].items:migrated`);
    const items = [];
    for (let itemIndex = 0; itemIndex < rawItems.length; itemIndex += 1) {
      const rawItem = rawItems[itemIndex];
      if (!isRecord(rawItem)) {
        warnings.push(`combos[${comboIndex}].items[${itemIndex}]:discarded`);
        continue;
      }

      if (items.length >= LIMITS.MAX_COMBO_ITEMS) {
        warnings.push(`combos[${comboIndex}].items:truncated`);
        break;
      }

      const item = normalizeComboItem(
        rawItem,
        !hasV3Items,
        sourceIdMap,
        usedItemIds,
        `combos[${comboIndex}].items[${itemIndex}]`,
        warnings
      );
      if (item) items.push(item);
    }

    if (!items.length) {
      warnings.push(`combos[${comboIndex}]:discarded-empty`);
      continue;
    }

    const preferredComboId = normalizeId(raw.id);
    const id = uniqueId(preferredComboId, usedComboIds, 'combo');
    if (raw.id !== id) {
      warnings.push(`combos[${comboIndex}].id:repaired`);
    }

    const name = normalizeName(raw.name, `組み合わせ ${comboIndex + 1}`);
    if (raw.name !== name) warnings.push(`combos[${comboIndex}].name:repaired`);

    combos.push({
      id,
      name,
      items
    });
  }

  return combos;
}

function normalizeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeUpdatedAt(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function emptyAppState() {
  return {
    version: APP_STATE_VERSION,
    revision: 0,
    updatedAt: null,
    blocks: [],
    combos: []
  };
}

function normalizeAppData(value, options = {}) {
  const warnings = options.warnings || [];
  const source = isRecord(value) ? value : {};
  if (!isRecord(value)) warnings.push('state:not-object');

  const { blocks, sourceIdMap } = normalizeBlockList(source.blocks, warnings);
  const combos = normalizeComboList(source.combos, sourceIdMap, warnings);
  const revision = normalizeRevision(source.revision);
  const updatedAt = normalizeUpdatedAt(source.updatedAt);

  if (source.revision !== undefined && revision !== source.revision) {
    warnings.push('revision:repaired');
  }
  if (source.updatedAt !== undefined && updatedAt !== source.updatedAt) {
    warnings.push('updatedAt:repaired');
  }

  return {
    version: APP_STATE_VERSION,
    revision,
    updatedAt,
    blocks,
    combos
  };
}

function safeGet(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ok: false, error: 'ストレージを利用できません。' };
  }

  try {
    const value = storage.getItem(key);
    return { ok: true, value: value === null ? null : String(value) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function safeSet(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, error: 'ストレージを利用できません。' };
  }

  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function safeRemove(storage, key) {
  if (!storage || typeof storage.removeItem !== 'function') {
    return { ok: false, error: 'ストレージを利用できません。' };
  }

  try {
    storage.removeItem(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function parseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function backupCorruptRaw(storage, raw) {
  const key = `${STORE_KEYS.CORRUPT_BACKUP_PREFIX}${Date.now()}_${createId('backup')}`;
  const saved = safeSet(storage, key, raw);
  return saved.ok
    ? { ok: true, key }
    : { ok: false, key: null, error: saved.error };
}

function loadLegacyPair(storage, blockKey, comboKey, source, warnings) {
  const blockRead = safeGet(storage, blockKey);
  const comboRead = safeGet(storage, comboKey);

  if (!blockRead.ok || !comboRead.ok) {
    return {
      ok: false,
      error: blockRead.error || comboRead.error
    };
  }

  const parseCollection = (raw, label) => {
    if (raw === null) return { present: false, valid: false, value: [] };
    const parsed = parseJson(raw);
    if (parsed.ok && Array.isArray(parsed.value)) {
      return { present: true, valid: true, value: parsed.value };
    }
    warnings.push(`${source}.${label}:invalid-json`);
    return { present: true, valid: false, value: [] };
  };

  const blocks = parseCollection(blockRead.value, 'blocks');
  const combos = parseCollection(comboRead.value, 'combos');
  return {
    ok: true,
    present: blocks.present || combos.present,
    blocks,
    combos
  };
}

function loadFailure(code, message, extra = {}) {
  return {
    ok: false,
    code,
    data: extra.data || emptyAppState(),
    source: extra.source || 'empty',
    migrated: Boolean(extra.migrated),
    repaired: Boolean(extra.repaired),
    warnings: extra.warnings || [],
    backupKey: extra.backupKey || null,
    error: message
  };
}

export function loadAppState(storage) {
  const warnings = [];
  const v3Read = safeGet(storage, STORE_KEYS.APP_STATE);

  if (!v3Read.ok) {
    return loadFailure('STORAGE_READ_FAILED', v3Read.error, { warnings });
  }

  let backupKey = null;
  let recoveredFromCorruptV3 = false;

  if (v3Read.value !== null) {
    const parsed = parseJson(v3Read.value);

    if (parsed.ok && isRecord(parsed.value) && parsed.value.version === APP_STATE_VERSION) {
      const v3Warnings = [];
      const data = normalizeAppData(parsed.value, { warnings: v3Warnings });

      if (v3Warnings.length) {
        const backup = backupCorruptRaw(storage, v3Read.value);
        if (!backup.ok) {
          return loadFailure('BACKUP_FAILED', backup.error, {
            data,
            source: 'v3',
            repaired: true,
            warnings: v3Warnings
          });
        }
        backupKey = backup.key;
      }

      return {
        ok: true,
        data,
        source: 'v3',
        migrated: false,
        repaired: v3Warnings.length > 0,
        warnings: v3Warnings,
        backupKey,
        error: null
      };
    }

    const backup = backupCorruptRaw(storage, v3Read.value);
    if (!backup.ok) {
      return loadFailure('BACKUP_FAILED', backup.error, {
        source: 'v3',
        warnings: ['v3:corrupt']
      });
    }

    backupKey = backup.key;
    recoveredFromCorruptV3 = true;
    warnings.push('v3:corrupt-backed-up');
  }

  const v2 = loadLegacyPair(
    storage,
    STORE_KEYS.BLOCKS_V2,
    STORE_KEYS.COMBOS_V2,
    'v2',
    warnings
  );
  const v1 = loadLegacyPair(
    storage,
    STORE_KEYS.BLOCKS_V1,
    STORE_KEYS.COMBOS_V1,
    'v1',
    warnings
  );

  if (!v2.ok || !v1.ok) {
    return loadFailure('STORAGE_READ_FAILED', v2.error || v1.error, {
      warnings,
      backupKey,
      migrated: true
    });
  }

  const chooseCollection = (name) => {
    if (v2[name].valid) return { value: v2[name].value, source: 'v2' };
    if (v1[name].valid) return { value: v1[name].value, source: 'v1' };
    return { value: [], source: null };
  };
  const selectedBlocks = chooseCollection('blocks');
  const selectedCombos = chooseCollection('combos');
  const hasLegacyData = v2.present || v1.present;
  const hasUsableLegacyData = selectedBlocks.source || selectedCombos.source;

  if (hasUsableLegacyData) {
    const data = normalizeAppData(
      {
        blocks: selectedBlocks.value,
        combos: selectedCombos.value,
        version: APP_STATE_VERSION,
        revision: 0,
        updatedAt: null
      },
      { warnings }
    );
    const source = selectedBlocks.source === 'v2' || selectedCombos.source === 'v2'
      ? 'v2'
      : 'v1';

    return {
      ok: true,
      data,
      source,
      legacySources: {
        blocks: selectedBlocks.source,
        combos: selectedCombos.source
      },
      migrated: true,
      repaired: warnings.length > 0,
      recoveredFromCorruptV3,
      warnings,
      backupKey,
      error: null
    };
  }

  if (hasLegacyData) {
    return loadFailure('LEGACY_DATA_INVALID', '保存済みデータを読み込めませんでした。', {
      source: 'empty',
      migrated: true,
      repaired: true,
      warnings,
      backupKey
    });
  }

  return {
    ok: true,
    data: emptyAppState(),
    source: 'empty',
    migrated: recoveredFromCorruptV3,
    repaired: recoveredFromCorruptV3,
    recoveredFromCorruptV3,
    warnings,
    backupKey,
    error: null
  };
}

function currentStoredState(storage) {
  const read = safeGet(storage, STORE_KEYS.APP_STATE);
  if (!read.ok) return { ok: false, code: 'STORAGE_READ_FAILED', error: read.error };
  if (read.value === null) return { ok: true, revision: 0, data: null, raw: null };

  const parsed = parseJson(read.value);
  if (!parsed.ok || !isRecord(parsed.value) || parsed.value.version !== APP_STATE_VERSION) {
    const backup = backupCorruptRaw(storage, read.value);
    if (!backup.ok) return { ok: false, code: 'BACKUP_FAILED', error: backup.error };
    return {
      ok: true,
      revision: 0,
      data: null,
      raw: read.value,
      backupKey: backup.key,
      corrupt: true
    };
  }

  const warnings = [];
  const data = normalizeAppData(parsed.value, { warnings });
  let backupKey = null;

  if (warnings.length) {
    const backup = backupCorruptRaw(storage, read.value);
    if (!backup.ok) return { ok: false, code: 'BACKUP_FAILED', error: backup.error };
    backupKey = backup.key;
  }

  return {
    ok: true,
    revision: data.revision,
    data,
    raw: read.value,
    backupKey,
    repaired: warnings.length > 0,
    warnings
  };
}

export function saveAppState(storage, data, expectedRevision = data?.revision ?? 0) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return {
      ok: false,
      code: 'INVALID_REVISION',
      error: 'expectedRevision は0以上の整数で指定してください。'
    };
  }

  const current = currentStoredState(storage);
  if (!current.ok) {
    return { ok: false, code: current.code, error: current.error };
  }

  if (current.revision !== expectedRevision) {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      error: '別の画面で保存内容が更新されています。',
      expectedRevision,
      actualRevision: current.revision,
      data: current.data,
      backupKey: current.backupKey || null
    };
  }

  const warnings = [];
  const normalized = normalizeAppData(data, { warnings });
  const next = {
    ...normalized,
    version: APP_STATE_VERSION,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString()
  };

  let serialized;
  try {
    serialized = JSON.stringify(next);
  } catch (error) {
    return { ok: false, code: 'SERIALIZE_FAILED', error: errorMessage(error) };
  }

  const written = safeSet(storage, STORE_KEYS.APP_STATE, serialized);
  if (!written.ok) {
    return {
      ok: false,
      code: 'WRITE_FAILED',
      error: written.error,
      data: next,
      warnings,
      backupKey: current.backupKey || null
    };
  }

  return {
    ok: true,
    data: next,
    revision: next.revision,
    warnings,
    repaired: warnings.length > 0,
    backupKey: current.backupKey || null,
    error: null
  };
}

function stableSerializeJson(value) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('JSONとして表現できない値です。');
    return serialized;
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerializeJson).join(',')}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerializeJson(value[key])}`)
      .join(',')}}`;
  }

  throw new TypeError('JSONとして表現できない値です。');
}

function legacyFingerprint(value) {
  const serialized = stableSerializeJson(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }

  return {
    algorithm: LEGACY_FINGERPRINT_ALGORITHM,
    length: serialized.length,
    hash: hash.toString(16).padStart(16, '0')
  };
}

function isLegacyFingerprint(value) {
  return isRecord(value)
    && value.algorithm === LEGACY_FINGERPRINT_ALGORITHM
    && Number.isSafeInteger(value.length)
    && value.length >= 0
    && typeof value.hash === 'string'
    && /^[0-9a-f]{16}$/.test(value.hash);
}

function sameLegacyFingerprint(left, right) {
  return isLegacyFingerprint(left)
    && isLegacyFingerprint(right)
    && left.algorithm === right.algorithm
    && left.length === right.length
    && left.hash === right.hash;
}

function legacyV2Projection(data, warnings = []) {
  const normalized = normalizeAppData(data, { warnings });
  const blocks = normalized.blocks.map((block) => ({
    id: block.id,
    name: block.name,
    work: block.work,
    rest: block.rest,
    repeat: block.repeat
  }));
  const blockIds = new Set(blocks.map((block) => block.id));
  const orphanIds = new Set();
  const legacyItemId = (item) => {
    const sourceId = normalizeId(item.sourceId);
    if (sourceId) return sourceId;

    const base = `orphan_${legacyFingerprint(item.id).hash}`;
    let candidate = base;
    let suffix = 2;
    while (blockIds.has(candidate) || orphanIds.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    orphanIds.add(candidate);
    return candidate;
  };
  const combos = normalized.combos.map((combo) => ({
    id: combo.id,
    name: combo.name,
    blocks: combo.items.map((item) => ({
      id: legacyItemId(item),
      name: item.name,
      work: item.work,
      rest: item.rest,
      repeat: item.repeat
    }))
  }));

  return { normalized, blocks, combos };
}

function parseLegacyV2CollectionRaw(raw, key, allowMissing = false) {
  if (raw === null) {
    return allowMissing
      ? { ok: true, missing: true, value: [], fingerprint: legacyFingerprint([]), raw: null }
      : { ok: false, code: 'LEGACY_V2_MISSING', error: `${key} がありません。` };
  }

  const parsed = parseJson(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return {
      ok: false,
      code: 'LEGACY_V2_CORRUPT',
      error: `${key} がJSON配列ではありません。`
    };
  }

  try {
    return {
      ok: true,
      missing: false,
      value: parsed.value,
      fingerprint: legacyFingerprint(parsed.value),
      raw
    };
  } catch (error) {
    return { ok: false, code: 'LEGACY_V2_CORRUPT', error: errorMessage(error) };
  }
}

function readLegacyV2Collection(storage, key, allowMissing = false) {
  const read = safeGet(storage, key);
  if (!read.ok) {
    return { ok: false, code: 'STORAGE_READ_FAILED', error: read.error };
  }
  return parseLegacyV2CollectionRaw(read.value, key, allowMissing);
}

function parseLegacySyncMarker(raw) {
  if (raw === null) return { ok: true, missing: true, marker: null };
  const parsed = parseJson(raw);
  const marker = parsed.value;

  if (!parsed.ok
    || !isRecord(marker)
    || marker.version !== LEGACY_SYNC_MARKER_VERSION
    || !Number.isSafeInteger(marker.v3Revision)
    || marker.v3Revision < 0
    || !(marker.v3UpdatedAt === null
      || (typeof marker.v3UpdatedAt === 'string' && !Number.isNaN(Date.parse(marker.v3UpdatedAt))))
    || typeof marker.syncedAt !== 'string'
    || Number.isNaN(Date.parse(marker.syncedAt))
    || !isRecord(marker.fingerprints)
    || !isLegacyFingerprint(marker.fingerprints.blocks)
    || !isLegacyFingerprint(marker.fingerprints.combos)) {
    return {
      ok: false,
      missing: false,
      marker: null,
      code: 'LEGACY_SYNC_MARKER_CORRUPT',
      error: 'v2互換同期マーカーが破損しています。'
    };
  }

  return { ok: true, missing: false, marker };
}

function legacyMirrorFailure(code, error, data, warnings, writes, extra = {}) {
  return {
    ok: false,
    code,
    data,
    warnings,
    writes,
    marker: null,
    error,
    ...extra
  };
}

function captureLegacySyncRaw(storage) {
  const blocks = safeGet(storage, STORE_KEYS.BLOCKS_V2);
  const combos = safeGet(storage, STORE_KEYS.COMBOS_V2);
  const marker = safeGet(storage, STORE_KEYS.LEGACY_SYNC_V2);
  if (!blocks.ok || !combos.ok || !marker.ok) {
    return {
      ok: false,
      error: blocks.error || combos.error || marker.error
    };
  }
  return {
    ok: true,
    blocksRaw: blocks.value,
    combosRaw: combos.value,
    markerRaw: marker.value
  };
}

function backupLegacySyncAttempt(storage, before, after, reason) {
  const key = `${STORE_KEYS.LEGACY_SYNC_BACKUP_PREFIX}${Date.now()}_${createId('backup')}`;
  let raw;
  try {
    raw = JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      before,
      after: after.ok ? after : { ok: false, error: after.error }
    });
  } catch (error) {
    return { ok: false, key: null, error: errorMessage(error) };
  }
  const written = safeSet(storage, key, raw);
  return written.ok
    ? { ok: true, key, error: null }
    : { ok: false, key: null, error: written.error };
}

function restoreRawValue(storage, key, raw) {
  return raw === null ? safeRemove(storage, key) : safeSet(storage, key, raw);
}

function conditionallyRestoreLegacyCollection(storage, key, beforeRaw, targetFingerprint) {
  const current = readLegacyV2Collection(storage, key, true);
  if (current.ok && current.raw === beforeRaw) {
    return { status: 'unchanged', error: null };
  }
  if (!current.ok || !sameLegacyFingerprint(current.fingerprint, targetFingerprint)) {
    return {
      status: 'preserved',
      error: current.ok ? null : current.error
    };
  }

  const restored = restoreRawValue(storage, key, beforeRaw);
  return restored.ok
    ? { status: 'restored', error: null }
    : { status: 'failed', error: restored.error };
}

function conditionallyRestoreLegacyMarker(storage, beforeRaw, targetRaw) {
  const current = safeGet(storage, STORE_KEYS.LEGACY_SYNC_V2);
  if (current.ok && current.value === beforeRaw) {
    return { status: 'unchanged', error: null };
  }
  if (targetRaw === null) return { status: 'untouched', error: current.ok ? null : current.error };
  if (!current.ok || current.value !== targetRaw) {
    return {
      status: 'preserved',
      error: current.ok ? null : current.error
    };
  }

  const restored = restoreRawValue(storage, STORE_KEYS.LEGACY_SYNC_V2, beforeRaw);
  return restored.ok
    ? { status: 'restored', error: null }
    : { status: 'failed', error: restored.error };
}

function rollbackLegacyMirror(
  storage,
  before,
  desiredBlocksFingerprint,
  desiredCombosFingerprint,
  targetMarkerRaw
) {
  const currentMarker = safeGet(storage, STORE_KEYS.LEGACY_SYNC_V2);
  const markerOwnedByThisAttempt = currentMarker.ok
    && (currentMarker.value === before.markerRaw
      || (targetMarkerRaw !== null && currentMarker.value === targetMarkerRaw));
  if (!markerOwnedByThisAttempt) {
    const error = currentMarker.ok ? null : currentMarker.error;
    const preserved = {
      status: 'preserved',
      reason: currentMarker.ok ? 'foreign-marker' : 'marker-unreadable',
      error
    };
    return {
      blocks: { ...preserved },
      combos: { ...preserved },
      marker: { ...preserved }
    };
  }

  return {
    blocks: conditionallyRestoreLegacyCollection(
      storage,
      STORE_KEYS.BLOCKS_V2,
      before.blocksRaw,
      desiredBlocksFingerprint
    ),
    combos: conditionallyRestoreLegacyCollection(
      storage,
      STORE_KEYS.COMBOS_V2,
      before.combosRaw,
      desiredCombosFingerprint
    ),
    marker: conditionallyRestoreLegacyMarker(
      storage,
      before.markerRaw,
      targetMarkerRaw
    )
  };
}

function compareStoredAppState(storage, expected, expectedCanonical) {
  const stored = currentStoredState(storage);
  if (!stored.ok) {
    return { ok: false, code: stored.code, error: stored.error };
  }
  if (!stored.data) {
    return {
      ok: false,
      code: 'APP_STATE_MISSING',
      error: '保存済みのv3データがありません。先にv3データを保存してください。'
    };
  }
  if (stored.repaired) {
    return {
      ok: false,
      code: 'CURRENT_STORED_STATE_REQUIRES_REPAIR',
      error: '保存済みのv3データを先に修復して保存してください。',
      actualData: stored.data,
      backupKey: stored.backupKey || null
    };
  }

  let actualCanonical;
  try {
    actualCanonical = stableSerializeJson(stored.data);
  } catch (error) {
    return {
      ok: false,
      code: 'CURRENT_STORED_STATE_INVALID',
      error: errorMessage(error),
      actualData: stored.data
    };
  }

  if (stored.revision !== expected.revision || actualCanonical !== expectedCanonical) {
    return {
      ok: false,
      code: stored.revision !== expected.revision ? 'CURRENT_STATE_STALE' : 'APP_STATE_MISMATCH',
      error: stored.revision !== expected.revision
        ? '現在のv3データが保存済みデータより古いため、先に最新データを読み直してください。'
        : '指定されたv3データが保存済みデータと一致しません。',
      actualData: stored.data,
      actualRevision: stored.revision
    };
  }

  return { ok: true, data: stored.data };
}

export function writeLegacyV2Mirror(storage, data, options = {}) {
  const emptyWrites = { blocks: false, combos: false, marker: false };
  if (!isRecord(data) || data.version !== APP_STATE_VERSION) {
    return legacyMirrorFailure(
      'INVALID_CURRENT_STATE',
      '現在のv3データが不正です。',
      null,
      [],
      emptyWrites
    );
  }

  const warnings = [];
  const normalized = normalizeAppData(data, { warnings });
  if (warnings.length) {
    return legacyMirrorFailure(
      'CURRENT_STATE_REQUIRES_REPAIR',
      '現在のv3データを先に修復して保存してください。',
      normalized,
      warnings,
      emptyWrites
    );
  }

  let expectedCanonical;
  try {
    expectedCanonical = stableSerializeJson(normalized);
  } catch (error) {
    return legacyMirrorFailure(
      'INVALID_CURRENT_STATE',
      errorMessage(error),
      normalized,
      warnings,
      emptyWrites
    );
  }

  const initialStateCheck = compareStoredAppState(storage, normalized, expectedCanonical);
  if (!initialStateCheck.ok) {
    return legacyMirrorFailure(
      initialStateCheck.code,
      initialStateCheck.error,
      normalized,
      warnings,
      emptyWrites,
      {
        actualData: initialStateCheck.actualData || null,
        actualRevision: initialStateCheck.actualRevision,
        backupKey: initialStateCheck.backupKey || null,
        needsReload: true
      }
    );
  }

  const { blocks, combos } = legacyV2Projection(normalized);
  const desiredBlocksFingerprint = legacyFingerprint(blocks);
  const desiredCombosFingerprint = legacyFingerprint(combos);
  const before = captureLegacySyncRaw(storage);
  if (!before.ok) {
    return legacyMirrorFailure(
      'STORAGE_READ_FAILED',
      before.error,
      normalized,
      warnings,
      emptyWrites
    );
  }

  let blocksRaw;
  let combosRaw;

  try {
    blocksRaw = JSON.stringify(blocks);
    combosRaw = JSON.stringify(combos);
  } catch (error) {
    return legacyMirrorFailure(
      'LEGACY_MIRROR_SERIALIZE_FAILED',
      errorMessage(error),
      normalized,
      warnings,
      emptyWrites
    );
  }

  const existingMarker = parseLegacySyncMarker(before.markerRaw);
  if (!existingMarker.ok) {
    return legacyMirrorFailure(
      existingMarker.code,
      existingMarker.error,
      normalized,
      warnings,
      emptyWrites,
      { needsReconciliation: true }
    );
  }

  const existingBlocks = parseLegacyV2CollectionRaw(
    before.blocksRaw,
    STORE_KEYS.BLOCKS_V2,
    true
  );
  const existingCombos = parseLegacyV2CollectionRaw(
    before.combosRaw,
    STORE_KEYS.COMBOS_V2,
    true
  );
  if (!existingBlocks.ok || !existingCombos.ok) {
    return legacyMirrorFailure(
      'LEGACY_V2_CORRUPT',
      existingBlocks.error || existingCombos.error,
      normalized,
      warnings,
      emptyWrites,
      {
        marker: existingMarker.missing ? null : existingMarker.marker,
        needsReconciliation: true
      }
    );
  }

  if (existingMarker.missing) {
    const pendingCollections = [
      !existingBlocks.missing
        && !sameLegacyFingerprint(existingBlocks.fingerprint, desiredBlocksFingerprint)
        ? 'blocks'
        : null,
      !existingCombos.missing
        && !sameLegacyFingerprint(existingCombos.fingerprint, desiredCombosFingerprint)
        ? 'combos'
        : null
    ].filter(Boolean);

    if (pendingCollections.length && options?.allowUnmarkedOverwrite !== true) {
      return legacyMirrorFailure(
        'LEGACY_UNMARKED_V2_DATA',
        '同期元が確認できないv2データがあるため、自動上書きを中止しました。',
        normalized,
        warnings,
        emptyWrites,
        {
          needsReconciliation: true,
          requiresInitialization: true,
          pendingCollections
        }
      );
    }
  } else {
    if (existingMarker.marker.v3Revision > normalized.revision) {
      return legacyMirrorFailure(
        'CURRENT_STATE_STALE',
        '同期マーカーより古いv3データでは互換ミラーを更新できません。',
        normalized,
        warnings,
        emptyWrites,
        { marker: existingMarker.marker, needsReload: true }
      );
    }

    const pendingCollections = [
      !sameLegacyFingerprint(
        existingBlocks.fingerprint,
        existingMarker.marker.fingerprints.blocks
      ) && !sameLegacyFingerprint(existingBlocks.fingerprint, desiredBlocksFingerprint)
        ? 'blocks'
        : null,
      !sameLegacyFingerprint(
        existingCombos.fingerprint,
        existingMarker.marker.fingerprints.combos
      ) && !sameLegacyFingerprint(existingCombos.fingerprint, desiredCombosFingerprint)
        ? 'combos'
        : null
    ].filter(Boolean);
    if (pendingCollections.length) {
      return legacyMirrorFailure(
        'LEGACY_V2_CHANGES_PENDING',
        '旧版タブの未取り込み変更があるため、互換ミラーの上書きを中止しました。',
        normalized,
        warnings,
        emptyWrites,
        {
          marker: existingMarker.marker,
          needsReconciliation: true,
          pendingCollections
        }
      );
    }
  }

  const stateBeforeWrite = compareStoredAppState(storage, normalized, expectedCanonical);
  if (!stateBeforeWrite.ok) {
    return legacyMirrorFailure(
      stateBeforeWrite.code,
      stateBeforeWrite.error,
      normalized,
      warnings,
      emptyWrites,
      {
        actualData: stateBeforeWrite.actualData || null,
        actualRevision: stateBeforeWrite.actualRevision,
        needsReload: true
      }
    );
  }

  const snapshotBeforeWrite = captureLegacySyncRaw(storage);
  if (!snapshotBeforeWrite.ok) {
    return legacyMirrorFailure(
      'STORAGE_READ_FAILED',
      snapshotBeforeWrite.error,
      normalized,
      warnings,
      emptyWrites
    );
  }
  if (snapshotBeforeWrite.blocksRaw !== before.blocksRaw
    || snapshotBeforeWrite.combosRaw !== before.combosRaw
    || snapshotBeforeWrite.markerRaw !== before.markerRaw) {
    return legacyMirrorFailure(
      'LEGACY_MIRROR_RACE',
      'v2互換データが同期準備中に別の画面から変更されました。',
      normalized,
      warnings,
      emptyWrites,
      { needsReconciliation: true }
    );
  }

  const recoverFailure = (code, error, writes, extra = {}, targetMarkerRaw = null) => {
    const after = captureLegacySyncRaw(storage);
    const backup = backupLegacySyncAttempt(storage, before, after, code);
    const recovery = rollbackLegacyMirror(
      storage,
      before,
      desiredBlocksFingerprint,
      desiredCombosFingerprint,
      targetMarkerRaw
    );
    return legacyMirrorFailure(
      code,
      error,
      normalized,
      warnings,
      writes,
      {
        ...extra,
        backupKey: backup.key,
        backupError: backup.error,
        recovery
      }
    );
  };

  const writes = {
    blocks: false,
    combos: false,
    marker: false
  };

  const blockWrite = safeSet(storage, STORE_KEYS.BLOCKS_V2, blocksRaw);
  writes.blocks = blockWrite.ok;
  if (!blockWrite.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_WRITE_FAILED',
      `${STORE_KEYS.BLOCKS_V2}: ${blockWrite.error}`,
      writes,
      { failedKeys: [STORE_KEYS.BLOCKS_V2] }
    );
  }

  const comboBeforeWrite = safeGet(storage, STORE_KEYS.COMBOS_V2);
  const markerBeforeComboWrite = safeGet(storage, STORE_KEYS.LEGACY_SYNC_V2);
  if (!comboBeforeWrite.ok || !markerBeforeComboWrite.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_VERIFY_FAILED',
      comboBeforeWrite.error || markerBeforeComboWrite.error,
      writes
    );
  }
  if (comboBeforeWrite.value !== before.combosRaw
    || markerBeforeComboWrite.value !== before.markerRaw) {
    return recoverFailure(
      'LEGACY_MIRROR_RACE',
      'v2互換データが同期中に別の画面から変更されました。',
      writes,
      { needsReconciliation: true }
    );
  }

  const comboWrite = safeSet(storage, STORE_KEYS.COMBOS_V2, combosRaw);
  writes.combos = comboWrite.ok;
  if (!comboWrite.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_WRITE_FAILED',
      `${STORE_KEYS.COMBOS_V2}: ${comboWrite.error}`,
      writes,
      { failedKeys: [STORE_KEYS.COMBOS_V2] }
    );
  }

  const verifiedBlocks = readLegacyV2Collection(storage, STORE_KEYS.BLOCKS_V2);
  const verifiedCombos = readLegacyV2Collection(storage, STORE_KEYS.COMBOS_V2);
  if (!verifiedBlocks.ok || !verifiedCombos.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_VERIFY_FAILED',
      verifiedBlocks.error || verifiedCombos.error,
      writes
    );
  }

  if (!sameLegacyFingerprint(verifiedBlocks.fingerprint, desiredBlocksFingerprint)
    || !sameLegacyFingerprint(verifiedCombos.fingerprint, desiredCombosFingerprint)) {
    return recoverFailure(
      'LEGACY_MIRROR_RACE',
      'v2互換データが同期中に別の画面から変更されました。',
      writes,
      { needsReconciliation: true }
    );
  }

  const stateBeforeMarker = compareStoredAppState(storage, normalized, expectedCanonical);
  if (!stateBeforeMarker.ok) {
    return recoverFailure(
      stateBeforeMarker.code,
      stateBeforeMarker.error,
      writes,
      {
        actualData: stateBeforeMarker.actualData || null,
        actualRevision: stateBeforeMarker.actualRevision,
        needsReload: true
      }
    );
  }

  const markerBeforeWrite = safeGet(storage, STORE_KEYS.LEGACY_SYNC_V2);
  if (!markerBeforeWrite.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_VERIFY_FAILED',
      markerBeforeWrite.error,
      writes
    );
  }
  if (markerBeforeWrite.value !== before.markerRaw) {
    return recoverFailure(
      'LEGACY_MIRROR_RACE',
      'v2互換同期マーカーが同期中に別の画面から変更されました。',
      writes,
      { needsReconciliation: true }
    );
  }

  const marker = {
    version: LEGACY_SYNC_MARKER_VERSION,
    v3Revision: normalized.revision,
    v3UpdatedAt: normalized.updatedAt,
    syncedAt: new Date().toISOString(),
    fingerprints: {
      blocks: desiredBlocksFingerprint,
      combos: desiredCombosFingerprint
    }
  };
  const markerRaw = JSON.stringify(marker);
  const markerWrite = safeSet(
    storage,
    STORE_KEYS.LEGACY_SYNC_V2,
    markerRaw
  );
  writes.marker = markerWrite.ok;
  if (!markerWrite.ok) {
    return recoverFailure(
      'LEGACY_SYNC_MARKER_WRITE_FAILED',
      markerWrite.error,
      writes,
      {},
      markerRaw
    );
  }

  const verifiedMarker = safeGet(storage, STORE_KEYS.LEGACY_SYNC_V2);
  if (!verifiedMarker.ok || verifiedMarker.value !== markerRaw) {
    return recoverFailure(
      'LEGACY_SYNC_MARKER_VERIFY_FAILED',
      verifiedMarker.error || 'v2互換同期マーカーを検証できませんでした。',
      writes,
      {},
      markerRaw
    );
  }

  const finalStateCheck = compareStoredAppState(storage, normalized, expectedCanonical);
  if (!finalStateCheck.ok) {
    return recoverFailure(
      finalStateCheck.code,
      finalStateCheck.error,
      writes,
      {
        actualData: finalStateCheck.actualData || null,
        actualRevision: finalStateCheck.actualRevision,
        needsReload: true
      },
      markerRaw
    );
  }

  const finalSnapshot = captureLegacySyncRaw(storage);
  if (!finalSnapshot.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_VERIFY_FAILED',
      finalSnapshot.error,
      writes,
      {},
      markerRaw
    );
  }
  const finalBlocks = parseLegacyV2CollectionRaw(
    finalSnapshot.blocksRaw,
    STORE_KEYS.BLOCKS_V2
  );
  const finalCombos = parseLegacyV2CollectionRaw(
    finalSnapshot.combosRaw,
    STORE_KEYS.COMBOS_V2
  );
  if (!finalBlocks.ok || !finalCombos.ok) {
    return recoverFailure(
      'LEGACY_MIRROR_VERIFY_FAILED',
      finalBlocks.error || finalCombos.error,
      writes,
      {},
      markerRaw
    );
  }
  if (finalSnapshot.markerRaw !== markerRaw
    || !sameLegacyFingerprint(finalBlocks.fingerprint, desiredBlocksFingerprint)
    || !sameLegacyFingerprint(finalCombos.fingerprint, desiredCombosFingerprint)) {
    return recoverFailure(
      'LEGACY_MIRROR_RACE',
      'v2互換データが同期完了前に別の画面から変更されました。',
      writes,
      { needsReconciliation: true },
      markerRaw
    );
  }

  return {
    ok: true,
    code: 'LEGACY_MIRROR_SYNCED',
    data: normalized,
    warnings,
    writes,
    marker,
    error: null
  };
}

function legacyReconcileFailure(code, error, data, warnings = [], extra = {}) {
  return {
    ok: false,
    code,
    data,
    changed: false,
    changedCollections: [],
    needsMirror: Boolean(extra.needsMirror),
    warnings,
    marker: extra.marker || null,
    error,
    ...extra
  };
}

function verifyReconcileSnapshot(storage, before, current, currentCanonical) {
  const stateBeforeSnapshot = compareStoredAppState(storage, current, currentCanonical);
  if (!stateBeforeSnapshot.ok) {
    return {
      ok: false,
      code: 'RECONCILE_RACE',
      error: `取り込み中にv3データが変更されました。${stateBeforeSnapshot.error}`,
      needsReload: true,
      actualData: stateBeforeSnapshot.actualData || null,
      actualRevision: stateBeforeSnapshot.actualRevision
    };
  }

  const after = captureLegacySyncRaw(storage);
  if (!after.ok) {
    return { ok: false, code: 'STORAGE_READ_FAILED', error: after.error };
  }
  if (after.blocksRaw !== before.blocksRaw
    || after.combosRaw !== before.combosRaw
    || after.markerRaw !== before.markerRaw) {
    return {
      ok: false,
      code: 'RECONCILE_RACE',
      error: '取り込み中にv2互換データが変更されました。'
    };
  }

  const stateAfterSnapshot = compareStoredAppState(storage, current, currentCanonical);
  if (!stateAfterSnapshot.ok) {
    return {
      ok: false,
      code: 'RECONCILE_RACE',
      error: `取り込み中にv3データが変更されました。${stateAfterSnapshot.error}`,
      needsReload: true,
      actualData: stateAfterSnapshot.actualData || null,
      actualRevision: stateAfterSnapshot.actualRevision
    };
  }

  return { ok: true };
}

export function reconcileLegacyV2(storage, currentData) {
  if (!isRecord(currentData) || currentData.version !== APP_STATE_VERSION) {
    return legacyReconcileFailure(
      'INVALID_CURRENT_STATE',
      '現在のv3データが不正です。',
      emptyAppState()
    );
  }

  const currentWarnings = [];
  const current = normalizeAppData(currentData, { warnings: currentWarnings });
  if (currentWarnings.length) {
    return legacyReconcileFailure(
      'CURRENT_STATE_REQUIRES_REPAIR',
      '現在のv3データを先に修復して保存してください。',
      current,
      currentWarnings,
      { needsMirror: true }
    );
  }

  let currentCanonical;
  try {
    currentCanonical = stableSerializeJson(current);
  } catch (error) {
    return legacyReconcileFailure(
      'INVALID_CURRENT_STATE',
      errorMessage(error),
      current
    );
  }

  const initialStateCheck = compareStoredAppState(storage, current, currentCanonical);
  if (!initialStateCheck.ok) {
    return legacyReconcileFailure(
      initialStateCheck.code,
      initialStateCheck.error,
      current,
      [],
      {
        needsReload: true,
        actualData: initialStateCheck.actualData || null,
        actualRevision: initialStateCheck.actualRevision,
        backupKey: initialStateCheck.backupKey || null
      }
    );
  }

  const before = captureLegacySyncRaw(storage);
  if (!before.ok) {
    return legacyReconcileFailure(
      'STORAGE_READ_FAILED',
      before.error,
      current
    );
  }

  const stabilityFailure = (check, warnings = [], marker = null) => legacyReconcileFailure(
    check.code,
    check.error,
    current,
    warnings,
    {
      marker,
      needsReconciliation: true,
      needsReload: Boolean(check.needsReload),
      actualData: check.actualData || null,
      actualRevision: check.actualRevision
    }
  );

  const markerRead = parseLegacySyncMarker(before.markerRaw);
  if (!markerRead.ok) {
    return legacyReconcileFailure(
      markerRead.code,
      markerRead.error,
      current,
      [],
      { needsMirror: true }
    );
  }
  if (markerRead.missing) {
    const stable = verifyReconcileSnapshot(storage, before, current, currentCanonical);
    if (!stable.ok) return stabilityFailure(stable);
    return {
      ok: true,
      code: 'LEGACY_SYNC_MARKER_MISSING',
      data: current,
      changed: false,
      changedCollections: [],
      needsMirror: true,
      warnings: [],
      marker: null,
      error: null
    };
  }

  const marker = markerRead.marker;
  if (marker.v3Revision < current.revision) {
    return legacyReconcileFailure(
      'LEGACY_SYNC_MARKER_STALE',
      'v2互換同期マーカーが現在のv3データより古いため、自動取り込みを中止しました。',
      current,
      [],
      { needsMirror: true, marker }
    );
  }
  if (marker.v3Revision > current.revision) {
    return legacyReconcileFailure(
      'CURRENT_STATE_STALE',
      '現在のv3データが同期マーカーより古いため、先に最新データを読み直してください。',
      current,
      [],
      { needsReload: true, marker }
    );
  }

  const currentProjection = legacyV2Projection(current);
  const currentBlocksFingerprint = legacyFingerprint(currentProjection.blocks);
  const currentCombosFingerprint = legacyFingerprint(currentProjection.combos);
  if (!sameLegacyFingerprint(marker.fingerprints.blocks, currentBlocksFingerprint)
    || !sameLegacyFingerprint(marker.fingerprints.combos, currentCombosFingerprint)) {
    return legacyReconcileFailure(
      'LEGACY_SYNC_BASE_MISMATCH',
      '同期マーカーと現在のv3データが一致しないため、自動取り込みを中止しました。',
      current,
      [],
      { needsMirror: true, marker }
    );
  }

  const legacyBlocks = parseLegacyV2CollectionRaw(before.blocksRaw, STORE_KEYS.BLOCKS_V2);
  const legacyCombos = parseLegacyV2CollectionRaw(before.combosRaw, STORE_KEYS.COMBOS_V2);
  if (!legacyBlocks.ok || !legacyCombos.ok) {
    const corruptCollections = [
      !legacyBlocks.ok ? 'blocks' : null,
      !legacyCombos.ok ? 'combos' : null
    ].filter(Boolean);
    return legacyReconcileFailure(
      'LEGACY_V2_CORRUPT',
      legacyBlocks.error || legacyCombos.error,
      current,
      [],
      { needsMirror: true, marker, corruptCollections }
    );
  }

  const blocksChanged = !sameLegacyFingerprint(
    legacyBlocks.fingerprint,
    marker.fingerprints.blocks
  );
  const combosChanged = !sameLegacyFingerprint(
    legacyCombos.fingerprint,
    marker.fingerprints.combos
  );
  if (!blocksChanged && !combosChanged) {
    const stable = verifyReconcileSnapshot(storage, before, current, currentCanonical);
    if (!stable.ok) return stabilityFailure(stable, [], marker);
    return {
      ok: true,
      code: 'LEGACY_V2_UNCHANGED',
      data: current,
      changed: false,
      changedCollections: [],
      needsMirror: false,
      warnings: [],
      marker,
      error: null
    };
  }

  const warnings = [];
  let blocks = current.blocks;
  let sourceIdMap = new Map(current.blocks.map((block) => [block.id, block.id]));
  if (blocksChanged) {
    const normalizedBlocks = normalizeBlockList(legacyBlocks.value, warnings);
    if (legacyBlocks.value.length > 0 && normalizedBlocks.blocks.length === 0) {
      return legacyReconcileFailure(
        'LEGACY_V2_BLOCKS_UNUSABLE',
        '変更されたv2メニューに利用可能な項目がないため、自動取り込みを中止しました。',
        current,
        warnings,
        { needsMirror: true, marker, corruptCollections: ['blocks'] }
      );
    }
    blocks = normalizedBlocks.blocks;
    sourceIdMap = normalizedBlocks.sourceIdMap;
  }

  let combos = current.combos;
  if (combosChanged) {
    const normalizedCombos = normalizeComboList(legacyCombos.value, sourceIdMap, warnings);
    if (legacyCombos.value.length > 0 && normalizedCombos.length === 0) {
      return legacyReconcileFailure(
        'LEGACY_V2_COMBOS_UNUSABLE',
        '変更されたv2組み合わせに利用可能な項目がないため、自動取り込みを中止しました。',
        current,
        warnings,
        { needsMirror: true, marker, corruptCollections: ['combos'] }
      );
    }
    combos = normalizedCombos;
  }

  const changedCollections = [
    blocksChanged ? 'blocks' : null,
    combosChanged ? 'combos' : null
  ].filter(Boolean);
  const stable = verifyReconcileSnapshot(storage, before, current, currentCanonical);
  if (!stable.ok) return stabilityFailure(stable, warnings, marker);
  return {
    ok: true,
    code: 'LEGACY_V2_CHANGES_FOUND',
    data: {
      ...current,
      blocks,
      combos
    },
    changed: true,
    changedCollections,
    needsMirror: true,
    repaired: warnings.length > 0,
    warnings,
    marker,
    error: null
  };
}

export function loadNumberPreference(storage, key, fallback, min, max) {
  const lower = finiteNumber(min);
  const upper = finiteNumber(max);
  const safeMin = lower === null ? Number.MIN_SAFE_INTEGER : lower;
  const safeMax = upper === null || upper < safeMin ? Number.MAX_SAFE_INTEGER : upper;
  const fallbackValue = boundedNumber(fallback, safeMin, safeMin, safeMax);
  const read = safeGet(storage, key);

  if (!read.ok) {
    return {
      ok: false,
      value: fallbackValue,
      repaired: false,
      code: 'STORAGE_READ_FAILED',
      error: read.error
    };
  }

  if (read.value === null) {
    return { ok: true, value: fallbackValue, repaired: false, error: null };
  }

  const parsed = parseJson(read.value);
  const rawValue = parsed.ok ? parsed.value : read.value;
  const number = finiteNumber(rawValue);

  if (number === null) {
    return { ok: true, value: fallbackValue, repaired: true, error: null };
  }

  return {
    ok: true,
    value: Math.min(safeMax, Math.max(safeMin, number)),
    repaired: number < safeMin || number > safeMax,
    error: null
  };
}

export function savePreference(storage, key, value) {
  if (typeof key !== 'string' || !key.trim()) {
    return { ok: false, code: 'INVALID_KEY', error: '保存キーが不正です。' };
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('保存できない値です。');
  } catch (error) {
    return { ok: false, code: 'SERIALIZE_FAILED', error: errorMessage(error) };
  }

  const written = safeSet(storage, key, serialized);
  return written.ok
    ? { ok: true, value, error: null }
    : { ok: false, code: 'WRITE_FAILED', value, error: written.error };
}

export function buildTimerSteps(blocks, preparationSeconds = 5) {
  if (!Array.isArray(blocks)) return [];

  const normalizedBlocks = blocks
    .slice(0, LIMITS.MAX_COMBO_ITEMS)
    .map(normalizeBlock)
    .filter(Boolean);

  if (!normalizedBlocks.length) return [];

  const preparation = boundedInteger(
    preparationSeconds,
    5,
    0,
    LIMITS.MAX_SECONDS
  );
  const steps = [];

  if (preparation > 0) {
    steps.push({
      phase: 'START',
      duration: preparation,
      block: '準備',
      blockId: null,
      round: 0,
      repeat: 0
    });
  }

  outer: for (const block of normalizedBlocks) {
    for (let round = 1; round <= block.repeat; round += 1) {
      if (steps.length + 2 > LIMITS.MAX_TIMER_STEPS) break outer;
      steps.push({
        phase: 'WORK',
        duration: block.work,
        block: block.name,
        blockId: block.id,
        round,
        repeat: block.repeat
      });
      steps.push({
        phase: 'REST',
        duration: block.rest,
        block: block.name,
        blockId: block.id,
        round,
        repeat: block.repeat
      });
    }
  }

  return steps;
}

function normalizeTimerStep(value) {
  if (!isRecord(value)) return null;
  const phase = typeof value.phase === 'string' ? value.phase.toUpperCase() : '';
  if (!['START', 'WORK', 'REST'].includes(phase)) return null;

  const duration = boundedNumber(
    value.duration,
    LIMITS.MIN_SECONDS,
    LIMITS.MIN_SECONDS,
    LIMITS.MAX_SECONDS
  );

  return {
    phase,
    duration,
    block: normalizeName(value.block, phase === 'START' ? '準備' : 'メニュー'),
    blockId: normalizeId(value.blockId),
    round: boundedInteger(value.round, 0, 0, LIMITS.MAX_REPEAT),
    repeat: boundedInteger(value.repeat, 0, 0, LIMITS.MAX_REPEAT)
  };
}

function remainingTotal(steps, index, remaining) {
  if (index >= steps.length) return 0;
  return remaining + steps.slice(index + 1).reduce((sum, step) => sum + step.duration, 0);
}

function markTimerSnapshot(snapshot) {
  normalizedTimerSnapshots.add(snapshot);
  return snapshot;
}

export function normalizeTimerSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  if (value.steps.length > LIMITS.MAX_TIMER_STEPS) return null;

  const rawSteps = value.steps.slice(0, LIMITS.MAX_TIMER_STEPS);
  const steps = rawSteps.map(normalizeTimerStep);

  if (!steps.length || steps.some((step) => step === null)) return null;

  let index = boundedInteger(value.index, 0, 0, steps.length);
  let active = value.active !== false;

  if (index >= steps.length) {
    index = steps.length;
    active = false;
  }

  if (!active && value.completed === true) index = steps.length;

  if (index >= steps.length) {
    return markTimerSnapshot({
      active: false,
      paused: false,
      title: normalizeName(value.title, 'インターバル'),
      steps,
      index: steps.length,
      remaining: 0,
      duration: 0,
      totalLeft: 0
    });
  }

  const duration = steps[index].duration;
  const remaining = boundedNumber(value.remaining, duration, 0, duration);

  return markTimerSnapshot({
    active,
    paused: active && Boolean(value.paused),
    title: normalizeName(value.title, 'インターバル'),
    steps,
    index,
    remaining,
    duration,
    totalLeft: remainingTotal(steps, index, remaining)
  });
}

export function advanceTimerSnapshot(snapshot, elapsedSeconds) {
  const current = normalizedTimerSnapshots.has(snapshot)
    ? snapshot
    : normalizeTimerSnapshot(snapshot);
  if (!current) return null;
  if (!current.active || current.paused) return current;

  const elapsedValue = finiteNumber(elapsedSeconds);
  if (elapsedValue === null || elapsedValue < 0) return current;

  let elapsed = elapsedValue;
  let index = current.index;
  let remaining = current.remaining;

  while (index < current.steps.length && elapsed >= remaining) {
    elapsed -= remaining;
    index += 1;

    if (index >= current.steps.length) {
      return markTimerSnapshot({
        ...current,
        active: false,
        paused: false,
        index: current.steps.length,
        remaining: 0,
        duration: 0,
        totalLeft: 0
      });
    }

    remaining = current.steps[index].duration;
  }

  remaining = Math.max(0, remaining - elapsed);

  return markTimerSnapshot({
    ...current,
    index,
    remaining,
    duration: current.steps[index].duration,
    totalLeft: Math.max(0, current.totalLeft - elapsedValue)
  });
}
