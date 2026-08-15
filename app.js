import {
  STORE_KEYS,
  LIMITS,
  createId,
  normalizeBlock,
  createComboItem,
  loadAppState,
  saveAppState,
  reconcileLegacyV2,
  writeLegacyV2Mirror,
  loadNumberPreference,
  savePreference,
  buildTimerSteps,
  normalizeTimerSnapshot,
  advanceTimerSnapshot
} from './app-core.js?v=35';
import { withCrossTabStorageMutex } from './storage-lock.js?v=35';
import { createCuePlayer } from './audio-player.js?v=35';

const $ = (id) => document.getElementById(id);
const VIEWS = new Set(['home', 'quick', 'menu', 'combo', 'savedMenus', 'savedCombos', 'run']);
const TIMER_KEY = STORE_KEYS.timer || 'interval_active_timer_v1';
const COMBO_DRAFT_KEY = STORE_KEYS.comboDraft || 'interval_combo_draft_v1';
const NAME_LIMIT = LIMITS.MAX_NAME_LENGTH || 60;
const TIMER_OWNER_ID = createId('timer_tab');
const COLLECTION_LOCK_OWNER_ID = createId('storage_tab');

const initialLoad = loadAppState(localStorage);
const initialData = initialLoad.state || initialLoad.data || {
  revision: 0,
  blocks: [],
  combos: []
};

const state = {
  blocks: initialData.blocks,
  combos: initialData.combos,
  revision: initialData.revision || 0,
  builder: [],
  editingBlockId: null,
  editingComboId: null,
  savedMenusEditing: false,
  savedCombosEditing: false,
  currentView: 'home',
  soundVolume: loadNumberPreference(
    localStorage,
    STORE_KEYS.SOUND_VOLUME || 'interval_sound_volume_v1',
    100,
    0,
    100
  ).value,
  timer: emptyTimer()
};

const cuePlayer = createCuePlayer({
  AudioClass: window.Audio,
  AudioContextClass: window.AudioContext || window.webkitAudioContext,
  mediaParent: document.body,
  base64Encode: window.btoa?.bind(window),
  initialVolume: state.soundVolume
});
let screenWakeLock = null;
let wakeLockRequest = null;
let noticeTimer = null;
let timerPersistSecond = null;
let handlingHistory = false;
let storageCommitQueue = Promise.resolve();
let storageInitialization = Promise.resolve();
let legacyStorageSyncTimer = null;

const el = {
  homeBtn: $('homeBtn'),
  homeSavedMenuCount: $('homeSavedMenuCount'),
  homeSavedComboCount: $('homeSavedComboCount'),
  comboCreateButton: $('comboCreateButton'),
  comboDraftBadge: $('comboDraftBadge'),
  dataStatus: $('dataStatus'),
  notice: $('notice'),
  confirmDialog: $('confirmDialog'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmAction: $('confirmAction'),

  quickForm: $('quickForm'),
  quickWork: $('quickWork'),
  quickRest: $('quickRest'),
  quickRepeat: $('quickRepeat'),
  quickName: $('quickName'),

  menuForm: $('menuForm'),
  menuName: $('menuName'),
  menuWork: $('menuWork'),
  menuRest: $('menuRest'),
  menuRepeat: $('menuRepeat'),
  menuSave: $('menuSave'),
  menuCancelEdit: $('menuCancelEdit'),
  menuEditBanner: $('menuEditBanner'),

  savedMenuPageList: $('savedMenuPageList'),
  savedMenuEditToggle: $('savedMenuEditToggle'),
  savedMenuEditHint: $('savedMenuEditHint'),

  availableList: $('availableList'),
  builderList: $('builderList'),
  comboName: $('comboName'),
  comboNameField: $('comboNameField'),
  comboSave: $('comboSave'),
  comboStart: $('comboStart'),
  comboClear: $('comboClear'),
  comboCancelEdit: $('comboCancelEdit'),
  comboTotal: $('comboTotal'),
  comboEditBanner: $('comboEditBanner'),
  comboEmptyGuide: $('comboEmptyGuide'),
  comboWorkspace: $('comboWorkspace'),
  savedComboPageList: $('savedComboPageList'),
  savedComboEditToggle: $('savedComboEditToggle'),
  savedComboEditHint: $('savedComboEditHint'),

  soundVolume: $('soundVolume'),
  soundVolumeValue: $('soundVolumeValue'),
  soundTest: $('soundTest'),
  soundHint: $('soundHint'),

  runTitle: $('runTitle'),
  blockNameTag: $('blockNameTag'),
  ring: $('ring'),
  phase: $('phase'),
  time: $('time'),
  step: $('step'),
  next: $('next'),
  totalLeft: $('totalLeft'),
  pause: $('pause'),
  wakeStatus: $('wakeStatus')
};

bindEvents();
registerServiceWorker();
restoreComboDraft();
render();
storageInitialization = handleInitialStorageState();

const restoredTimer = restoreTimer();
show(restoredTimer ? 'run' : routeFromLocation(), {
  history: 'replace',
  focus: false
});

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => show(button.dataset.view));
  });

  el.homeBtn.addEventListener('click', () => show('home'));
  el.quickForm.addEventListener('submit', (event) => {
    event.preventDefault();
    quickStart();
  });
  $('quickSave').addEventListener('click', () => void quickSave());
  el.menuForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveMenu();
  });
  el.menuCancelEdit.addEventListener('click', () => clearMenuEdit());
  el.savedMenuEditToggle.addEventListener('click', toggleSavedMenusEdit);

  el.comboSave.addEventListener('click', saveCombo);
  el.comboStart.addEventListener('click', startBuilder);
  el.comboClear.addEventListener('click', () => void requestClearComboBuilder());
  el.comboCancelEdit.addEventListener('click', () => void requestCancelComboEdit());
  el.comboName.addEventListener('input', persistComboDraft);
  el.savedComboEditToggle.addEventListener('click', toggleSavedCombosEdit);

  el.pause.addEventListener('click', pauseToggle);
  $('skip').addEventListener('click', skipStep);
  $('stop').addEventListener('click', () => void stop(false));
  el.soundVolume.addEventListener('input', updateSoundVolume);
  el.soundTest.addEventListener('click', () => void testSound());

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('popstate', () => void handlePopState());
  window.addEventListener('storage', handleStorageSync);
  window.addEventListener('beforeunload', handleBeforeUnload);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      setDataStatus(
        'オフライン利用の準備ができませんでした。オンラインでは引き続き利用できます。',
        'warning'
      );
    });
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

function routeFromLocation() {
  const route = location.hash.replace(/^#/, '');
  if (route === 'run') return state.timer.active ? 'run' : 'home';
  return VIEWS.has(route) ? route : 'home';
}

function routeUrl(id) {
  return id === 'home'
    ? `${location.pathname}${location.search}`
    : `${location.pathname}${location.search}#${id}`;
}

function show(id, options = {}) {
  if (!VIEWS.has(id)) id = 'home';
  if (id === 'run' && !state.timer.active) id = 'home';

  const historyMode = options.history ?? 'push';
  state.currentView = id;

  if (id !== 'savedMenus' && state.savedMenusEditing) {
    state.savedMenusEditing = false;
    updateSavedMenuEditUI();
    renderSavedMenuPage();
  }

  if (id !== 'savedCombos' && state.savedCombosEditing) {
    state.savedCombosEditing = false;
    updateSavedComboEditUI();
    renderSavedComboPage();
  }

  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === id);
  });

  el.homeBtn.classList.toggle('hidden', id === 'home' || id === 'run');
  document.body.classList.toggle('home-screen', id === 'home');
  document.body.classList.toggle('run-screen', id === 'run');

  if (historyMode === 'push') {
    history.pushState({ view: id }, '', routeUrl(id));
  } else if (historyMode === 'replace') {
    history.replaceState({ view: id }, '', routeUrl(id));
  }

  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

  if (options.focus !== false) {
    requestAnimationFrame(() => {
      const heading = id === 'home' ? document.querySelector('h1') : $(`${id}`)?.querySelector('h2, h3');
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    });
  }
}

