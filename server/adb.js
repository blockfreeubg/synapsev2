import { execFile, spawn } from 'node:child_process';
import { config } from './config.js';

// Package names end up inside `adb shell` command strings, which the device's
// shell parses, so anything interpolated there must be strictly validated.
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export function isValidPackage(name) {
  return typeof name === 'string' && name.length <= 255 && PACKAGE_RE.test(name);
}

function assertPackage(name) {
  if (!isValidPackage(name)) throw new Error(`Invalid package name: ${name}`);
}

export function run(args, { timeout = 15_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).toString().trim();
        reject(new Error(`adb ${args.join(' ')}: ${detail}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

export class Adb {
  constructor(serial) {
    this.serial = serial;
  }

  get isNetwork() {
    return /:\d+$/.test(this.serial);
  }

  run(args, opts) {
    return run(['-s', this.serial, ...args], opts);
  }

  async shell(command, opts) {
    return (await this.run(['shell', command], opts)).trim();
  }

  spawnShell(command) {
    return spawn(config.adbPath, ['-s', this.serial, 'shell', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async connect() {
    if (!this.isNetwork) return;
    const out = await run(['connect', this.serial], { timeout: 10_000 });
    if (/unable|failed|cannot/i.test(out)) throw new Error(out.trim());
  }

  async state() {
    try {
      return (await this.run(['get-state'], { timeout: 5_000 })).trim();
    } catch {
      return 'offline';
    }
  }

  async getprop(name) {
    return this.shell(`getprop ${name}`, { timeout: 5_000 });
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3', { timeout: 15_000 });
    return out
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(isValidPackage);
  }

  async push(local, remote) {
    await this.run(['push', local, remote], { timeout: 60_000 });
  }

  async install(apkPath) {
    // -r: replace existing, -g: grant all runtime permissions up front.
    const out = await this.run(['install', '-r', '-g', apkPath], { timeout: 10 * 60_000 });
    if (!/Success/.test(out)) throw new Error(out.trim() || 'install failed');
    return out.trim();
  }

  async uninstall(pkg) {
    assertPackage(pkg);
    return this.run(['uninstall', pkg], { timeout: 60_000 });
  }

  async forward(remote) {
    // tcp:0 asks adb to pick a free port and print it.
    const out = (await this.run(['forward', 'tcp:0', remote])).trim();
    const port = Number.parseInt(out, 10);
    if (!Number.isFinite(port) || port <= 0) throw new Error(`adb forward returned "${out}"`);
    return port;
  }

  async removeForward(port) {
    await this.run(['forward', '--remove', `tcp:${port}`]).catch(() => {});
  }

  async launch(pkg) {
    assertPackage(pkg);
    const out = await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, {
      timeout: 20_000,
    });
    if (/No activities found|monkey aborted/i.test(out)) {
      throw new Error(`${pkg} has no launchable activity`);
    }
  }

  async stopApp(pkg, { clear = false } = {}) {
    assertPackage(pkg);
    await this.shell(clear ? `pm clear ${pkg}` : `am force-stop ${pkg}`).catch(() => {});
  }

  async keyevent(code) {
    await this.shell(`input keyevent ${Number(code) | 0}`).catch(() => {});
  }
}
