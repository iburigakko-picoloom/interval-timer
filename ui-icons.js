// Shared 24px grid, rounded 1.8px strokes; no font-dependent symbols.
const paths = {
  play: 'M8 5 19 12 8 19Z',
  plus: 'M12 5v14M5 12h14',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  chevron: 'm9 5 7 7-7 7',
  grip: 'M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01',
  home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  pause: 'M8 5v14M16 5v14',
  skip: 'm5 5 10 7-10 7ZM19 5v14',
  stop: 'M6 6h12v12H6Z',
  save: 'M5 3h12l4 4v14H3V3ZM7 3v6h10V3M7 21v-8h10v8',
  edit: 'm14 5 5 5M4 20l5-1L21 7l-4-4L5 15Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  copy: 'M8 8h13v13H8ZM16 5V3H3v13h2',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm4 12 5 5L20 6',
  sound: 'M3 9h4l5-4v14l-5-4H3ZM16 8c3 2 3 6 0 8M19 5c5 4 5 10 0 14'
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'grip' ? '3.5' : '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] || paths.list); svg.append(path); return svg;
}
export function labelButton(button, text, name) {
  button.replaceChildren(icon(name), document.createTextNode(text));
}