async function handlePopState() {
  if (handlingHistory) return;
  const target = routeFromLocation();

  if (state.timer.active && target !== 'run') {
    handlingHistory = true;
    const shouldLeave = await askConfirm({
      title: 'タイマーを終了しますか？',
      message: '戻ると実行中のタイマーを終了します。',
      actionLabel: '終了する',
      danger: true
    });

    if (shouldLeave) {
      finishTimerSession();
      show(target, { history: 'replace' });
    } else {
      show('run', { history: 'push', focus: false });
    }

    handlingHistory = false;
    return;
  }

  show(target, { history: 'none' });
}

function render() {
  el.homeSavedMenuCount.textContent = state.blocks.length;
  el.homeSavedComboCount.textContent = state.combos.length;
  updateComboDraftBadge();

  updateSavedMenuEditUI();
  renderSavedMenuPage();
  renderAvailable();
  renderBuilder();
  updateSavedComboEditUI();
  renderSavedComboPage();
  updateMenuEditUI();
  updateComboEditUI();
  updateComboControls();
  updateComboTotal();
  updateSoundUI();
}

function validateForm(form) {
  if (form.checkValidity()) return true;
  form.reportValidity();
  showNotice('入力内容を確認してください', 'error');
  return false;
}

function readPositiveInteger(input) {
  return Number.parseInt(input.value, 10);
}

function normalizedName(value) {
  return value.trim().slice(0, NAME_LIMIT);
}

function nextAvailableName(base, items) {
  const names = new Set(items.map((item) => item.name));
  if (!names.has(base)) return base;

  let suffix = 2;
  while (names.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

function blockFromQuick() {
  return {
    id: createId(),
    name: normalizedName(el.quickName.value) || nextAvailableName('クイック', state.blocks),
    work: readPositiveInteger(el.quickWork),
    rest: readPositiveInteger(el.quickRest),
    repeat: readPositiveInteger(el.quickRepeat)
  };
}

function quickStart() {
  if (!validateForm(el.quickForm)) return;
  const block = blockFromQuick();
  start([block], block.name);
}

async function quickSave() {
  if (!validateForm(el.quickForm)) return;
  if (state.blocks.length >= LIMITS.MAX_BLOCKS) {
    showNotice(`保存できるメニューは${LIMITS.MAX_BLOCKS}件までです`, 'error');
    return;
  }
  const block = blockFromQuick();
  if (!await commitCollections([...state.blocks, block], state.combos)) return;

  el.quickName.value = '';
  render();
  show('savedMenus');
  showNotice(`${block.name}を保存しました`);
}

function menuFormBlock(id = createId()) {
  return {
    id,
    name: normalizedName(el.menuName.value),
    work: readPositiveInteger(el.menuWork),
    rest: readPositiveInteger(el.menuRest),
    repeat: readPositiveInteger(el.menuRepeat)
  };
}

async function saveMenu() {
  if (!validateForm(el.menuForm)) return;
  if (!state.editingBlockId && state.blocks.length >= LIMITS.MAX_BLOCKS) {
    showNotice(`保存できるメニューは${LIMITS.MAX_BLOCKS}件までです`, 'error');
    return;
  }

  const block = menuFormBlock(state.editingBlockId || createId());
  let nextBlocks;

  if (state.editingBlockId) {
    const index = state.blocks.findIndex((item) => item.id === state.editingBlockId);
    if (index < 0) {
      clearMenuEdit();
      showNotice('編集対象が見つかりません', 'error');
      return;
    }

    nextBlocks = state.blocks.map((item, itemIndex) => itemIndex === index ? block : item);
  } else {
    nextBlocks = [...state.blocks, block];
  }

  if (!await commitCollections(nextBlocks, state.combos)) return;

  state.editingBlockId = null;
  clearMenuForm();
  render();
  show('savedMenus');
  showNotice(`${block.name}を保存しました`);
}

function editBlock(id) {
  const block = state.blocks.find((item) => item.id === id);
  if (!block) {
    showNotice('メニューが見つかりません', 'error');
    return;
  }

  state.editingBlockId = id;
  el.menuName.value = block.name;
  el.menuWork.value = block.work;
  el.menuRest.value = block.rest;
  el.menuRepeat.value = block.repeat;
  updateMenuEditUI();
  show('menu');
}

function clearMenuForm() {
  el.menuForm.reset();
  el.menuWork.value = 30;
  el.menuRest.value = 15;
  el.menuRepeat.value = 4;
}

function clearMenuEdit(shouldRender = true) {
  state.editingBlockId = null;
  clearMenuForm();
  if (shouldRender) render();
}

function updateMenuEditUI() {
  const block = state.blocks.find((item) => item.id === state.editingBlockId);

  if (block) {
    const title = document.createElement('span');
    title.className = 'edit-title';
    title.textContent = '編集中';
    el.menuEditBanner.classList.remove('hidden');
    el.menuEditBanner.replaceChildren(
      title,
      document.createTextNode(`${block.name}を編集しています。保存済みの組み合わせは変更されません。`)
    );
    el.menuSave.textContent = '変更を保存';
    el.menuCancelEdit.classList.remove('hidden');
  } else {
    state.editingBlockId = null;
    el.menuEditBanner.classList.add('hidden');
    el.menuEditBanner.replaceChildren();
    el.menuSave.textContent = '保存';
    el.menuCancelEdit.classList.add('hidden');
  }
}

async function deleteBlock(id) {
  const block = state.blocks.find((item) => item.id === id);
  if (!block) return;

  const confirmed = await askConfirm({
    title: 'メニューを削除しますか？',
    message: `${block.name}を削除します。保存済みの組み合わせには影響しません。`,
    actionLabel: '削除する',
    danger: true
  });
  if (!confirmed) return;

  const nextBlocks = state.blocks.filter((item) => item.id !== id);
  if (!await commitCollections(nextBlocks, state.combos)) return;

  if (state.editingBlockId === id) clearMenuEdit(false);
  if (!state.blocks.length) state.savedMenusEditing = false;
  render();
  showNotice(`${block.name}を削除しました`);
}

function toggleSavedMenusEdit() {
  if (!state.blocks.length) return;
  state.savedMenusEditing = !state.savedMenusEditing;
  updateSavedMenuEditUI();
  renderSavedMenuPage();
}

function updateSavedMenuEditUI() {
  if (!state.blocks.length) state.savedMenusEditing = false;
  el.savedMenuEditToggle.disabled = state.blocks.length === 0;
  el.savedMenuEditToggle.textContent = state.savedMenusEditing ? '完了' : '編集';
  el.savedMenuEditToggle.classList.toggle('is-active', state.savedMenusEditing);
  el.savedMenuEditHint.classList.toggle('hidden', !state.savedMenusEditing);
}

function renderSavedMenuPage() {
  el.savedMenuPageList.classList.toggle('editing', state.savedMenusEditing);
  list(el.savedMenuPageList, state.blocks, 'まだ保存されたメニューはありません。', savedMenuCard);
}

function savedMenuCard(block) {
  const editing = state.savedMenusEditing;
  const buttons = editing
    ? [
        btn('内容編集', '', () => editBlock(block.id), { label: `${block.name}の内容を編集` }),
        btn('削除', 'red', () => void deleteBlock(block.id), { label: `${block.name}を削除` })
      ]
    : [btn('開始', 'blue', () => start([block], block.name), { label: `${block.name}を開始` })];

  const item = card(
    block.name,
    [`${block.work}秒 運動`, `${block.rest}秒 休憩`, `${block.repeat}回`],
    buttons
  );
  item.classList.add('saved-menu-card', editing ? 'editing' : 'normal');

  if (!editing) return item;

  item.classList.add('saved-menu-sortable');
  item.dataset.menuId = block.id;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'reorder-handle';
  handle.textContent = '長押しして移動';
  handle.setAttribute('aria-label', `${block.name}を並び替え。上下矢印キーも使えます`);
  item.prepend(handle);
  attachSavedMenuReorder(item, handle, block.id);
  return item;
}

async function moveSavedMenu(index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.blocks.length) return;

  const nextBlocks = [...state.blocks];
  [nextBlocks[index], nextBlocks[nextIndex]] = [nextBlocks[nextIndex], nextBlocks[index]];
  const moved = nextBlocks[nextIndex];
  if (!await commitCollections(nextBlocks, state.combos)) return;

  render();
  showNotice(`${moved.name}を${nextIndex + 1}番目に移動しました`);
  requestAnimationFrame(() => {
    const handle = el.savedMenuPageList.querySelector(`[data-menu-id="${CSS.escape(moved.id)}"] .reorder-handle`);
    handle?.focus();
  });
}

function attachSavedMenuReorder(item, handle, menuId) {
  let pressTimer = null;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let sorting = false;

  const clearPressTimer = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };

  const finishSort = () => {
    clearPressTimer();
    const wasSorting = sorting;
    sorting = false;

    if (pointerId !== null && handle.hasPointerCapture?.(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    pointerId = null;
    if (!wasSorting) return;

    item.classList.remove('is-dragging');
    void persistSavedMenuOrder();
  };

  handle.addEventListener('click', (event) => event.preventDefault());
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const index = state.blocks.findIndex((block) => block.id === menuId);
    void moveSavedMenu(index, event.key === 'ArrowUp' ? -1 : 1);
  });

  handle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    handle.setPointerCapture?.(pointerId);
    pressTimer = setTimeout(() => {
      sorting = true;
      item.classList.add('is-dragging');
      handle.textContent = '上下に動かしてください';
    }, 450);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!sorting) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) clearPressTimer();
      return;
    }

    event.preventDefault();
    if (event.clientY < 72) window.scrollBy(0, -8);
    if (event.clientY > window.innerHeight - 72) window.scrollBy(0, 8);

    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest('#savedMenuPageList .saved-menu-sortable');
    if (!target || target === item) return;

    const rect = target.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    el.savedMenuPageList.insertBefore(item, insertBefore ? target : target.nextSibling);
  });

  handle.addEventListener('pointerup', finishSort);
  handle.addEventListener('pointercancel', finishSort);
  handle.addEventListener('lostpointercapture', finishSort);
}

