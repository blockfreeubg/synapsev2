import { h, svgIcon } from '../core/dom.js';
import { Screen } from '../core/router.js';
import { api } from '../core/api.js';
import { footer, header, setServerOnline } from '../core/ui.js';
import { app } from '../app.js';

const STATE_BADGE = {
  idle: ['ok', 'Available'],
  busy: ['busy', 'In use'],
  booting: ['busy', 'Starting up'],
  syncing: ['busy', 'Installing games'],
  offline: ['bad', 'Offline'],
};

/** Live view of the device pool and queue. */
export class StatusScreen extends Screen {
  constructor() {
    super('status');
  }

  build() {
    this.body = h('div.page-body', { data: { revealMargin: '40' } });
    this.el.append(header('Network Status', 'news', { accent: '#ec4a3c' }), this.body, footer([['b', 'Back']]));
  }

  onShow() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 3000);
  }

  onHide() {
    clearInterval(this.timer);
  }

  async refresh() {
    const started = performance.now();
    let status;
    try {
      status = await api('/api/status');
      setServerOnline(true);
    } catch (err) {
      setServerOnline(false);
      this.body.replaceChildren(h('div.empty-state', svgIcon('wifi'), h('p', 'Can’t reach the server.'), h('p.note', err.message)));
      return;
    }
    const ping = Math.round(performance.now() - started);
    const focused = this.scope.current?.dataset.device;
    const devices = status.devices;
    this.body.replaceChildren(
      h(
        'div.stat-strip',
        h('div.stat', h('b', String(status.idle)), h('span', 'devices available')),
        h('div.stat', h('b', String(status.busy)), h('span', 'playing now')),
        h('div.stat', h('b', String(status.queue)), h('span', 'waiting in line')),
        h('div.stat', h('b', `${ping}`), h('span', 'ms to server')),
      ),
      h('h2.section-title', `Devices (${devices.length})`),
      devices.length
        ? h(
            'div.rows',
            devices.map((d) => {
              const [cls, label] = STATE_BADGE[d.state] || ['', d.state];
              return h(
                'button.device-card',
                { type: 'button', data: { nav: '', device: d.id, sound: 'none' } },
                svgIcon(d.kind === 'demo' ? 'monitor' : 'phone'),
                h(
                  'span.row-main',
                  h('span', d.model || d.id),
                  h('span.row-sub', [d.id, d.android && `Android ${d.android}`, d.abi, d.kind === 'adb' ? `${d.games} apps` : 'demo stream'].filter(Boolean).join(' · ')),
                  d.error && h('span.row-sub', d.error),
                ),
                h(`span.badge.${cls}`, label),
              );
            }),
          )
        : h('p.note', 'No devices are configured. Set ANDROID_DEVICES on the server, or DEMO_DEVICES=1 to try a test stream.'),
      app.demo && h('p.note', 'Demo devices stream a test pattern instead of a real game, so you can try the interface without Android.'),
    );
    const again = focused && this.body.querySelector(`[data-device="${CSS.escape(focused)}"]`);
    if (again) this.scope.focus(again, { sound: false, scroll: false });
    else this.scope.focusInitial({ smooth: false });
  }
}
