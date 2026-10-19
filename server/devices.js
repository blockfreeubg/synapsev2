import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import path from 'node:path';
import { Adb } from './adb.js';
import { ApkStore } from './apkstore.js';
import { config } from './config.js';
import { ScrcpySession } from './scrcpy.js';
import { DemoSession, ffmpegEncoders } from './demo.js';
import { logger } from './log.js';

const log = logger('devices');

class BaseDevice {
  constructor(id) {
    this.id = id;
    this.state = 'offline'; // offline | booting | syncing | idle | busy
    this.info = {};
    this.packages = new Set();
    this.lastError = null;
  }

  get available() {
    return this.state === 'idle';
  }

  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      state: this.state,
      model: this.info.model || null,
      android: this.info.android || null,
      abi: this.info.abi || null,
      games: this.packages.size,
      error: this.state === 'offline' ? this.lastError : null,
    };
  }
}

export class AdbDevice extends BaseDevice {
  kind = 'adb';

  constructor(serial) {
    super(serial);
    this.adb = new Adb(serial);
    this.checks = 0;
  }

  get codecs() {
    return config.videoCodecs;
  }

  async refresh() {
    try {
      if ((await this.adb.state()) !== 'device') await this.adb.connect();
      if ((await this.adb.state()) !== 'device') throw new Error('not reachable over adb');
      if ((await this.adb.getprop('sys.boot_completed')) !== '1') {
        if (this.state !== 'busy') this.state = 'booting';
        return;
      }
      const wasOffline = this.state === 'offline' || this.state === 'booting';
      if (wasOffline || !this.info.model) {
        const [model, android, abi] = await Promise.all([
          this.adb.getprop('ro.product.model'),
          this.adb.getprop('ro.build.version.release'),
          this.adb.getprop('ro.product.cpu.abi'),
        ]);
        this.info = { model, android, abi };
        // Keep the screen on; harmless on redroid, needed on real phones.
        await this.adb.shell('svc power stayon true').catch(() => {});
        log.info(`${this.id} online: ${model} (Android ${android}, ${abi})`);
      }
      if (wasOffline || this.checks++ % 6 === 0) await this.refreshPackages();
      this.lastError = null;
      if (wasOffline) this.justOnline = true;
      if (this.state !== 'busy') this.state = this.syncing ? 'syncing' : 'idle';
    } catch (err) {
      if (this.state !== 'offline') log.warn(`${this.id} offline: ${err.message}`);
      this.lastError = err.message;
      if (this.state !== 'busy') this.state = 'offline';
    }
  }

  async refreshPackages() {
    this.packages = new Set(await this.adb.listPackages());
  }

  // `attach` runs before the stream starts so no early event is missed.
  async openSession(pkg, options, attach) {
    await this.adb.keyevent(224); // WAKEUP
    await this.adb.launch(pkg);
    const session = new ScrcpySession(this.adb, options);
    attach?.(session);
    try {
      await session.start();
    } catch (err) {
      session.close('start-failed');
      throw err;
    }
    return session;
  }

  async closeSession(pkg) {
    await this.adb.stopApp(pkg, { clear: config.resetMode === 'clear' });
    await this.adb.keyevent(3); // HOME
  }
}

export class DemoDevice extends BaseDevice {
  kind = 'demo';

  constructor(index, codecs) {
    super(`demo-${index}`);
    this.codecs = codecs;
    this.info = { model: `Demo Device ${index}`, android: null, abi: null };
    this.state = codecs.length ? 'idle' : 'offline';
    this.lastError = codecs.length ? null : 'ffmpeg with libx264 or libsvtav1 not found';
  }

  // Demo devices pretend to have every game installed.
  hasPackage() {
    return true;
  }

  async refresh() {}

  async openSession(pkg, options, attach) {
    const session = new DemoSession(this.info.model, options);
    attach?.(session);
    await session.start();
    return session;
  }

  async closeSession() {}
}

export class DevicePool extends EventEmitter {
  constructor() {
    super();
    this.apks = new ApkStore(path.join(config.dataDir, 'apks'));
    // "dns:redroid:5555" means: every IPv4 address the name resolves to, so
    // `docker compose up --scale redroid=N` adds devices without reconfiguring.
    this.dnsSources = config.devices
      .filter((s) => s.startsWith('dns:'))
      .map((s) => {
        const [host, port = '5555'] = s.slice(4).split(':');
        return { host, port };
      });
    this.devices = config.devices.filter((s) => !s.startsWith('dns:')).map((serial) => new AdbDevice(serial));
    if (config.demoDevices > 0) {
      const codecs = ffmpegEncoders();
      for (let i = 1; i <= config.demoDevices; i++) this.devices.push(new DemoDevice(i, codecs));
    }
    this.waiters = [];
  }