async function persistSavedMenuOrder() {
  const ids = [...el.savedMenuPageList.querySelectorAll('.saved-menu-sortable')]
    .map((item) => item.dataset.menuId);
  if (ids.length !== state.blocks.length || new Set(ids).size !== ids.length) {
    renderSavedMenuPage();
    showNotice('並び順を保存できませんでした', 'error');
    return;
  }

  const blocksById = new Map(state.blocks.map((block) => [block.id, block]));
  const nextBlocks = ids.map((id) => blocksById.get(id)).filter(Boolean);
  if (!await commitCollections(nextBlocks, state.combos)) {
    render();
    return;
  }

  render();
  showNotice('並び順を保存しました');
}

function renderAvailable() {
  list(el.availableList, state.blocks, '保存済みメニューがありません。', (block) =>
    card(
      block.name,
      [`${block.work}秒 運動`, `${block.rest}秒 休憩`, `${block.repeat}回`],
      [btn('追加', 'green', () => addBuilder(block.id), { label: `${block.name}を組み合わせに追加` })]
    )
  );
}

function addBuilder(id) {
  if (state.builder.length >= LIMITS.MAX_COMBO_ITEMS) {
    showNotice(`1つの組み合わせは${LIMITS.MAX_COMBO_ITEMS}メニューまでです`, 'error');
    return;
  }

  const block = state.blocks.find((item) => item.id === id);
  if (!block) {
    showNotice('メニューが見つかりません', 'error');
    return;
  }

  const item = createComboItem(block);
  if (!item) {
    showNotice('メニューを追加できませんでした', 'error');
    return;
  }

  state.builder = [...state.builder, item];
  renderBuilder();
  updateComboControls();
  updateComboTotal();
  persistComboDraft();
  showNotice(`${block.name}を追加しました`);
}

function renderBuilder() {
  list(el.builderList, state.builder, '追加したメニューがここに表示されます。', (block, index) =>
    card(
      `${index + 1}. ${block.name}`,
      [`${block.work}秒 運動`, `${block.rest}秒 休憩`, `${block.repeat}回`],
      [
        btn('上へ', '', () => moveBuilder(index, -1), {
          label: `${block.name}を上へ移動`,
          disabled: index === 0
        }),
        btn('下へ', '', () => moveBuilder(index, 1), {
          label: `${block.name}を下へ移動`,
          disabled: index === state.builder.length - 1
        }),
        btn('外す', 'red', () => removeBuilder(index), {
          label: `${block.name}を組み合わせから外す`
        })
      ]
    )
  );
}

function moveBuilder(index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.builder.length) return;
  const next = [...state.builder];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  state.builder = next;
  renderBuilder();
  updateComboTotal();
  persistComboDraft();
}

function removeBuilder(index) {
  state.builder = state.builder.filter((_, itemIndex) => itemIndex !== index);
  renderBuilder();
  updateComboControls();
  updateComboTotal();
  persistComboDraft();
}

function updateComboTotal() {
  const total = state.builder.reduce(
    (sum, block) => sum + (block.work + block.rest) * block.repeat,
    0
  );
  el.comboTotal.replaceChildren(
    document.createTextNode('合計 '),
    Object.assign(document.createElement('span'), { textContent: fmt(total) })
  );
}

function updateComboControls() {
  const hasBuilder = state.builder.length > 0;
  const hasSourceMenus = state.blocks.length > 0;
  el.comboEmptyGuide.classList.toggle('hidden', hasSourceMenus || hasBuilder);
  el.comboNameField.classList.toggle('hidden', !hasSourceMenus && !hasBuilder);
  el.comboWorkspace.classList.toggle('hidden', !hasSourceMenus && !hasBuilder);
  el.comboSave.disabled = !hasBuilder;
  el.comboStart.disabled = !hasBuilder;
  el.comboClear.disabled = !hasBuilder;
  el.comboName.disabled = !hasSourceMenus && !hasBuilder;
}

