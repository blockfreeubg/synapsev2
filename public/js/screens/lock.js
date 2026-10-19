import { h } from '../core/dom.js';
import { logoMark } from '../core/icons.js';
import { Screen } from '../core/router.js';
import { play, unlockAudio } from '../core/sound.js';
import { statusCluster } from '../core/ui.js';

export class BootScreen extends Screen {
  constructor(name) {
    super('boot');
    this.name = name;
  }

  build() {
    this.el.append(
      h('div.boot-logo', h('span.boot-mark', { html: logoMark }), h('span.boot-word', this.name.toLowerCase())),
    );
  }

  onAction() {
    return true;
  }
}

/** Lock screen: press the same button three times (or tap three times). */
export class LockScreen extends Screen {
  constructor(onUnlock) {
    super('lock');
    this.onUnlock = onUnlock;
    this.count = 0;
    this.lastRaw = null;
  }

  build() {
    this.time = h('div.lock-time');
    this.date = h('div.lock-date');
    this.dots = [h('i'), h('i'), h('i')];
    this.el.append(
      h('div.lock-wallpaper'),
      h('div.lock-top', statusCluster()),
      h('div.lock-clock', this.time, this.date),
      h('div.lock-prompt', h('div.lock-dots', this.dots), h('p', 'Press the same button three times'), h('small', 'or tap the screen three times')),
    );
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.press('tap');
    });
    this.tick();
  }

  tick() {
    const now = new Date();
    this.time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  onShow() {
    this.count = 0;
    this.render();
    this.timer = setInterval(() => this.tick(), 5000);
  }

  onHide() {
    clearInterval(this.timer);
  }

  onAction(action, info) {
    this.press(info.raw || action);
    return true;
  }

  press(raw) {
    unlockAudio();
    this.count = raw === this.lastRaw ? this.count + 1 : 1;
    this.lastRaw = raw;
    this.render();
    clearTimeout(this.reset);
    if (this.count >= 3) {
      this.count = 0;
      play('snap');
      setTimeout(() => this.onUnlock(), 220);
      return;
    }
    play('toggle');
    this.reset = setTimeout(() => {
      this.count = 0;
      this.render();
    }, 1600);
  }

  render() {
    this.dots.forEach((d, i) => d.classList.toggle('on', i < this.count));
  }
}
