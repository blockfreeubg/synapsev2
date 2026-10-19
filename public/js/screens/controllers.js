import { h, svgIcon } from '../core/dom.js';
import { Screen } from '../core/router.js';
import { input } from '../core/input.js';
import { footer, header } from '../core/ui.js';

const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'L1', 'R1', 'L2', 'R2', 'Select', 'Start', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home'];

const KEYMAP = [
  ['Return to HOME Menu', ['Esc'], 'HOME button, or Select + Start'],
  ['Quick menu', ['F2'], 'Hold HOME'],
  ['Capture screenshot', ['F8'], 'Quick menu'],
  ['Android Back', ['Right click'], 'B (in most games)'],
  ['Touch', ['Click / drag'], 'Tap the screen'],
  ['Scroll', ['Mouse wheel'], 'Two-finger drag'],
  ['Keys and text', ['Any key'], 'Quick menu › Type Text'],
];

export class ControllersScreen extends Screen {
  constructor() {
    super('controllers');
  }

  build() {
    this.pads = h('div');
    this.el.append(
      header('Controllers', 'controller', { accent: '#17b7a0' }),
      h(
        'div.page-body',
        { data: { revealMargin: '40' } },
        h('h2.section-title', 'Test input devices'),
        this.pads,
        h('button.row', { type: 'button', data: { nav: '', navDefault: '' } }, svgIcon('info', 'lead'), h('span.row-main', h('span', 'Press buttons on any controller to test it'), h('span.row-sub', 'Connected controllers appear above'))),
        h('h2.section-title', 'Controls while playing'),
        h(
          'table.keymap',
          h('tbody', KEYMAP.map(([what, keys, pad]) => h('tr', h('td', what), h('td', keys.map((k) => h('kbd', k))), h('td', pad)))),
        ),
        h('p.note', 'Controller buttons reach the game as Android gamepad keys (BUTTON_A, BUTTON_B, …) by position, and the D-pad as DPAD keys. Analog sticks can’t be sent as key events, so the left stick works as a D-pad by default.'),
      ),
      footer([['b', 'Back']]),
    );
  }

  onShow() {
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  onHide() {
    cancelAnimationFrame(this.raf);
  }

  draw() {
    const pads = input.snapshot();
    if (!pads.length) {
      if (this.padCount !== 0) {
        this.pads.replaceChildren(h('div.pad-test', h('div.pad-name', 'No controllers detected'), h('p.note', 'Connect a USB or Bluetooth controller and press any button. Browsers only reveal controllers after a button press.')));
        this.padCount = 0;
      }
      return;
    }
    if (this.padCount !== pads.length) {
      this.padCount = pads.length;
      this.pads.replaceChildren(
        ...pads.map((p) =>
          h(
            'div.pad-test',
            { data: { pad: p.index } },
            h('div.pad-name', `${p.index + 1}. ${p.id}`),
            h('div.pad-buttons', p.buttons.map((_, i) => h('span', BUTTON_NAMES[i] || `B${i}`))),
            h('div.pad-sticks', h('span.stick', h('i')), h('span.stick', h('i'))),
            p.mapping !== 'standard' && h('p.note', 'This controller doesn’t use the standard layout, so some buttons may be swapped.'),
          ),
        ),
      );
    }
    for (const p of pads) {
      const card = this.pads.querySelector(`[data-pad="${p.index}"]`);
      if (!card) continue;
      card.querySelectorAll('.pad-buttons span').forEach((el, i) => el.classList.toggle('on', p.buttons[i] > 0.5));
      card.querySelectorAll('.stick i').forEach((dot, s) => {
        const x = p.axes[s * 2] || 0;
        const y = p.axes[s * 2 + 1] || 0;
        dot.style.transform = `translate(${x * 150}%, ${y * 150}%)`;
      });
    }
  }
}