async function saveCombo() {
  if (!state.builder.length) return;
  if (!state.editingComboId && state.combos.length >= LIMITS.MAX_COMBOS) {
    showNotice(`保存できる組み合わせは${LIMITS.MAX_COMBOS}件までです`, 'error');
    return;
  }
  if (!el.comboName.reportValidity()) {
    showNotice('組み合わせ名を入力してください', 'error');
    return;
  }

  const name = normalizedName(el.comboName.value);
  const duplicate = state.combos.find(
    (combo) => combo.name === name && combo.id !== state.editingComboId
  );

  if (duplicate) {
    const confirmed = await askConfirm({
      title: '同じ名前で保存しますか？',
      message: `「${name}」はすでにあります。内容は別の組み合わせとして保存されます。`,
      actionLabel: '同名で保存'
    });
    if (!confirmed) return;
  }

  const combo = {
    id: state.editingComboId || createId('combo'),
    name,
    items: state.builder.map((item) => ({ ...item }))
  };

  let nextCombos;
  if (state.editingComboId) {
    const index = state.combos.findIndex((item) => item.id === state.editingComboId);
    if (index < 0) {
      showNotice('編集対象が見つかりません', 'error');
      return;
    }
    nextCombos = state.combos.map((item, itemIndex) => itemIndex === index ? combo : item);
  } else {
    nextCombos = [...state.combos, combo];
  }

  if (!await commitCollections(state.blocks, nextCombos)) return;

  clearComboBuilder(false);
  render();
  show('savedCombos');
  showNotice(`${combo.name}を保存しました`);
}

function startBuilder() {
  if (!state.builder.length) return;
  const name = normalizedName(el.comboName.value) || '組み合わせ';
  start(state.builder.map((item) => ({ ...item })), name);
}

async function requestClearComboBuilder() {
  if (!state.builder.length) return;
  const confirmed = await askConfirm({
    title: '組み合わせを空にしますか？',
    message: '現在追加しているメニューをすべて外します。',
    actionLabel: '空にする'
  });
  if (confirmed) clearComboBuilder();
}

async function requestCancelComboEdit() {
  if (!state.editingComboId) return;
  const confirmed = await askConfirm({
    title: '編集をやめますか？',
    message: '保存していない変更は破棄されます。',
    actionLabel: '編集をやめる'
  });
  if (!confirmed) return;
  clearComboBuilder();
  show('savedCombos');
}

function clearComboBuilder(shouldRender = true) {
  state.builder = [];
  state.editingComboId = null;
  el.comboName.value = '';
  clearComboDraft();
  if (shouldRender) render();
}

async function editCombo(id) {
  const combo = state.combos.find((item) => item.id === id);
  if (!combo) {
    showNotice('組み合わせが見つかりません', 'error');
    return;
  }

  if (hasComboDraft() && state.editingComboId !== id) {
    const confirmed = await askConfirm({
      title: '作成中の内容を置き換えますか？',
      message: '現在の下書きは破棄され、この組み合わせの内容に変わります。',
      actionLabel: '置き換える'
    });
    if (!confirmed) return;
  }

  state.editingComboId = id;
  state.builder = combo.items.map((item) => ({ ...item }));
  el.comboName.value = combo.name;
  persistComboDraft();
  render();
  show('combo');
}

async function duplicateCombo(id) {
  const combo = state.combos.find((item) => item.id === id);
  if (!combo) return;

  if (hasComboDraft()) {
    const confirmed = await askConfirm({
      title: '作成中の内容を置き換えますか？',
      message: '現在の下書きを破棄し、選んだ組み合わせのコピーを開きます。',
      actionLabel: 'コピーを開く'
    });
    if (!confirmed) return;
  }

  state.editingComboId = null;
  state.builder = combo.items.map((item) => ({
    ...item,
    id: createId('item')
  }));
  el.comboName.value = nextAvailableName(`${combo.name} コピー`, state.combos);
  persistComboDraft();
  render();
  show('combo');
}

async function deleteCombo(id) {
  const combo = state.combos.find((item) => item.id === id);
  if (!combo) return;

  const confirmed = await askConfirm({
    title: '組み合わせを削除しますか？',
    message: `${combo.name}を削除します。元のメニューは残ります。`,
    actionLabel: '削除する',
    danger: true
  });
  if (!confirmed) return;

  const nextCombos = state.combos.filter((item) => item.id !== id);
  if (!await commitCollections(state.blocks, nextCombos)) return;

  if (state.editingComboId === id) clearComboBuilder(false);
  if (!state.combos.length) state.savedCombosEditing = false;
  render();
  showNotice(`${combo.name}を削除しました`);
}

function updateComboEditUI() {
  const combo = state.combos.find((item) => item.id === state.editingComboId);
  if (combo) {
    const title = document.createElement('span');
    title.className = 'edit-title';
    title.textContent = '編集中';
    el.comboEditBanner.classList.remove('hidden');
    el.comboEditBanner.replaceChildren(
      title,
      document.createTextNode(`${combo.name}を編集しています。`)
    );
    el.comboSave.textContent = '変更を保存';
    el.comboCancelEdit.classList.remove('hidden');
  } else {
    state.editingComboId = null;
    el.comboEditBanner.classList.add('hidden');
    el.comboEditBanner.replaceChildren();
    el.comboSave.textContent = '組み合わせを保存';
    el.comboCancelEdit.classList.add('hidden');
  }
}

function toggleSavedCombosEdit() {
  if (!state.combos.length) return;
  state.savedCombosEditing = !state.savedCombosEditing;
  updateSavedComboEditUI();
  renderSavedComboPage();
}

function updateSavedComboEditUI() {
  if (!state.combos.length) state.savedCombosEditing = false;
  el.savedComboEditToggle.disabled = state.combos.length === 0;
  el.savedComboEditToggle.textContent = state.savedCombosEditing ? '完了' : '編集';
  el.savedComboEditToggle.classList.toggle('is-active', state.savedCombosEditing);
  el.savedComboEditHint.classList.toggle('hidden', !state.savedCombosEditing);
}

function savedComboCard(combo) {
  const total = combo.items.reduce(
    (sum, block) => sum + (block.work + block.rest) * block.repeat,
    0
  );
  const editing = state.savedCombosEditing;
  const buttons = editing
    ? [
        btn('編集', '', () => void editCombo(combo.id), { label: `${combo.name}を編集` }),
        btn('複製', '', () => void duplicateCombo(combo.id), { label: `${combo.name}を複製して編集` }),
        btn('削除', 'red', () => void deleteCombo(combo.id), { label: `${combo.name}を削除` })
      ]
    : [btn('開始', 'blue', () => start(combo.items, combo.name), { label: `${combo.name}を開始` })];

  const item = card(
    combo.name,
    [
      `${combo.items.length}メニュー`,
      `合計 ${fmt(total)}`,
      combo.items.map((block) => block.name).join(' / ')
    ],
    buttons
  );
  item.classList.add('saved-combo-card', editing ? 'editing' : 'normal');
  return item;
}

function renderSavedComboPage() {
  list(
    el.savedComboPageList,
    state.combos,
    'まだ保存された組み合わせはありません。',
    savedComboCard
  );
}

function hasComboDraft() {
  return state.builder.length > 0 || normalizedName(el.comboName.value) !== '';
}

