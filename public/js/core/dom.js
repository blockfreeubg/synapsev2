import { icon } from './icons.js';

/**
 * Tiny element builder: h('button.tile', { onclick, data: { nav: '' } }, 'Label')
 * Tag may carry classes after dots. Props starting with "on" become listeners.
 */
export function h(tag, props, ...children) {
  if (props instanceof Node || typeof props !== 'object' || props === null || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'style' && typeof value === 'object') {
      // Custom properties (--foo) only work through setProperty.
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === 'data') for (const [k, v] of Object.entries(value)) el.dataset[k] = v;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function svgIcon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.innerHTML = icon(name);
  return span;
}

/** Circular controller button glyph, e.g. glyph('A'). */
export function glyph(button) {
  const labels = { home: '⌂', plus: '+', minus: '−' };
  return h(`span.glyph.glyph-${button.toLowerCase()}`, { 'aria-hidden': 'true' }, labels[button] || button);
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return `${hrs} hr ${m % 60} min`;
}

export function timeAgo(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  const days = Math.floor(diff / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function hashHue(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
