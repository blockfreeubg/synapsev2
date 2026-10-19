// Unifies keyboard, gamepad and pointer input.
//
// In "ui" mode everything becomes abstract actions (up/down/left/right/a/b/x/y/
// l/r/zl/zr/plus/minus/home) delivered to the action handler. In "game" mode
// raw keys and buttons go to the game sink, except the HOME shortcuts.

import { store } from './store.js';

const KEY_ACTIONS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'a',
  NumpadEnter: 'a',
  Space: 'a',
  Escape: 'b',
  Backspace: 'b',
  KeyX: 'x',
  KeyY: 'y',
  KeyQ: 'l',
  KeyE: 'r',
  Equal: 'plus',
  NumpadAdd: 'plus',
  Minus: 'minus',
  NumpadSubtract: 'minus',
  KeyH: 'home',
  Home: 'home',
};

// Keyboard labels shown in on-screen hints when the keyboard was used last.
export const KEY_LABELS = { a: 'Enter', b: 'Esc', x: 'X', y: 'Y', l: 'Q', r: 'E', plus: '+', minus: '−', home: 'H' };

const DIR_BUTTONS = { up: 12, down: 13, left: 14, right: 15 };
const REPEAT_DELAY = 380;
const REPEAT_RATE = 110;
const STICK_ON = 0.5;
const STICK_OFF = 0.35;
const HOLD_MS = 500;

function isTextField(el) {
  return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'file'].includes(el.type)));
}

function faceMap() {
  return store.setting('layout') === 'nintendo' ? { a: 1, b: 0, x: 3, y: 2 } : { a: 0, b: 1, x: 2, y: 3 };
}

