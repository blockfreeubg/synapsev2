// Keeps a copy of every installed APK so devices added later (or reset) can
// be brought up to date automatically. Layout: <dir>/<package>/<tag>.apk
// where tag is "upload" or an F-Droid versionCode (one per CPU architecture).

import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidPackage } from './adb.js';

export class ApkStore {
  constructor(dir) {
    this.dir = dir;
  }

  async save(pkg, file, tag) {
    if (!isValidPackage(pkg)) return;
    const target = path.join(this.dir, pkg);
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(file, path.join(target, `${tag}.apk`));
  }

  async replace(pkg, file, tag) {
    await this.remove(pkg);
    await this.save(pkg, file, tag);
  }

  async remove(pkg) {
    if (!isValidPackage(pkg)) return;
    await fs.rm(path.join(this.dir, pkg), { recursive: true, force: true });
  }

  async packages() {
    try {
      return (await fs.readdir(this.dir)).filter(isValidPackage);
    } catch {
      return [];
    }
  }

  async files(pkg) {
    try {
      const dir = path.join(this.dir, pkg);
      return (await fs.readdir(dir)).filter((f) => f.endsWith('.apk')).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }
}