  get adbDevices() {
    return this.devices.filter((d) => d.kind === 'adb');
  }

  async start() {
    await this.refreshAll();
    this.timer = setInterval(() => this.refreshAll(), config.healthInterval);
    this.timer.unref();
  }

  async refreshAll() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.discover();
      await Promise.all(this.devices.map((d) => d.refresh()));
      for (const d of this.adbDevices) {
        if (!d.justOnline) continue;
        d.justOnline = false;
        this.sync(d).catch((err) => log.warn(`${d.id} sync failed: ${err.message}`));
      }
      this.dispatch();
      this.emit('change');
    } finally {
      this.refreshing = false;
    }
  }

  async discover() {
    for (const { host, port } of this.dnsSources) {
      let addresses;
      try {
        addresses = await dns.lookup(host, { all: true, family: 4 });
      } catch {
        continue; // keep what we have; DNS hiccups shouldn't drop devices
      }
      const serials = new Set(addresses.map((a) => `${a.address}:${port}`));
      for (const serial of serials) {
        if (this.devices.some((d) => d.id === serial)) continue;
        const device = new AdbDevice(serial);
        device.source = host;
        this.devices.push(device);
        log.info(`Discovered ${serial} via ${host}`);
      }
      this.devices = this.devices.filter((d) => d.source !== host || serials.has(d.id) || d.state === 'busy');
    }
  }

  /** Install every stored game the device is missing (new or reset devices). */
  async sync(device) {
    const missing = (await this.apks.packages()).filter((p) => !device.packages.has(p));
    if (!missing.length) return;
    device.syncing = true;
    if (device.state === 'idle') device.state = 'syncing';
    this.emit('change');
    log.info(`${device.id}: installing ${missing.length} missing game(s)`);
    try {
      for (const pkg of missing) {
        for (const file of await this.apks.files(pkg)) {
          try {
            await device.adb.install(file);
            break;
          } catch (err) {
            // Try the next architecture variant; anything else is a real failure.
            if (!/NO_MATCHING_ABIS|CPU_ABI/i.test(err.message)) {
              log.warn(`${device.id}: ${pkg} failed to install: ${err.message}`);
              break;
            }
          }
        }
      }
      await device.refreshPackages();
    } finally {
      device.syncing = false;
      if (device.state === 'syncing') device.state = 'idle';
      this.dispatch();
    }
  }

  deviceHas(device, pkg) {
    return device.hasPackage ? device.hasPackage(pkg) : device.packages.has(pkg);
  }

  /** Online devices that have the package installed. */
  countWith(pkg) {
    return this.devices.filter((d) => d.state !== 'offline' && this.deviceHas(d, pkg)).length;
  }

  installedPackages() {
    const all = new Set();
    for (const d of this.adbDevices) if (d.state !== 'offline') for (const p of d.packages) all.add(p);
    return all;
  }

  get hasDemo() {
    return this.devices.some((d) => d.kind === 'demo' && d.state !== 'offline');
  }

  /**
   * Wait for a free device that has `pkg` installed. `onPosition(n)` reports
   * the 1-based place in line while waiting. Call `cancel()` on the returned
   * ticket to leave the queue.
   */
  acquire(pkg, onPosition) {
    let ticket;
    const promise = new Promise((resolve, reject) => {
      ticket = { pkg, resolve, reject, onPosition };
    });
    ticket.promise = promise;
    ticket.cancel = () => {
      const i = this.waiters.indexOf(ticket);
      if (i >= 0) {
        this.waiters.splice(i, 1);
        ticket.reject(new Error('cancelled'));
        this.notifyPositions();
      }
    };
    promise.catch(() => {});
    this.waiters.push(ticket);
    this.dispatch();
    if (this.waiters.includes(ticket)) this.notifyPositions();
    return ticket;
  }

  dispatch() {
    for (let i = 0; i < this.waiters.length; ) {
      const ticket = this.waiters[i];
      const device = this.devices.find((d) => d.available && this.deviceHas(d, ticket.pkg));
      if (!device) {
        i++;
        continue;
      }
      device.state = 'busy';
      this.waiters.splice(i, 1);
      ticket.resolve(device);
    }
    this.notifyPositions();
    this.emit('change');
  }

  notifyPositions() {
    this.waiters.forEach((t, i) => t.onPosition?.(i + 1, this.waiters.length));
  }

  release(device) {
    if (device.state === 'busy') device.state = 'idle';
    // Re-check health before handing the device to the next player.
    device.refresh().finally(() => this.dispatch());
  }

  snapshot() {
    return {
      devices: this.devices.map((d) => d.snapshot()),
      queue: this.waiters.length,
      busy: this.devices.filter((d) => d.state === 'busy').length,
      idle: this.devices.filter((d) => d.state === 'idle').length,
    };
  }
}