class InputManager {
  constructor() {
    this.mode = 'ui';
    this.handler = null;
    this.gameSink = null;
    this.pads = new Map();
    this.padListeners = new Set();
    this.lastKeyRepeat = 0;
    this.source = 'mouse';

    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('pointerdown', (e) => this.setSource(e.pointerType === 'touch' ? 'touch' : 'mouse'), true);
    window.addEventListener('gamepadconnected', (e) => this.padListeners.forEach((fn) => fn('connected', e.gamepad)));
    window.addEventListener('gamepaddisconnected', (e) => {
      this.pads.delete(e.gamepad.index);
      this.padListeners.forEach((fn) => fn('disconnected', e.gamepad));
    });
    const loop = () => {
      this.poll();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setSource(source) {
    if (this.source === source) return;
    this.source = source;
    document.documentElement.dataset.input = source;
  }

  setMode(mode) {
    this.mode = mode;
    // Release anything held so nothing stays stuck across the switch.
    for (const st of this.pads.values()) st.held = {};
  }

  onAction(fn) {
    this.handler = fn;
  }

  onPadChange(fn) {
    this.padListeners.add(fn);
    return () => this.padListeners.delete(fn);
  }

  emit(action, info = {}) {
    this.handler?.(action, info);
  }

  onKey(e, down) {
    this.setSource('keyboard');
    if (this.mode === 'game') return this.onGameKey(e, down);
    if (!down) return;
    const target = e.target;
    if (isTextField(target)) {
      if (e.code === 'Escape') {
        e.preventDefault();
        this.emit('b', { source: 'keyboard', raw: e.code });
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        this.emit('a', { source: 'keyboard', raw: e.code });
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        this.emit(KEY_ACTIONS[e.code], { source: 'keyboard', raw: e.code });
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = KEY_ACTIONS[e.code];
    if (!action) {
      this.emit('any', { source: 'keyboard', raw: e.code });
      return;
    }
    e.preventDefault();
    if (e.repeat) {
      const now = performance.now();
      if (now - this.lastKeyRepeat < 80) return;
      this.lastKeyRepeat = now;
    }
    this.emit(action, { source: 'keyboard', raw: e.code, repeat: e.repeat });
  }

  onGameKey(e, down) {
    if (isTextField(e.target)) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (down && !e.repeat) this.emit('home', { source: 'keyboard' });
      return;
    }
    if (e.code === 'F2' || e.code === 'F8') {
      e.preventDefault();
      if (down && !e.repeat) this.emit(e.code === 'F2' ? 'quick' : 'capture', { source: 'keyboard' });
      return;
    }
    if (this.gameSink?.key?.(e, down)) e.preventDefault();
  }

  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) if (gp && gp.connected) this.pollPad(gp);
  }

  pollPad(gp) {
    let st = this.pads.get(gp.index);
    if (!st) {
      st = { buttons: [], held: {}, stick: {}, homeAt: 0, homeFired: false };
      this.pads.set(gp.index, st);
    }
    const now = performance.now();
    const pressed = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    const was = st.buttons;
    const edge = (i) => pressed[i] && !was[i];
    const anyEdge = pressed.some((p, i) => p && !was[i]);
    if (anyEdge) this.setSource('gamepad');

    // Left stick as a direction pad, with hysteresis.
    const [ax = 0, ay = 0] = gp.axes;
    const stickDir = {
      left: ax < -(st.stick.left ? STICK_OFF : STICK_ON),
      right: ax > (st.stick.right ? STICK_OFF : STICK_ON),
      up: ay < -(st.stick.up ? STICK_OFF : STICK_ON),
      down: ay > (st.stick.down ? STICK_OFF : STICK_ON),
    };
    if (Object.entries(stickDir).some(([d, v]) => v && !st.stick[d])) this.setSource('gamepad');

    if (this.mode === 'ui') this.pollUi(gp, st, pressed, edge, stickDir, now);
    else this.pollGame(gp, st, pressed, was, stickDir, now);

    st.stick = stickDir;
    st.buttons = pressed;
  }

  pollUi(gp, st, pressed, edge, stickDir, now) {
    const info = { source: 'gamepad' };
    for (const [dir, btn] of Object.entries(DIR_BUTTONS)) {
      const down = pressed[btn] || stickDir[dir];
      const h = st.held[dir];
      if (down && !h) {
        st.held[dir] = { next: now + REPEAT_DELAY };
        this.emit(dir, { ...info, raw: `pad${btn}` });
      } else if (down && h && now >= h.next) {
        h.next = now + REPEAT_RATE;
        this.emit(dir, { ...info, raw: `pad${btn}`, repeat: true });
      } else if (!down && h) {
        delete st.held[dir];
      }
    }
    const face = faceMap();
    for (const [action, btn] of Object.entries(face)) if (edge(btn)) this.emit(action, { ...info, raw: `pad${btn}` });
    const extra = { l: 4, r: 5, zl: 6, zr: 7, minus: 8, plus: 9, home: 16 };
    for (const [action, btn] of Object.entries(extra)) if (edge(btn)) this.emit(action, { ...info, raw: `pad${btn}` });
    for (const i of [10, 11]) if (edge(i)) this.emit('any', { ...info, raw: `pad${i}` });
  }

  pollGame(gp, st, pressed, was, stickDir, now) {
    const sink = this.gameSink;
    // HOME: tap returns to the menu, hold opens the quick menu.
    // Select+Start together works as HOME for pads without a guide button.
    const homeDown = pressed[16] || (pressed[8] && pressed[9]);
    if (homeDown && !st.homeAt) {
      st.homeAt = now;
      st.homeFired = false;
      if (pressed[8] && pressed[9]) {
        sink?.pad?.(8, false);
        sink?.pad?.(9, false);
      }
    } else if (homeDown && !st.homeFired && now - st.homeAt >= HOLD_MS) {
      st.homeFired = true;
      this.emit('quick', { source: 'gamepad' });
    } else if (!homeDown && st.homeAt) {
      if (!st.homeFired) this.emit('home', { source: 'gamepad' });
      st.homeAt = 0;
    }
    if (st.homeAt) return;

    for (let i = 0; i < Math.min(pressed.length, 16); i++) {
      if (pressed[i] !== Boolean(was[i])) sink?.pad?.(i, pressed[i]);
    }
    if (store.setting('stickAsDpad')) {
      for (const dir of Object.keys(DIR_BUTTONS)) {
        if (stickDir[dir] !== Boolean(st.stick[dir])) sink?.stick?.(dir, stickDir[dir]);
      }
    }
  }

  /** Raw state of every connected pad, for the controller test screen. */
  snapshot() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return [...pads].filter((p) => p && p.connected).map((p) => ({
      index: p.index,
      id: p.id,
      mapping: p.mapping,
      buttons: p.buttons.map((b) => b.value || (b.pressed ? 1 : 0)),
      axes: [...p.axes],
    }));
  }
}

export const input = new InputManager();