function persistComboDraft() {
  if (!hasComboDraft() && !state.editingComboId) {
    clearComboDraft();
    return;
  }

  updateComboDraftBadge(true);

  const result = savePreference(sessionStorage, COMBO_DRAFT_KEY, {
    version: 1,
    editingComboId: state.editingComboId,
    name: el.comboName.value,
    items: state.builder
  });
  if (!result.ok) {
    setDataStatus('組み合わせの下書きを保存できません。空き容量やブラウザ設定を確認してください。', 'error');
  }
}

function restoreComboDraft() {
  let raw;
  try {
    const value = sessionStorage.getItem(COMBO_DRAFT_KEY);
    raw = value === null ? null : JSON.parse(value);
  } catch {
    setDataStatus('前回の組み合わせ下書きを読み込めませんでした。', 'error');
    return;
  }

  if (!raw || raw.version !== 1 || !Array.isArray(raw.items)) return;

  const usedIds = new Set();
  state.builder = raw.items.slice(0, LIMITS.MAX_COMBO_ITEMS).map((item) => {
    const normalized = normalizeBlock(item);
    if (!normalized) return null;
    let id = normalized.id;
    if (usedIds.has(id)) id = createId('item');
    usedIds.add(id);
    return {
      ...normalized,
      id,
      sourceId: typeof item.sourceId === 'string' ? item.sourceId : normalized.id
    };
  }).filter(Boolean);

  state.editingComboId = state.combos.some((combo) => combo.id === raw.editingComboId)
    ? raw.editingComboId
    : null;
  el.comboName.value = typeof raw.name === 'string' ? raw.name.slice(0, NAME_LIMIT) : '';
}

function clearComboDraft() {
  updateComboDraftBadge(false);
  try {
    sessionStorage.removeItem(COMBO_DRAFT_KEY);
  } catch {
    setDataStatus('組み合わせの下書きを消去できませんでした。', 'error');
  }
}

function updateComboDraftBadge(hasDraft = hasComboDraft()) {
  el.comboDraftBadge.textContent = hasDraft ? '下書き' : '›';
  el.comboCreateButton.setAttribute(
    'aria-label',
    hasDraft ? '組み合わせを作る（下書きあり）' : '組み合わせを作る'
  );
}

function emptyTimer() {
  return {
    active: false,
    paused: false,
    title: '',
    steps: [],
    index: 0,
    remaining: 0,
    duration: 0,
    totalLeft: 0,
    id: null,
    beeped: null,
    lastTickAt: null
  };
}

function start(blocks, title) {
  const steps = buildTimerSteps(blocks, 5);
  if (!steps.length) {
    showNotice('タイマーを開始できませんでした', 'error');
    return;
  }

  clearInterval(state.timer.id);
  state.timer = {
    active: true,
    paused: false,
    title: normalizedName(title) || 'インターバル',
    steps,
    index: 0,
    remaining: steps[0].duration,
    duration: steps[0].duration,
    totalLeft: steps.reduce((sum, step) => sum + step.duration, 0),
    id: null,
    beeped: null,
    lastTickAt: Date.now()
  };

  void playCue('ready').then((played) => {
    if (!played && state.soundVolume > 0 && state.timer.active) {
      showNotice('通知音を有効にできません。ホームの「音を試す」で確認してください', 'error');
    }
  });
  persistTimer();
  show('run');
  drawRun();
  state.timer.id = setInterval(tick, 250);
  requestWakeLock();
}

function tick() {
  const timer = state.timer;
  if (!timer.active || timer.paused) return;

  const now = Date.now();
  if (!Number.isFinite(timer.lastTickAt)) {
    timer.lastTickAt = now;
    return;
  }

  let elapsed = Math.max(0, (now - timer.lastTickAt) / 1000);
  timer.lastTickAt = now;
  let changedStep = false;

  while (timer.active && elapsed >= timer.remaining) {
    elapsed -= timer.remaining;
    timer.totalLeft = Math.max(0, timer.totalLeft - timer.remaining);
    timer.remaining = 0;
    if (!nextStep(false, true)) return;
    changedStep = true;
  }

  if (!timer.active) return;
  timer.remaining = Math.max(0, timer.remaining - elapsed);
  timer.totalLeft = Math.max(0, timer.totalLeft - elapsed);

  if (changedStep) {
    playCurrentPhaseCue();
    if (timer.remaining <= 3) timer.beeped = Math.ceil(timer.remaining);
  }

  const second = Math.ceil(timer.remaining);
  if (second <= 3 && second >= 1 && timer.beeped !== second) {
    void playCue('countdown');
    timer.beeped = second;
  }

  drawRun();
  const totalSecond = Math.ceil(timer.totalLeft);
  if (timerPersistSecond !== totalSecond) {
    timerPersistSecond = totalSecond;
    persistTimer();
  }
}

function nextStep(fromSkip = false, silent = false) {
  const timer = state.timer;
  if (!timer.active) return false;

  if (fromSkip && timer.remaining > 0) {
    timer.totalLeft = Math.max(0, timer.totalLeft - timer.remaining);
  }

  timer.index += 1;
  timer.beeped = null;
  if (timer.index >= timer.steps.length) {
    completeTimer();
    return false;
  }

  timer.remaining = timer.steps[timer.index].duration;
  timer.duration = timer.steps[timer.index].duration;
  timer.lastTickAt = Date.now();
  if (!silent) {
    playCurrentPhaseCue();
    if (timer.remaining <= 3) timer.beeped = Math.ceil(timer.remaining);
  }

  persistTimer();
  drawRun();
  return true;
}

function pauseToggle() {
  const timer = state.timer;
  if (!timer.active) return;

  if (timer.paused) {
    void cuePlayer.unlock();
    timer.paused = false;
    timer.lastTickAt = Date.now();
    requestWakeLock();
  } else {
    tick();
    timer.paused = true;
    timer.lastTickAt = null;
    releaseWakeLock();
  }

  el.pause.textContent = timer.paused ? '再開' : '一時停止';
  persistTimer();
  drawRun();
}

function skipStep() {
  if (!state.timer.active) return;
  if (!state.timer.paused) tick();
  nextStep(true);
}

async function stop(done) {
  if (!state.timer.active) return;

  if (!done) {
    const confirmed = await askConfirm({
      title: 'タイマーを終了しますか？',
      message: 'ここまでの進行は終了し、ホームへ戻ります。',
      actionLabel: '終了する',
      danger: true
    });
    if (!confirmed) return;
  }

  if (done) {
    completeTimer();
  } else {
    finishTimerSession();
    show('home', { history: 'replace' });
  }
}

function completeTimer() {
  void playCue('complete');
  finishTimerSession();
  show('home', { history: 'replace' });
  showNotice('メニューが完了しました');
}

function finishTimerSession({ clearStorage = true } = {}) {
  clearInterval(state.timer.id);
  state.timer = emptyTimer();
  timerPersistSecond = null;
  el.pause.textContent = '一時停止';
  releaseWakeLock();
  if (clearStorage) clearStoredTimer();
}

