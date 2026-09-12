// Optional DOM integration check: node scripts/verify-ui.mjs <path-to-jsdom-api.js>
// Uses simulated geometry; it does not claim to verify real browser layout/audio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as core from '../app-core.js';
const { JSDOM } = await import(pathToFileURL(process.argv[2]).href);
const root = new URL('../', import.meta.url);
const dom = new JSDOM(readFileSync(new URL('index.html', root), 'utf8'), { url: 'https://timer.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.scrollTo = w.scrollBy = () => {};
w.matchMedia = () => ({ matches: true });
w.CSS = { escape: value => value };
w.HTMLElement.prototype.setPointerCapture = function () { this.captured = true; };
w.HTMLElement.prototype.hasPointerCapture = function () { return !!this.captured; };
w.HTMLElement.prototype.releasePointerCapture = function () { this.captured = false; };
w.HTMLElement.prototype.getAnimations = () => [];
w.HTMLElement.prototype.animate = () => ({ cancel() {} });
Object.assign(w, core, { createCuePlayer: () => ({ prepare() {}, play: async () => true, unlock: async () => true, setVolume() {} }) });
Object.defineProperty(w.navigator, 'locks', { value: { request: async (_name, _options, task) => task() } });
for (const [file, names] of [['duration-input.js', 'enhanceDuration,durationSeconds,setDuration'], ['ui-icons.js', 'icon,labelButton'], ['sortable.js', 'sortable']]) {
  w.eval(readFileSync(new URL(file, root), 'utf8').replaceAll('export ', '') + `\nObject.assign(window, {${names}});`);
}
w.eval(readFileSync(new URL('app.js', root), 'utf8').replace(/^import[\s\S]*?from '[^']+';\s*/gm, ''));
const $ = id => w.document.getElementById(id);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const enter = (input, value) => { input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
const duration = id => $(id).closest('.duration-input').querySelectorAll('input');
try {
  await settle();
  const [hours, minutes, seconds] = duration('quickWork');
  enter(hours, '1'); enter(minutes, '2'); enter(seconds, '3');
  assert.equal(w.durationSeconds($('quickWork')), 3723);
  enter(hours, '24'); assert.equal($('quickForm').checkValidity(), false);
  enter(hours, '1'); assert.equal($('quickForm').checkValidity(), true);
  enter($('quickName'), 'A'); $('quickSave').click(); await settle();
  w.document.querySelector('[data-view="quick"]').click();
  enter($('quickName'), 'B'); $('quickSave').click(); await settle();
  assert.equal($('savedMenuPageList').children.length, 2);
  $('savedMenuEditToggle').click();
  $('savedMenuPageList').querySelector('.reorder-handle').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await settle();
  assert.equal($('savedMenuPageList').querySelector('.item-title').textContent, 'B');
  $('savedMenuPageList').querySelector('[aria-label="Bの内容を編集"]').click();
  assert.deepEqual([...duration('menuWork')].map(input => input.value), ['1', '2', '3']);
  $('comboCreateButton').click();
  $('availableList').querySelectorAll('button').forEach(button => button.click());
  enter($('comboName'), 'Course');
  const list = $('builderList'); const first = list.children[0]; const handle = first.querySelector('.reorder-handle');
  // Fixed-height geometry for exercising the long-press/drop lifecycle.
  const geometry = node => ({ top: [...list.children].filter(e => e.style.position !== 'fixed').indexOf(node) * 160 + 100, height: 150, left: 0, width: 300 });
  for (const card of list.children) {
    card.getBoundingClientRect = () => geometry(card);
    Object.defineProperty(card, 'offsetTop', { get: () => geometry(card).top });
    Object.defineProperty(card, 'offsetHeight', { get: () => 150 });
  }
  const pointer = (type, y) => handle.dispatchEvent(new w.MouseEvent(type, { bubbles: true, button: 0, clientX: 100, clientY: y }));
  pointer('pointerdown', 120); await new Promise(resolve => setTimeout(resolve, 270));
  assert.equal(first.classList.contains('is-dragging'), true);
  pointer('pointermove', 440); await settle(); pointer('pointerup', 440); await settle();
  assert.match(list.querySelector('.item-title').textContent, /A$/);
  assert.equal(list.querySelector('.sort-placeholder'), null);
  // Cancellation preserves order and does not leave a floating card.
  const cancelHandle = list.querySelector('.reorder-handle');
  cancelHandle.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 120 }));
  await new Promise(resolve => setTimeout(resolve, 270));
  cancelHandle.dispatchEvent(new w.MouseEvent('pointercancel', { bubbles: true }));
  assert.equal(list.querySelector('.is-dragging'), null);
  $('comboStart').click(); await settle();
  assert.equal($('blockNameTag').textContent, 'A');
  assert.equal($('step').textContent, '1 / 8 セット');
  $('skip').click(); await settle();
  assert.equal($('time').textContent, '1:02:03');
  assert.match($('upcomingMenus').textContent, /B/);
  assert.equal($('runPosition').textContent, 'メニュー 1 / 2');
  console.log('PASS: duration conversion/validation, save/edit, keyboard reorder, long-press drop/cancel, timer labels and upcoming queue');
} finally { w.close(); }
