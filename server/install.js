import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { isValidPackage } from './adb.js';
import { logger } from './log.js';

const log = logger('install');

export async function tempFile(ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse-'));
  return path.join(dir, `${randomUUID()}${ext}`);
}

export async function removeTemp(file) {
  await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
}

/**
 * Install an APK on every reachable ADB device. When `pkg` is not given it is
 * detected by diffing the package list before and after.
 */
export async function installApk(pool, apkPath, pkg = null) {
  const devices = pool.adbDevices.filter((d) => d.state !== 'offline' && d.state !== 'booting');
  if (!devices.length) throw new Error('No Android devices are online');
  const results = [];
  for (const device of devices) {
    try {
      const before = new Set(device.packages);
      await device.adb.install(apkPath);
      await device.refreshPackages();
      if (!pkg) pkg = [...device.packages].find((p) => !before.has(p)) || null;
      results.push({ device: device.id, ok: true });
    } catch (err) {
      results.push({ device: device.id, ok: false, error: err.message });
    }
  }
  // Keep a copy so devices that come online later get it too.
  if (pkg && results.some((r) => r.ok)) await pool.apks.replace(pkg, apkPath, 'upload');
  return { package: pkg, results };
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

/**
 * Install a free/open-source game from F-Droid. Native games publish one APK
 * per CPU architecture under the same version name, so each device group is
 * tried against the candidates until one installs.
 */
export async function installFromFdroid(pool, pkg) {
  if (!isValidPackage(pkg)) throw new Error('Invalid package name');
  const res = await fetch(`https://f-droid.org/api/v1/packages/${pkg}`);
  if (!res.ok) throw new Error(`F-Droid has no package ${pkg} (HTTP ${res.status})`);
  const meta = await res.json();
  const versions = meta.packages || [];
  const suggested = versions.find((v) => v.versionCode === meta.suggestedVersionCode) || versions[0];
  if (!suggested) throw new Error(`F-Droid lists no versions for ${pkg}`);
  const rank = (v) => (v.versionCode === suggested.versionCode ? Number.MAX_SAFE_INTEGER : v.versionCode);
  const candidates = versions.filter((v) => v.versionName === suggested.versionName).sort((a, b) => rank(b) - rank(a));

  const devices = pool.adbDevices.filter((d) => d.state !== 'offline' && d.state !== 'booting');
  if (!devices.length) throw new Error('No Android devices are online');

  const files = new Map();
  const results = [];
  await pool.apks.remove(pkg);
  try {
    for (const device of devices) {
      let done = false;
      let lastError = 'no compatible APK';
      for (const { versionCode } of candidates) {
        if (!files.has(versionCode)) {
          const file = await tempFile('.apk');
          log.info(`Downloading ${pkg} ${versionCode} from F-Droid`);
          await download(`https://f-droid.org/repo/${pkg}_${versionCode}.apk`, file);
          files.set(versionCode, file);
        }
        try {
          await device.adb.install(files.get(versionCode));
          await pool.apks.save(pkg, files.get(versionCode), String(versionCode));
          done = true;
          break;
        } catch (err) {
          lastError = err.message;
          if (!/NO_MATCHING_ABIS|INSTALL_FAILED_CPU_ABI/i.test(err.message)) break;
        }
      }
      await device.refreshPackages().catch(() => {});
      results.push(done ? { device: device.id, ok: true } : { device: device.id, ok: false, error: lastError });
    }
  } finally {
    for (const file of files.values()) await removeTemp(file);
  }
  return { package: pkg, version: suggested.versionName, results };
}