function drawRun() {
  const timer = state.timer;
  const step = timer.steps[timer.index];
  if (!step) return;

  const isStart = step.phase === 'START';
  const isWork = step.phase === 'WORK';
  const progress = timer.duration
    ? ((timer.duration - timer.remaining) / timer.duration) * 100
    : 100;

  el.runTitle.textContent = timer.title;
  el.blockNameTag.textContent = step.block;
  el.blockNameTag.classList.toggle('hidden', isStart);
  el.phase.textContent = timer.paused ? '一時停止' : isStart ? '準備' : isWork ? '運動' : '休憩';
  el.phase.style.color = timer.paused
    ? 'var(--muted)'
    : isStart
      ? 'var(--blue)'
      : isWork
        ? 'var(--green)'
        : 'var(--orange)';
  el.time.textContent = fmt(timer.remaining);
  el.step.textContent = isStart ? '準備' : `${step.round} / ${step.repeat}`;
  el.totalLeft.textContent = fmt(timer.totalLeft);
  el.pause.setAttribute('aria-pressed', String(timer.paused));
  el.ring.classList.toggle('is-paused', timer.paused);
  el.ring.style.setProperty('--progress', progress.toFixed(2));
  el.ring.style.setProperty(
    '--phaseColor',
    isStart ? 'var(--blue)' : isWork ? 'var(--green)' : 'var(--orange)'
  );

  const next = timer.steps[timer.index + 1];
  const nextPhase = next?.phase === 'WORK' ? '運動' : next?.phase === 'REST' ? '休憩' : '準備';
  el.next.textContent = next ? `${nextPhase} ${fmt(next.duration)}` : '終了';
  drawUpcomingMenus();
}

function drawUpcomingMenus() {
  const root = $('upcomingMenus');
  const timer = state.timer;
  const current = timer.steps[timer.index]?.block;
  const names = [];

  for (let index = timer.index + 1; index < timer.steps.length; index += 1) {
    const name = timer.steps[index].block;
    if (!name || name === '準備' || name === current) continue;
    if (!names.includes(name)) names.push(name);
  }

  if (!names.length) {
    root.replaceChildren();
    return;
  }

  const title = document.createElement('div');
  title.className = 'upcoming-title';
  title.textContent = '次以降のメニュー';
  const listRoot = document.createElement('div');
  listRoot.className = 'upcoming-list';
  names.forEach((name) => {
    const item = document.createElement('span');
    item.textContent = name;
    listRoot.appendChild(item);
  });
  root.replaceChildren(title, listRoot);
}

function timerSnapshot() {
  if (!state.timer.active) return null;
  return normalizeTimerSnapshot({
    active: true,
    paused: state.timer.paused,
    title: state.timer.title,
    steps: state.timer.steps,
    index: state.timer.index,
    remaining: state.timer.remaining
  });
}

function persistTimer() {
  const snapshot = timerSnapshot();
  if (!snapshot) return;
  const result = savePreference(localStorage, TIMER_KEY, {
    version: 1,
    ownerId: TIMER_OWNER_ID,
    savedAt: Date.now(),
    snapshot
  });
  if (!result.ok) {
    setDataStatus('タイマーの復元情報を保存できません。再読み込みは避けてください。', 'error');
  }
}

function restoreTimer() {
  let stored;
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    stored = raw === null ? null : JSON.parse(raw);
  } catch {
    setDataStatus('前回のタイマー情報を読み込めませんでした。', 'error');
    return false;
  }

  if (!stored || stored.version !== 1) return false;
  let snapshot = normalizeTimerSnapshot(stored.snapshot);
  if (!snapshot || !snapshot.active) {
    clearStoredTimer();
    return false;
  }

  const wasRunning = !snapshot.paused;
  if (wasRunning) {
    const elapsed = Math.max(0, (Date.now() - Number(stored.savedAt || Date.now())) / 1000);
    snapshot = advanceTimerSnapshot(snapshot, elapsed);
  }

  if (!snapshot?.active) {
    clearStoredTimer();
    queueMicrotask(() => showNotice('前回のタイマーは完了しています'));
    return false;
  }

  state.timer = {
    ...snapshot,
    paused: true,
    id: null,
    beeped: null,
    lastTickAt: null
  };
  el.pause.textContent = '再開';
  updateWakeStatus('一時停止中はスリープを許可します', 'idle');
  drawRun();
  state.timer.id = setInterval(tick, 250);
  persistTimer();
  showNotice(
    wasRunning
      ? 'タイマーを復元して一時停止しました。再開すると通知音が有効になります'
      : '一時停止中のタイマーを復元しました'
  );
  return true;
}

function clearStoredTimer() {
  try {
    localStorage.removeItem(TIMER_KEY);
  } catch {
    setDataStatus('完了したタイマー情報を消去できませんでした。', 'error');
  }
}

function handleBeforeUnload() {
  persistComboDraft();
  if (!state.timer.active) return;
  persistTimer();
}

function updateSoundVolume() {
  state.soundVolume = Math.min(100, Math.max(0, Number(el.soundVolume.value) || 0));
  const result = savePreference(
    localStorage,
    STORE_KEYS.SOUND_VOLUME || 'interval_sound_volume_v1',
    state.soundVolume
  );
  if (!result.ok) {
    setDataStatus('通知音量を保存できませんでした。', 'error');
  }

  updateSoundUI();
  cuePlayer.setVolume(state.soundVolume);
}

function updateSoundUI() {
  el.soundVolume.value = state.soundVolume;
  el.soundVolumeValue.textContent = state.soundVolume === 0 ? 'ミュート' : `${state.soundVolume}%`;
  el.soundHint.textContent = state.soundVolume === 0
    ? '通知音はミュートされています。'
    : '短い単音です。端末のメディア音量にも連動します。';
}

async function testSound() {
  const played = await playCue('preview');
  if (!played) {
    showNotice(
      state.soundVolume === 0
        ? '通知音はミュートされています'
        : '通知音を再生できません。端末のメディア音量を確認してください',
      'error'
    );
    return;
  }

  showNotice('通知音を再生しました');
}

function playCue(kind) {
  return cuePlayer.play(kind);
}

function playCurrentPhaseCue() {
  const phase = state.timer.steps[state.timer.index]?.phase;
  if (phase === 'WORK') void playCue('work');
  if (phase === 'REST') void playCue('rest');
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    updateWakeStatus('この端末ではスリープ防止を利用できません', 'unsupported');
    return false;
  }

  if (!state.timer.active || state.timer.paused) return false;
  if (document.visibilityState !== 'visible') {
    updateWakeStatus('画面に戻るとスリープ防止を再開します', 'idle');
    return false;
  }

  if (screenWakeLock && !screenWakeLock.released) {
    updateWakeStatus('画面のスリープを防止中', 'active');
    return true;
  }
  if (wakeLockRequest) return wakeLockRequest;

  updateWakeStatus('スリープ防止を準備中', 'idle');
  wakeLockRequest = navigator.wakeLock.request('screen')
    .then((lock) => {
      if (!state.timer.active || state.timer.paused || document.visibilityState !== 'visible') {
        lock.release().catch(() => {});
        return false;
      }

      if (screenWakeLock && screenWakeLock !== lock && !screenWakeLock.released) {
        lock.release().catch(() => {});
        return true;
      }

      screenWakeLock = lock;
      updateWakeStatus('画面のスリープを防止中', 'active');
      lock.addEventListener('release', () => {
        if (screenWakeLock === lock) screenWakeLock = null;
        if (!state.timer.active) return;

        if (state.timer.paused) {
          updateWakeStatus('一時停止中はスリープを許可します', 'idle');
        } else if (document.visibilityState !== 'visible') {
          updateWakeStatus('画面に戻るとスリープ防止を再開します', 'idle');
        } else {
          updateWakeStatus('スリープ防止を再接続しています', 'idle');
          window.setTimeout(() => requestWakeLock(), 700);
        }
      });
      return true;
    })
    .catch(() => {
      screenWakeLock = null;
      updateWakeStatus('この端末ではスリープ防止を利用できません', 'unsupported');
      return false;
    })
    .finally(() => {
      wakeLockRequest = null;
    });

  return wakeLockRequest;
}

