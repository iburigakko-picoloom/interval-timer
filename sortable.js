export function sortable(root, onCommit) {
  let drag = null;
  let busy = false;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cards = () => [...root.children].filter(node => node.dataset.sortId);
  const positions = () => new Map(cards().map(node => [node, node.getBoundingClientRect()]));
  function animate(before) {
    if (reduced()) return;
    for (const [node, rect] of before) {
      if (node === drag?.item) continue;
      node.getAnimations().forEach(animation => animation.cancel());
      const after = node.getBoundingClientRect();
      const delta = rect.top - after.top;
      if (Math.abs(delta) < 1) continue;
      node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
    }
  }
  async function commit(id) {
    busy = true; root.setAttribute('aria-busy', 'true');
    try { await onCommit(cards().map(node => node.dataset.sortId)); }
    finally {
      busy = false; root.removeAttribute('aria-busy');
      root.querySelector(`[data-sort-id="${CSS.escape(id)}"] .reorder-handle`)?.focus({ preventScroll: true });
    }
  }
  function finish(cancel = false) {
    if (!drag) return;
    const current = drag; drag = null;
    clearTimeout(current.timer); cancelAnimationFrame(current.frame);
    if (current.handle.hasPointerCapture(current.pointer)) current.handle.releasePointerCapture(current.pointer);
    if (!current.placeholder) return;
    current.item.classList.remove('is-dragging'); current.item.removeAttribute('style');
    if (!current.item.isConnected) { current.placeholder.remove(); return; }
    if (cancel) current.order.forEach(node => root.append(node));
    else root.insertBefore(current.item, current.placeholder);
    current.placeholder.remove();
    if (!cancel && cards().some((node, i) => node !== current.order[i])) void commit(current.item.dataset.sortId);
  }
  function frame() {
    if (!drag?.placeholder) return;
    if (!drag.item.isConnected) { finish(true); return; }
    const { item, placeholder, offset, y } = drag;
    const scroll = y < 70 ? -12 : y > innerHeight - 70 ? 12 : 0;
    if (scroll) window.scrollBy(0, scroll);
    item.style.top = `${y - offset}px`;
    const siblings = cards().filter(node => node !== item);
    const target = siblings.find(node => {
      // offsetTop is unaffected by the ongoing FLIP animation.
      let top = -window.scrollY;
      for (let ancestor = node; ancestor; ancestor = ancestor.offsetParent) top += ancestor.offsetTop;
      return y < top + node.offsetHeight / 2;
    });
    const next = placeholder.nextElementSibling === item ? item.nextElementSibling : placeholder.nextElementSibling;
    if ((target || null) !== next) {
      const before = positions(); root.insertBefore(placeholder, target || null); animate(before);
    }
    drag.frame = requestAnimationFrame(frame);
  }
  root.addEventListener('contextmenu', event => { if (event.target.closest('.reorder-handle')) event.preventDefault(); });
  root.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.reorder-handle');
    if (!handle || busy || drag || event.button !== 0) return;
    const item = handle.closest('[data-sort-id]'); if (!item) return;
    drag = { item, handle, pointer: event.pointerId, y: event.clientY, x: event.clientX, order: cards() };
    handle.setPointerCapture(event.pointerId);
    drag.timer = setTimeout(() => {
      if (!drag || !item.isConnected) { finish(true); return; }
      const rect = item.getBoundingClientRect();
      const placeholder = document.createElement('div');
      placeholder.className = 'sort-placeholder'; placeholder.style.height = `${rect.height}px`;
      root.insertBefore(placeholder, item);
      drag.placeholder = placeholder; drag.offset = drag.y - rect.top;
      item.classList.add('is-dragging');
      Object.assign(item.style, { position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, margin: '0', zIndex: '50' });
      drag.frame = requestAnimationFrame(frame);
    }, 240);
  });
  root.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.placeholder && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 10) { finish(true); return; }
    drag.y = event.clientY;
    if (drag.placeholder) event.preventDefault();
  });
  root.addEventListener('pointerup', () => finish());
  root.addEventListener('pointercancel', () => finish(true));
  root.addEventListener('lostpointercapture', () => finish(true));
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { finish(true); return; }
    const handle = event.target.closest('.reorder-handle');
    if (!handle || busy || drag || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const item = handle.closest('[data-sort-id]');
    const order = cards(); const index = order.indexOf(item); const target = order[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!target) return;
    const before = positions(); root.insertBefore(item, event.key === 'ArrowUp' ? target : target.nextSibling); animate(before);
    void commit(item.dataset.sortId);
  });
}
