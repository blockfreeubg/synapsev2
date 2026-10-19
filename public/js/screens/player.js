import { h, svgIcon, glyph } from '../core/dom.js';
import { Dialog, Screen, router } from '../core/router.js';
import { input } from '../core/input.js';
import { store } from '../core/store.js';
import { play } from '../core/sound.js';
import { alert, prompt } from '../core/dialogs.js';
import { cover, spinner, toast, glyphWithKey } from '../core/ui.js';
import { saveShot } from '../core/album.js';
import { app } from '../app.js';
import { StreamClient } from '../stream/client.js';
import { VideoRenderer } from '../stream/video.js';
import { AudioPlayer } from '../stream/audio.js';
import { QUALITY } from '../stream/quality.js';
import { AKEY, PAD_KEYCODES, STICK_KEYCODES, keyboardKeycode, metaState } from '../stream/keymap.js';

const MotionAction = { DOWN: 0, UP: 1, MOVE: 2 };
const MOUSE_POINTER = -2;
let hintShown = false;

export class PlayerScreen extends Screen {
  constructor(game) {
    super('player');
    this.game = game;
    this.state = 'connecting';
    this.pointers = new Map();
    this.heldKeys = new Map();
    this.vw = 0;
    this.vh = 0;
    this.playSeconds = 0;
    this.userId = store.state.currentUser;
  }

  build() {
    this.canvas = h('canvas.stream', { 'aria-label': `${this.game.title} game screen` });
    this.stage = h('div.stage', this.canvas);
    this.overlay = h('div.player-overlay');
    this.stats = h('div.player-stats');
    this.banner = h('div.player-banner');
    this.controls = h(
      'div.player-controls',
      h('button.player-fab', { type: 'button', title: 'HOME menu (Esc)', data: { sound: 'none' }, onclick: () => this.goHome() }, svgIcon('home')),
      h('button.player-fab', { type: 'button', title: 'Quick menu (F2)', onclick: () => this.openQuickMenu() }, svgIcon('more')),
    );
    this.el.append(this.stage, this.overlay, this.stats, this.banner, this.controls);
    this.attachPointer();
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
    this.el.addEventListener('pointermove', () => this.pokeControls());
    this.renderOverlay();
    this.start();
  }

  // --- session ---------------------------------------------------------------

  start() {
    const quality = QUALITY[store.setting('quality')] || QUALITY.balanced;
    const limits = app.info?.limits;
    this.client = new StreamClient({
      pkg: this.game.package,
      maxSize: Math.min(quality.maxSize, limits?.maxSize ?? Infinity),
      bitrate: Math.min(quality.bitrate, limits?.maxBitrate ?? Infinity),
      fps: Math.min(store.setting('fps'), limits?.maxFps ?? 60),
      audio: store.setting('audio') && app.opus ? 1 : 0,
      codecs: app.codecs.join(','),
    });
    this.video = new VideoRenderer(this.canvas, {
      onSize: (w, h) => {
        this.vw = w;
        this.vh = h;
        this.layout();
        if (this.state !== 'playing') this.setState('playing');
      },
    });

    const c = this.client;
    c.on('queue', ({ position, total }) => {
      this.queue = { position, total };
      this.setState('queue');
    });
    c.on('starting', ({ device }) => {
      this.device = device;
      this.setState('starting');
    });
    c.on('video-meta', (m) => {
      this.video.setCodec(m.codec);
      this.vw = m.width;
      this.vh = m.height;
      this.layout();
    });
    c.on('audio-meta', (m) => {
      if (m.codec === 'opus' && app.opus && !this.audio) {
        try {
          this.audio = new AudioPlayer();
          this.audio.setMuted(router.top !== this);
        } catch (err) {
          console.warn('Audio unavailable', err);
        }
      }
    });
    c.on('video', (p) => this.video.push(p));
    c.on('audio', (p) => this.audio?.push(p));
    c.on('idle-warning', ({ seconds }) => this.showBanner(`No input for a while. This session ends in ${seconds} seconds unless you press something.`));
    c.on('end', (m) => this.finish(m.message || 'The session ended.', m.reason));
    c.on('close', () => this.finish('Lost connection to the server.', 'disconnected'));
    c.connect();
    this.statsTimer = setInterval(() => this.updateStats(), 1000);
  }