function releaseWakeLock() {
  const lock = screenWakeLock;
  screenWakeLock = null;
  if (lock && !lock.released) lock.release().catch(() => {});
  if (state.timer.active && state.timer.paused) {
    updateWakeStatus('一時停止中はスリープを許可します', 'idle');
  }
}

function handleVisibilityChange() {
  if (!state.timer.active) return;
  if (document.visibilityState === 'visible' && !state.timer.paused) {
    tick();
    requestWakeLock();
  } else {
    persistTimer();
  }
}

function updateWakeStatus(message, status) {
  el.wakeStatus.textContent = message;
  el.wakeStatus.dataset.state = status;
}

async function withCollectionStorageLock(task) {
  if (navigator.locks?.request) {
    return navigator.locks.request(
      'interval-timer-app-state',
      { mode: 'exclusive' },
      task
    );
  }

  const runWithFallbackLock = () => withCrossTabStorageMutex(
    globalThis.indexedDB,
    { ownerId: COLLECTION_LOCK_OWNER_ID },
    task
  );
  storageCommitQueue = storageCommitQueue.then(runWithFallbackLock, runWithFallbackLock);
  return storageCommitQueue;
}

function applyCollectionState(data) {
  state.blocks = data.blocks;
  state.combos = data.combos;
  state.revision = data.revision;
  reconcileEditingState();
  render();
}

function collectionStateFingerprint(data) {
  try {
    return JSON.stringify([data?.blocks, data?.combos]);
  } catch {
    return null;
  }
}

function collectionStateMatches(data) {
  if (!data || data.revision !== state.revision) return false;
  const incoming = collectionStateFingerprint(data);
  return incoming !== null && incoming === collectionStateFingerprint(state);
}

function synchronizeStoredCollections(loaded = loadAppState(localStorage)) {
  if (!loaded.ok) {
    return {
      ok: false,
      code: loaded.code || 'STORAGE_READ_FAILED',
      error: loaded.error,
      data: loaded.data || null
    };
  }

  if (loaded.source !== 'v3' || loaded.migrated || loaded.repaired) {
    const saved = saveAppState(
      localStorage,
      loaded.data,
      loaded.data.revision
    );
    if (!saved.ok) return saved;

    return {
      ok: true,
      data: saved.data,
      changed: true,
      migrated: loaded.source !== 'empty' && loaded.migrated,
      repaired: loaded.repaired,
      initialized: loaded.source === 'empty',
      importedLegacy: false,
      legacy: null,
      mirror: writeLegacyV2Mirror(localStorage, saved.data)
    };
  }

  const legacy = reconcileLegacyV2(localStorage, loaded.data);
  if (legacy.ok && legacy.changed) {
    const saved = saveAppState(
      localStorage,
      legacy.data,
      loaded.data.revision
    );
    if (!saved.ok) return saved;

    return {
      ok: true,
      data: saved.data,
      changed: true,
      migrated: false,
      repaired: Boolean(legacy.repaired),
      initialized: false,
      importedLegacy: true,
      legacy,
      mirror: writeLegacyV2Mirror(localStorage, saved.data)
    };
  }

  const mirror = legacy.needsMirror
    ? writeLegacyV2Mirror(localStorage, loaded.data)
    : null;
  return {
    ok: true,
    data: loaded.data,
    changed: false,
    migrated: false,
    repaired: false,
    initialized: false,
    importedLegacy: false,
    legacy,
    mirror
  };
}

function legacySyncIssue(sync) {
  if (sync?.mirror) return sync.mirror.ok ? null : sync.mirror;
  if (sync?.legacy && !sync.legacy.ok) return sync.legacy;
  return null;
}

function legacySyncBlocksCommit(issue) {
  return Boolean(issue?.needsReload) || [
    'RECONCILE_RACE',
    'LEGACY_MIRROR_RACE',
    'LEGACY_V2_CHANGES_PENDING'
  ].includes(issue?.code);
}

function showLegacySyncWarning(issue) {
  if (!issue) {
    if (el.dataStatus.dataset.source === 'legacy-sync') {
      el.dataStatus.textContent = '';
      delete el.dataStatus.dataset.kind;
      delete el.dataStatus.dataset.source;
      el.dataStatus.classList.add('hidden');
    }
    return;
  }
  const pending = [
    'LEGACY_V2_CHANGES_PENDING',
    'LEGACY_UNMARKED_V2_DATA',
    'LEGACY_SYNC_MARKER_STALE'
  ].includes(issue.code);
  setDataStatus(
    pending
      ? '古い画面の未反映データを保護しています。ほかのタブを閉じ、この画面の保存内容を確認してください。'
      : '保存内容は保持されていますが、古い画面との互換同期を完了できませんでした。',
    'warning',
    'legacy-sync'
  );
}

async function handleInitialStorageState() {
  let synced;
  try {
    synced = await withCollectionStorageLock(() => synchronizeStoredCollections());
  } catch {
    setDataStatus('保存データの更新処理を開始できませんでした。', 'error');
    return;
  }

  if (!synced.ok) {
    setDataStatus(
      synced.error
        ? `保存データを安全に読み込めませんでした。${synced.error}`
        : '保存データを安全に読み込めませんでした。',
      'error'
    );
    return;
  }

  if (synced.changed || !collectionStateMatches(synced.data)) {
    applyCollectionState(synced.data);
  }

  if (synced.importedLegacy) {
    setDataStatus('古い画面で変更された保存内容を取り込みました。内容を確認してください。', 'warning');
  } else if (synced.repaired) {
    setDataStatus('一部の保存データを安全な形式に修復しました。内容を確認してください。', 'warning');
  } else if (synced.migrated) {
    setDataStatus('保存データを新しい形式へ更新しました。', 'warning');
  }
  showLegacySyncWarning(legacySyncIssue(synced));
}

