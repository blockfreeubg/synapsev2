import { h, wait } from './dom.js';
import { FocusScope } from './nav.js';
import { input } from './input.js';
import { play } from './sound.js';

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

export class Screen {
  constructor(className = '') {
    this.el = h(`section.screen${className ? `.${className}` : ''}`);
    this.scope = new FocusScope(this.el);
    this.built = false;
  }

  /** Build the DOM once, before the screen is first shown. */
  build() {}
  onShow() {}
  onHide() {}

  /** Return true when the action was handled. */
  onAction() {
    return false;
  }

  back() {
    play('back');
    router.back();
  }

  /** Register cleanup to run when the screen leaves the stack for good. */
  cleanup(fn) {
    (this.cleanups ||= []).push(fn);
  }

  onPop() {
    this.cleanups?.forEach((fn) => fn());
    this.cleanups = [];
  }
}

class Router {
  constructor() {
    this.stack = [];
    this.dialogs = [];
    this.root = null;
    this.dialogLayer = null;
  }

  mount(root, dialogLayer) {
    this.root = root;
    this.dialogLayer = dialogLayer;
    input.onAction((action, info) => this.dispatch(action, info));
    // One place for activation sounds, whether by click, tap or controller.
    root.parentElement.addEventListener('click', (e) => {
      const el = e.target.closest('[data-nav]');
      if (!el || el.disabled) return;
      const sound = el.dataset.sound ?? 'select';
      if (sound !== 'none') play(sound);
    });
  }

  get top() {
    return this.stack[this.stack.length - 1] || null;
  }

  get target() {
    return this.dialogs[this.dialogs.length - 1] || this.top;
  }

  show(screen, transition) {
    if (!screen.built) {
      screen.build();
      screen.built = true;
    }
    if (!screen.el.isConnected) this.root.append(screen.el);
    screen.el.hidden = false;
    screen.el.inert = false;
    screen.el.classList.remove('leave', 'enter-back', 'enter-forward', 'enter-fade', 'enter-zoom');
    if (transition) {
      void screen.el.offsetWidth;
      screen.el.classList.add(`enter-${transition}`);
    }
    screen.onShow();
    requestAnimationFrame(() => screen.scope.focusInitial({ smooth: false }));
  }

  hide(screen, remove) {
    screen.onHide();
    screen.el.inert = true;
    screen.el.classList.add('leave');
    setTimeout(() => {
      if (this.stack.includes(screen) && this.top !== screen) screen.el.hidden = true;
      else if (!this.stack.includes(screen) && remove) screen.el.remove();
      screen.el.classList.remove('leave');
    }, 220);
  }

  push(screen, { transition = 'forward' } = {}) {
    const prev = this.top;
    this.stack.push(screen);
    if (prev) this.hide(prev, false);
    this.show(screen, transition);
  }

  back({ transition = 'back' } = {}) {
    if (this.stack.length <= 1) return;
    const leaving = this.stack.pop();
    this.hide(leaving, true);
    leaving.onPop?.();
    this.show(this.top, transition);
  }

  /** Pop back to the first screen matching predicate. */
  backTo(predicate, opts) {
    while (this.stack.length > 1 && !predicate(this.top)) this.back(opts);
  }

  replaceAll(screen, { transition = 'fade' } = {}) {
    const old = [...this.stack];
    this.stack = [screen];
    for (const s of old) {
      if (s === screen) continue;
      this.hide(s, true);
    }
    this.show(screen, transition);
  }

  dispatch(action, info) {
    const target = this.target;
    if (!target) return;
    if (target.onAction?.(action, info)) return;
    if (DIRECTIONS.has(action)) target.scope.move(action);
    else if (action === 'a') target.scope.activate();
    else if (action === 'b') target.back?.();
  }

  // --- dialogs ---------------------------------------------------------------

  openDialog(dialog) {
    this.dialogs.push(dialog);
    this.dialogLayer.append(dialog.el);
    this.dialogLayer.classList.add('active');
    for (const s of this.stack) s.el.inert = true;
    requestAnimationFrame(() => dialog.scope.focusInitial({ smooth: false }));
  }

  async closeDialog(dialog) {
    const i = this.dialogs.indexOf(dialog);
    if (i < 0) return;
    this.dialogs.splice(i, 1);
    dialog.el.classList.add('closing');
    if (!this.dialogs.length) {
      this.dialogLayer.classList.remove('active');
      if (this.top) this.top.el.inert = false;
    }
    await wait(160);
    dialog.el.remove();
    const next = this.target;
    if (next?.scope.current) next.scope.current.focus({ preventScroll: true });
  }
}

export const router = new Router();

/** Base class for modal layers routed like screens. */
export class Dialog {
  constructor(className = '') {
    this.el = h(`div.dialog-backdrop${className ? `.${className}` : ''}`);
    this.scope = new FocusScope(this.el);
    this.result = new Promise((resolve) => (this.resolve = resolve));
  }

  onAction() {
    return false;
  }

  open() {
    router.openDialog(this);
    return this.result;
  }

  close(value) {
    this.resolve(value);
    router.closeDialog(this);
  }

  back() {
    play('back');
    this.close(null);
  }
}