  setState(state) {
    this.state = state;
    if (state === 'playing') {
      this.startedAt = Date.now();
      if (router.top === this && !router.dialogs.length) this.enterGameMode();
      if (!hintShown) {
        hintShown = true;
        const hint =
          input.source === 'touch'
            ? 'Tap the HOME button in the corner to return to the menu, or ⋯ for the quick menu.'
            : 'Press HOME or Esc to return to the menu. Hold HOME or press F2 for the quick menu.';
        setTimeout(() => toast(hint, { icon: 'home', sound: null, duration: 5000 }), 600);
      }
    }
    this.renderOverlay();
  }

  renderOverlay() {
    const s = this.state;
    this.el.classList.toggle('is-playing', s === 'playing');
    if (s === 'playing') {
      this.overlay.replaceChildren();
      return;
    }
    let body;
    if (s === 'queue') {
      body = h(
        'div.queue-card',
        h('h2', 'All devices are busy'),
        h('p.queue-pos', h('strong', `#${this.queue.position}`), ` in line of ${this.queue.total}`),
        h('p', 'You’ll start automatically when a device frees up.'),
        h('button.pill-btn', { type: 'button', data: { nav: '', navDefault: '' }, onclick: () => this.cancel() }, glyph('B'), ' Leave queue'),
      );
    } else {
      const text = s === 'starting' ? `Starting on ${this.device?.model || 'device'}…` : 'Connecting…';
      body = h('div.loading-row', spinner(), h('span', text));
    }
    this.overlay.replaceChildren(h('div.loading-cover', cover(this.game)), h('div.loading-title', this.game.title), body);
    if (router.top === this) requestAnimationFrame(() => this.scope.focusInitial());
  }

  layout() {
    if (!this.vw || !this.vh) return;
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const scale = Math.min(W / this.vw, H / this.vh);
    this.canvas.style.width = `${Math.floor(this.vw * scale)}px`;
    this.canvas.style.height = `${Math.floor(this.vh * scale)}px`;
  }

  updateStats() {
    if (this.state === 'playing' && router.top === this) this.playSeconds++;
    const show = store.setting('stats') && this.state === 'playing';
    this.stats.hidden = !show;
    const v = this.video.stats;
    const fps = v.frames - (this.lastFrames || 0);
    const bytes = this.client.bytes - (this.lastBytes || 0);
    this.lastFrames = v.frames;
    this.lastBytes = this.client.bytes;
    if (!show) return;
    const parts = [
      `${this.vw}×${this.vh}`,
      `${fps} fps`,
      `${((bytes * 8) / 1e6).toFixed(1)} Mbps`,
      this.client.latency != null ? `${Math.round(this.client.latency)} ms` : null,
      this.video.codecName?.toUpperCase(),
      v.dropped ? `${v.dropped} dropped` : null,
    ];
    this.stats.textContent = parts.filter(Boolean).join(' · ');
  }

  showBanner(text) {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    play('notify');
  }

  hideBanner() {
    if (this.banner.classList.contains('show')) this.banner.classList.remove('show');
  }

  // --- lifecycle ---------------------------------------------------------------

  enterGameMode() {
    input.setMode('game');
    input.gameSink = this;
  }

  leaveGameMode() {
    this.releaseHeld();
    if (input.gameSink === this) input.gameSink = null;
    input.setMode('ui');
  }

  onShow() {
    this.video && (this.video.paused = false);
    this.audio?.setMuted(false);
    if (this.state === 'playing') this.enterGameMode();
    this.layout();
    this.pokeControls();
  }

  onHide() {
    this.leaveGameMode();
    if (this.video) this.video.paused = true;
    this.audio?.setMuted(true);
  }

  goHome() {
    play('home');
    if (router.top === this) router.back({ transition: 'fade' });
  }

  cancel() {
    this.terminate();
  }