async function commitCollections(nextBlocks, nextCombos) {
  const requestedRevision = state.revision;
  const requestedFingerprint = collectionStateFingerprint(state);
  await storageInitialization;
  if (state.revision !== requestedRevision
    || requestedFingerprint === null
    || collectionStateFingerprint(state) !== requestedFingerprint) {
    setDataStatus('起動時に保存内容を更新しました。内容を確認して操作をやり直してください。', 'warning');
    showNotice('最新の保存内容を反映しました');
    return false;
  }
  const expectedRevision = requestedRevision;
  let result;

  try {
    result = await withCollectionStorageLock(() => {
      const latest = loadAppState(localStorage);
      if (!latest.ok) return latest;
      if (latest.data.revision !== expectedRevision || !collectionStateMatches(latest.data)) {
        return {
          ok: false,
          code: 'REVISION_CONFLICT',
          data: latest.data,
          error: '別の画面で保存内容が更新されています。'
        };
      }

      let synced = synchronizeStoredCollections(latest);
      if (!synced.ok) return synced;
      if (legacySyncBlocksCommit(legacySyncIssue(synced))) {
        synced = synchronizeStoredCollections();
        if (!synced.ok) return synced;
      }
      if (synced.changed) {
        return {
          ok: false,
          code: 'STORAGE_REFRESHED',
          data: synced.data,
          sync: synced,
          error: '別の画面の変更を先に反映しました。'
        };
      }

      const preflightIssue = legacySyncIssue(synced);
      if (legacySyncBlocksCommit(preflightIssue)) {
        return {
          ok: false,
          code: 'STORAGE_SYNC_BLOCKED',
          data: synced.data,
          sync: synced,
          error: '別の画面の保存内容を安全に確認してから、もう一度操作してください。'
        };
      }

      const saved = saveAppState(
        localStorage,
        {
          version: 3,
          revision: expectedRevision,
          blocks: nextBlocks,
          combos: nextCombos
        },
        expectedRevision
      );
      if (!saved.ok) return saved;

      return {
        ...saved,
        preflightIssue,
        mirror: writeLegacyV2Mirror(localStorage, saved.data)
      };
    });
  } catch {
    setDataStatus('保存処理を開始できませんでした。入力内容はこの画面に残っています。', 'error');
    showNotice('保存できませんでした', 'error');
    return false;
  }

  if (!result.ok) {
    if (['REVISION_CONFLICT', 'STORAGE_REFRESHED', 'STORAGE_SYNC_BLOCKED'].includes(result.code) && result.data) {
      applyCollectionState(result.data);
      setDataStatus(
        result.code === 'STORAGE_SYNC_BLOCKED'
          ? '別の画面の保存内容を確認しています。少し待ってから操作をやり直してください。'
          : '別の画面で変更されたため、最新の保存内容を読み込みました。操作をやり直してください。',
        'warning'
      );
      showLegacySyncWarning(legacySyncIssue(result.sync));
      showNotice(
        result.code === 'STORAGE_SYNC_BLOCKED'
          ? '保存内容を確認中です。もう一度お試しください'
          : '最新の保存内容を反映しました'
      );
    } else {
      setDataStatus('保存できませんでした。入力内容はこの画面に残っています。空き容量やブラウザ設定を確認してください。', 'error');
      showNotice('保存できませんでした', 'error');
    }
    return false;
  }

  if (!result.mirror?.ok && result.mirror?.needsReload) {
    const latest = loadAppState(localStorage);
    const recovered = latest.ok ? latest.data : result.mirror.actualData;
    if (recovered) applyCollectionState(recovered);
    setDataStatus('別の画面で同時に保存されたため、最新の保存内容を読み込みました。操作をやり直してください。', 'warning');
    showNotice('同時保存を検出しました。もう一度お試しください');
    return false;
  }

  applyCollectionState(result.data);
  showLegacySyncWarning(result.mirror?.ok ? null : (result.mirror || result.preflightIssue));
  return true;
}

async function synchronizeLegacyStorageChange() {
  await storageInitialization;
  let synced;
  try {
    synced = await withCollectionStorageLock(() => synchronizeStoredCollections());
  } catch {
    setDataStatus('別の画面の保存内容を確認できませんでした。', 'error');
    return;
  }

  if (!synced.ok) {
    setDataStatus('別の画面の保存内容を安全に反映できませんでした。', 'error');
    return;
  }

  if (synced.changed || !collectionStateMatches(synced.data)) {
    applyCollectionState(synced.data);
    showNotice('別の画面の変更を反映しました');
  }
  showLegacySyncWarning(legacySyncIssue(synced));
}

function handleStorageSync(event) {
  if (event.key === TIMER_KEY) {
    if (!state.timer.active) return;

    let ownerId = null;
    if (event.newValue) {
      try {
        ownerId = JSON.parse(event.newValue)?.ownerId || null;
      } catch {
        // A broken timer record from another tab should not keep two timers running.
      }
    }

    if (!event.newValue || ownerId !== TIMER_OWNER_ID) {
      finishTimerSession({ clearStorage: false });
      show('home', { history: 'replace' });
      showNotice(
        event.newValue
          ? '別のタブでタイマーを開いたため、この画面のタイマーを停止しました'
          : '別のタブでタイマーが終了しました'
      );
    }
    return;
  }

  if ([
    STORE_KEYS.APP_STATE,
    STORE_KEYS.BLOCKS_V2,
    STORE_KEYS.COMBOS_V2,
    STORE_KEYS.LEGACY_SYNC_V2
  ].includes(event.key)) {
    clearTimeout(legacyStorageSyncTimer);
    legacyStorageSyncTimer = setTimeout(() => void synchronizeLegacyStorageChange(), 80);
  }
}

function reconcileEditingState() {
  if (!state.blocks.some((block) => block.id === state.editingBlockId)) {
    state.editingBlockId = null;
  }
  if (!state.combos.some((combo) => combo.id === state.editingComboId)) {
    state.editingComboId = null;
  }
}

function setDataStatus(message, kind = 'warning', source = 'general') {
  el.dataStatus.textContent = message;
  el.dataStatus.dataset.kind = kind;
  el.dataStatus.dataset.source = source;
  el.dataStatus.classList.remove('hidden');
}

function showNotice(message, kind = 'info') {
  clearTimeout(noticeTimer);
  el.notice.textContent = message;
  el.notice.dataset.kind = kind;
  el.notice.classList.remove('hidden');
  noticeTimer = setTimeout(() => {
    el.notice.classList.add('hidden');
  }, kind === 'error' ? 5000 : 3200);
}

function askConfirm({ title, message, actionLabel, danger = false }) {
  if (typeof el.confirmDialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  if (el.confirmDialog.open) el.confirmDialog.close('cancel');
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmAction.textContent = actionLabel;
  el.confirmAction.classList.toggle('danger', danger);
  el.confirmAction.classList.toggle('primary', !danger);

  return new Promise((resolve) => {
    const handleClose = () => resolve(el.confirmDialog.returnValue === 'confirm');
    el.confirmDialog.addEventListener('close', handleClose, { once: true });
    el.confirmDialog.showModal();
  });
}

function list(root, items, emptyText, builder) {
  if (!root) return;
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    root.appendChild(empty);
    return;
  }
  items.forEach((item, index) => root.appendChild(builder(item, index)));
}

function card(title, metrics, buttons) {
  const item = document.createElement('div');
  item.className = 'item';
  const titleElement = document.createElement('div');
  titleElement.className = 'item-title';
  titleElement.textContent = title;
  const metricsElement = document.createElement('div');
  metricsElement.className = 'metrics';
  metrics.filter(Boolean).forEach((metric) => {
    const span = document.createElement('span');
    span.textContent = metric;
    metricsElement.appendChild(span);
  });
  const actions = document.createElement('div');
  actions.className = 'small-actions';
  buttons.forEach((button) => actions.appendChild(button));
  item.append(titleElement, metricsElement, actions);
  return item;
}

function btn(text, className, handler, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `small ${className || ''}`;
  button.textContent = text;
  button.disabled = Boolean(options.disabled);
  if (options.label) button.setAttribute('aria-label', options.label);
  button.addEventListener('click', handler);
  return button;
}

function fmt(value) {
  const secondsTotal = Math.max(0, Math.ceil(Number(value) || 0));
  const minutes = String(Math.floor(secondsTotal / 60)).padStart(2, '0');
  const seconds = String(secondsTotal % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
