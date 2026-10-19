// Spatial (directional) focus navigation for controller/keyboard input.
//
// Any element with [data-nav] inside a scope's root is focusable. Moving picks
// the nearest element in that direction. Elements sharing [data-nav-group]
// remember the last focused member, so leaving a row and coming back returns
// to where you were. [data-nav-left|right|up|down="none"] blocks a direction.

import { play } from './sound.js';

const DIRS = {
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
  up: { axis: 'y', sign: -1 },
  down: { axis: 'y', sign: 1 },
};

function visible(el) {
  if (el.disabled || el.closest('[inert]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function center(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function scrollParent(el, axis) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    if (/(auto|scroll)/.test(overflow)) return p;
  }
  return null;
}

/** Scroll the nearest scrollable ancestors so el is fully visible with a margin. */
export function revealElement(el, smooth = true) {
  for (const axis of ['x', 'y']) {
    const parent = scrollParent(el, axis);
    if (!parent) continue;
    const pr = parent.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const margin = Number(parent.dataset.revealMargin ?? 24);
    let delta = 0;
    if (axis === 'x') {
      if (er.left < pr.left + margin) delta = er.left - pr.left - margin;
      else if (er.right > pr.right - margin) delta = er.right - pr.right + margin;
      if (delta) parent.scrollBy({ left: delta, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      if (er.top < pr.top + margin) delta = er.top - pr.top - margin;
      else if (er.bottom > pr.bottom - margin) delta = er.bottom - pr.bottom + margin;
      if (delta) parent.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
    }
  }
}

export class FocusScope {
  constructor(root) {
    this.root = root;
    this.current = null;
    this.memory = new Map();
    // Mouse hover moves focus, but only after real pointer movement.
    root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target.closest?.('[data-nav]');
      if (el && el !== this.current && root.contains(el) && !el.hasAttribute('data-nav-nohover')) {
        this.focus(el, { scroll: false });
      }
    });
  }

  items() {
    return [...this.root.querySelectorAll('[data-nav]')].filter(visible);
  }

  focus(el, { sound = true, scroll = true, smooth = true } = {}) {
    if (!el) return;
    const prev = this.current;
    if (prev && prev !== el) {
      prev.classList.remove('focused');
      prev.dispatchEvent(new CustomEvent('nav:blur'));
    }
    this.current = el;
    el.classList.add('focused');
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    const group = el.dataset.navGroup;
    if (group) this.memory.set(group, el);
    if (scroll) revealElement(el, smooth);
    if (prev !== el) {
      if (sound && prev) play('move');
      el.dispatchEvent(new CustomEvent('nav:focus', { bubbles: true }));
    }
  }

  /** Focus the remembered, default or first item. */
  focusInitial(opts = {}) {
    if (this.current && this.root.contains(this.current) && visible(this.current)) {
      return this.focus(this.current, { sound: false, ...opts });
    }
    const target = this.root.querySelector('[data-nav-default]') || this.items()[0];
    this.focus(target, { sound: false, ...opts });
  }

  move(dir) {
    const from = this.current && this.root.contains(this.current) ? this.current : null;
    if (!from) {
      this.focusInitial();
      return true;
    }
    const block = from.dataset[`nav${dir[0].toUpperCase()}${dir.slice(1)}`];
    if (block === 'none') return this.bump(dir);
    if (block) {
      const target = this.root.querySelector(block);
      if (target && visible(target)) {
        this.focus(target);
        return true;
      }
    }

    const { axis, sign } = DIRS[dir];
    const fr = from.getBoundingClientRect();
    const fc = center(fr);
    let best = null;
    let bestScore = Infinity;
    for (const el of this.items()) {
      if (el === from) continue;
      const r = el.getBoundingClientRect();
      const c = center(r);
      const primary = (axis === 'x' ? c.x - fc.x : c.y - fc.y) * sign;
      if (primary <= 1) continue;
      // Edge-to-edge distance along the movement axis.
      const gap = axis === 'x' ? (sign > 0 ? r.left - fr.right : fr.left - r.right) : sign > 0 ? r.top - fr.bottom : fr.top - r.bottom;
      const overlap =
        axis === 'x' ? Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top) : Math.min(r.right, fr.right) - Math.max(r.left, fr.left);
      // Left/right stays within the current row, like a console menu.
      if (axis === 'x' && overlap <= 0) continue;
      // Prefer aligned items; among overlapping ones, the most centred wins.
      const ortho = Math.abs(axis === 'x' ? c.y - fc.y : c.x - fc.x) * (overlap > 0 ? 0.25 : 2);
      const score = Math.max(gap, 0) + primary * 0.1 + ortho;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (!best) return this.bump(dir);

    const group = best.dataset.navGroup;
    if (group && group !== from.dataset.navGroup) {
      const remembered = this.memory.get(group);
      if (remembered && remembered !== best && this.root.contains(remembered) && visible(remembered)) {
        const rc = center(remembered.getBoundingClientRect());
        if (((axis === 'x' ? rc.x - fc.x : rc.y - fc.y) * sign) > 1) best = remembered;
      }
    }
    this.focus(best);
    return true;
  }

  bump(dir) {
    play('bump');
    const el = this.current;
    if (el) {
      el.classList.remove('bump-left', 'bump-right', 'bump-up', 'bump-down');
      void el.offsetWidth;
      el.classList.add(`bump-${dir}`);
      setTimeout(() => el.classList.remove(`bump-${dir}`), 220);
    }
    return false;
  }

  activate() {
    const el = this.current;
    if (!el || !this.root.contains(el)) return false;
    if (el.matches('input[type="text"], input[type="password"], input:not([type])')) {
      el.focus();
      return true;
    }
    el.click();
    return true;
  }
}