  /** Close the software: end the session and drop this screen. */
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    if (this.playSeconds > 0) store.recordPlay(this.game.package, this.playSeconds, this.userId);
    clearInterval(this.statsTimer);
    window.removeEventListener('resize', this.onResize);
    this.leaveGameMode();
    this.client?.close();
    this.video?.close();
    this.audio?.close();
    if (app.running === this) {
      app.running = null;
      app.changed();
    }
    if (router.stack.includes(this)) {
      if (router.top === this) router.back({ transition: 'fade' });
      else router.stack.splice(router.stack.indexOf(this), 1);
    }
  }

  async finish(message, reason) {
    if (this.terminated) return;
    const visible = router.top === this;
    this.terminate();
    if (reason === 'client-closed') return;
    if (visible) await alert({ title: `${this.game.title} closed`, message });
    else toast(`${this.game.title} closed: ${message}`, { icon: 'info', sound: 'error', duration: 5000 });
  }

  onAction(action) {
    if (this.state !== 'playing') {
      if (action === 'b' || action === 'home') {
        if (this.state === 'queue') this.cancel();
        else this.goHome();
        return true;
      }
      return false;
    }
    if (action === 'home') this.goHome();
    else if (action === 'quick') this.openQuickMenu();
    else if (action === 'capture') this.capture();
    return true;
  }

  back() {
    this.goHome();
  }

  // --- input to the device ----------------------------------------------------------

  sendKey(keycode, down, extra = {}) {
    this.client.send({ t: 'key', a: down ? 0 : 1, k: keycode, ...extra });
    this.hideBanner();
  }

  tapKey(keycode) {
    this.sendKey(keycode, true);
    this.sendKey(keycode, false);
  }

  /** Game sink: keyboard. */
  key(e, down) {
    if (!store.setting('keyboardPassthrough')) return false;
    const keycode = keyboardKeycode(e.code);
    if (keycode === undefined) return false;
    if (down) {
      const repeat = this.heldKeys.has(`k${keycode}`) ? (this.heldKeys.get(`k${keycode}`) || 0) + 1 : 0;
      this.heldKeys.set(`k${keycode}`, repeat);
      this.sendKey(keycode, true, { r: repeat, m: metaState(e) });
    } else {
      this.heldKeys.delete(`k${keycode}`);
      this.sendKey(keycode, false, { m: metaState(e) });
    }
    return true;
  }

  /** Game sink: gamepad button by standard index. */
  pad(index, pressed) {
    const keycode = PAD_KEYCODES[index];
    if (keycode === undefined) return;
    if (pressed) this.heldKeys.set(`p${index}`, keycode);
    else this.heldKeys.delete(`p${index}`);
    this.sendKey(keycode, pressed);
  }

  /** Game sink: left stick acting as a d-pad. */
  stick(dir, pressed) {
    const keycode = STICK_KEYCODES[dir];
    if (pressed) this.heldKeys.set(`s${dir}`, keycode);
    else this.heldKeys.delete(`s${dir}`);
    this.sendKey(keycode, pressed);
  }

  releaseHeld() {
    for (const [id, value] of this.heldKeys) {
      const keycode = id.startsWith('k') ? Number(id.slice(1)) : value;
      this.sendKey(keycode, false);
    }
    this.heldKeys.clear();
    for (const [pointerId, slot] of this.pointers) {
      this.client?.send({ t: 'touch', a: MotionAction.UP, id: slot, x: 0, y: 0, w: this.vw || 1, h: this.vh || 1, p: 0 });
      this.pointers.delete(pointerId);
    }
  }

  attachPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.state !== 'playing') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      const slot = this.allocPointer(e);
      if (slot === null) return;
      c.setPointerCapture(e.pointerId);
      this.sendTouch(MotionAction.DOWN, slot, e);
    });
    c.addEventListener('pointermove', (e) => {
      const slot = this.pointers.get(e.pointerId);
      if (slot === undefined) return;
      for (const ev of e.getCoalescedEvents?.() || [e]) this.sendTouch(MotionAction.MOVE, slot, ev);
    });
    const up = (e) => {
      const slot = this.pointers.get(e.pointerId);
      if (slot === undefined) return;
      this.pointers.delete(e.pointerId);
      this.sendTouch(MotionAction.UP, slot, e);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Right click acts as Android BACK.
      if (this.state === 'playing') this.tapKey(AKEY.BACK);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.state !== 'playing' || !this.vw) return;
        const scale = e.deltaMode === 1 ? 1 : 1 / 100;
        const clamp = (v) => Math.max(-16, Math.min(16, v));
        const { x, y } = this.toVideo(e);
        this.client.send({ t: 'scroll', x, y, w: this.vw, h: this.vh, hs: clamp(-e.deltaX * scale), vs: clamp(-e.deltaY * scale) });
      },
      { passive: false },
    );
  }

  allocPointer(e) {
    if (e.pointerType === 'mouse') {
      this.pointers.set(e.pointerId, MOUSE_POINTER);
      return MOUSE_POINTER;
    }
    const used = new Set(this.pointers.values());
    for (let slot = 0; slot < 10; slot++) {
      if (!used.has(slot)) {
        this.pointers.set(e.pointerId, slot);
        return slot;
      }
    }
    return null;
  }

  toVideo(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.vw;
    const y = ((e.clientY - r.top) / r.height) * this.vh;
    return { x: Math.max(0, Math.min(this.vw, x)), y: Math.max(0, Math.min(this.vh, y)) };
  }

  sendTouch(action, slot, e) {
    if (!this.vw) return;
    const { x, y } = this.toVideo(e);
    const p = action === MotionAction.UP ? 0 : e.pointerType === 'pen' ? e.pressure : 1;
    this.client.send({ t: 'touch', a: action, id: slot, x, y, w: this.vw, h: this.vh, p });
    this.hideBanner();
  }

  pokeControls() {
    this.controls.classList.add('awake');
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => this.controls.classList.remove('awake'), 2500);
  }

  // --- quick menu actions ------------------------------------------------------------

  async capture() {
    if (this.state !== 'playing') return;
    const blob = await this.video.snapshot();
    if (!blob) return;
    this.el.classList.remove('flash');
    void this.el.offsetWidth;
    this.el.classList.add('flash');
    await saveShot({ blob, title: this.game.title, pkg: this.game.package });
    toast('Screenshot saved to Album', { icon: 'camera', sound: 'capture' });
  }

  async typeText() {
    const text = await prompt({ title: 'Type text', message: 'Sent to the focused text field in the game.', maxLength: 300, okLabel: 'Send' });
    if (text) this.client.send({ t: 'text', s: text });
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else
      document.documentElement
        .requestFullscreen?.()
        .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
        .catch(() => {});
  }

  openQuickMenu() {
    if (router.dialogs.length) return;
    play('select');
    this.leaveGameMode();
    const menu = new QuickMenu(this);
    menu.open().then(() => {
      if (router.top === this && this.state === 'playing' && !router.dialogs.length) this.enterGameMode();
    });
  }
}

