// Shared building blocks: header, footer hints, status cluster, avatars,
// game covers, toasts and spinner.

import { h, svgIcon, glyph, hashHue } from './dom.js';
import { KEY_LABELS, input } from './input.js';
import { router } from './router.js';
import { play } from './sound.js';

/** Footer with clickable button hints, e.g. [['b', 'Back'], ['a', 'OK']]. */
export function footer(hints = [], { left = null } = {}) {
  const hintsEl = h('div.hints');
  const el = h('footer.footer', h('div.footer-left', left || controllerIndicator()), hintsEl);
  el.setHints = (list) => {
    hintsEl.replaceChildren(
      ...list.map(([button, label]) =>
        h(
          'button.hint',
          { type: 'button', onclick: () => router.dispatch(button, { source: 'pointer' }) },
          glyphWithKey(button),
          h('span', label),
        ),
      ),
    );
  };
  el.setHints(hints);
  return el;
}

export function glyphWithKey(button) {
  return h('span.glyph-wrap', glyph(button === 'home' ? 'home' : button.toUpperCase()), h('kbd.key-label', KEY_LABELS[button] || button));
}

function updateIndicator(el) {
  const pads = input.snapshot().length;
  el.replaceChildren(svgIcon('controller'), ...(pads ? [h('span.count', String(pads))] : []));
  el.classList.toggle('none', !pads);
}

input.onPadChange(() => setTimeout(() => document.querySelectorAll('.controller-indicator').forEach(updateIndicator)));

function controllerIndicator() {
  const el = h('div.controller-indicator', { title: 'Controllers' });
  updateIndicator(el);
  return el;
}

/** Title bar for sub pages (Settings, Album, ...). */
export function header(title, iconName, { accent } = {}) {
  return h('header.page-header', { style: accent ? { '--page-accent': accent } : undefined }, h('div.page-title', svgIcon(iconName, 'page-icon'), h('h1', title)), statusCluster());
}

// --- clock / wifi / battery -------------------------------------------------

let battery = null;
navigator.getBattery?.().then((b) => {
  battery = b;
  const refresh = () => document.querySelectorAll('.status-cluster').forEach((el) => el.refresh());
  b.addEventListener('levelchange', refresh);
  b.addEventListener('chargingchange', refresh);
  refresh();
}).catch(() => {});

let serverOnline = true;
export function setServerOnline(value) {
  serverOnline = value;
  document.querySelectorAll('.status-cluster').forEach((el) => el.refresh());
}

function batteryIcon(level, charging) {
  const w = Math.max(1, Math.round(15 * level));
  const fill = level <= 0.15 && !charging ? 'var(--danger)' : 'currentColor';
  return h('span.icon.battery', {
    html: `<svg viewBox="0 0 28 14" aria-hidden="true"><rect x="1" y="1" width="23" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="25.2" y="4.5" width="2" height="5" rx="1" fill="currentColor"/><rect x="3.5" y="3.5" width="${w * 1.2}" height="7" rx="1.2" fill="${fill}"/>${charging ? '<path d="M13.5 2.5 10 7.6h3.2l-1 3.9 3.8-5.3h-3.2z" fill="var(--bg)" stroke="var(--bg)" stroke-width=".6"/>' : ''}</svg>`,
  });
}

export function statusCluster() {
  const time = h('span.clock');
  const wifi = svgIcon('wifi', 'wifi');
  const batt = h('span.battery-wrap');
  const el = h('div.status-cluster', time, wifi, batt);
  el.refresh = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const online = navigator.onLine && serverOnline;
    wifi.classList.toggle('offline', !online);
    wifi.title = online ? 'Connected' : 'Server unreachable';
    if (battery) {
      batt.replaceChildren(h('span.battery-pct', `${Math.round(battery.level * 100)}%`), batteryIcon(battery.level, battery.charging));
    }
  };
  el.refresh();
  return el;
}

setInterval(() => document.querySelectorAll('.status-cluster').forEach((el) => el.refresh()), 10_000);
window.addEventListener('online', () => setServerOnline(serverOnline));
window.addEventListener('offline', () => setServerOnline(serverOnline));

// --- avatars and covers ---------------------------------------------------------

export function avatar(user, size = '') {
  const initial = (user?.name || '?').trim().charAt(0).toUpperCase() || '?';
  return h(`span.avatar${size ? `.${size}` : ''}`, { style: { '--avatar': user?.color || '#999' } }, h('span.avatar-face', initial));
}

/** Cover art: the configured image, or a generated tile from the title. */
export function cover(game) {
  if (game.cover) {
    return h('span.cover', h('img', { src: game.cover, alt: '', loading: 'lazy', draggable: false }));
  }
  const base = game.color || `hsl(${hashHue(game.package || game.title)} 65% 48%)`;
  // Short titles are shown whole, longer ones as initials.
  const words = game.title.split(/[\s:'’-]+/).filter(Boolean);
  const mark = game.title.length <= 5 ? game.title : words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return h(
    'span.cover.generated',
    { style: { '--c1': base } },
    h('span.cover-pattern'),
    h('span.cover-mark', { class: mark.length > 2 ? 'long' : '' }, mark),
    h('span.cover-title', game.title),
  );
}

// --- toasts ------------------------------------------------------------------------

let toastLayer = null;
export function mountToasts(el) {
  toastLayer = el;
}

export function toast(text, { icon = 'info', sound = 'notify', duration = 3200 } = {}) {
  if (!toastLayer) return;
  if (sound) play(sound);
  const el = h('div.toast', svgIcon(icon), h('span', text));
  toastLayer.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

export function spinner(cls = '') {
  return h(`span.spinner${cls ? `.${cls}` : ''}`, { 'aria-label': 'Loading' }, ...Array.from({ length: 8 }, (_, i) => h('i', { style: { '--i': i } })));
}