class QuickMenu extends Dialog {
  constructor(player) {
    super('quick-menu');
    this.player = player;
    const item = (iconName, label, fn, extra = {}) =>
      h('button.quick-item', { type: 'button', data: { nav: '', ...extra }, onclick: () => this.run(fn) }, svgIcon(iconName), h('span', label));
    this.el.append(
      h(
        'aside.quick-panel',
        h('div.quick-head', cover(player.game), h('div', h('strong', player.game.title), h('small', player.device?.model || ''))),
        item('play', 'Resume', null, { navDefault: '' }),
        item('back', 'Android Back', () => player.tapKey(AKEY.BACK)),
        item('keyboard', 'Type Text', () => player.typeText()),
        item('rotate', 'Rotate Screen', () => player.client.send({ t: 'rotate' })),
        item('camera', 'Capture Screenshot', () => player.capture()),
        item('fullscreen', 'Toggle Fullscreen', () => player.toggleFullscreen()),
        item('stats', 'Toggle Stream Stats', () => store.setSetting('stats', !store.setting('stats'))),
        item('home', 'HOME Menu', () => player.goHome()),
        item('close', 'Close Software', () => player.terminate(), { sound: 'back' }),
        h('div.quick-foot', glyphWithKey('b'), 'Back'),
      ),
    );
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close(null);
    });
  }

  run(fn) {
    this.close(null);
    if (fn) setTimeout(fn, 60);
  }
}
