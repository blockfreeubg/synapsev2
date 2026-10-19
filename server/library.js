import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isValidPackage } from './adb.js';
import { logger } from './log.js';

const log = logger('library');
const COVER_EXTS = ['png', 'jpg', 'webp'];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Could not read ${file}: ${err.message}`);
    return fallback;
  }
}

// "com.example.super_kart" -> "Super Kart"
export function titleFromPackage(pkg) {
  const last = pkg.split('.').pop() || pkg;
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export class Library {
  constructor(pool) {
    this.pool = pool;
    this.seed = { autoDiscover: true, games: [] };
    this.catalog = [];
    this.overrides = {};
    this.overridesFile = path.join(config.dataDir, 'library.json');
    this.coversDir = path.join(config.dataDir, 'covers');
  }

  async load() {
    await fs.mkdir(this.coversDir, { recursive: true });
    this.seed = { autoDiscover: true, games: [], ...(await readJson(config.gamesFile, {})) };
    this.catalog = (await readJson(path.join(config.root, 'config', 'fdroid.json'), { games: [] })).games;
    this.overrides = (await readJson(this.overridesFile, { games: {} })).games || {};
  }

  async save() {
    await fs.mkdir(config.dataDir, { recursive: true });
    const tmp = `${this.overridesFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ games: this.overrides }, null, 2));
    await fs.rename(tmp, this.overridesFile);
  }

  catalogEntry(pkg) {
    return this.catalog.find((g) => g.package === pkg);
  }

  coverFile(pkg) {
    for (const ext of COVER_EXTS) {
      const file = path.join(this.coversDir, `${pkg}.${ext}`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  coverUrl(entry) {
    const file = this.coverFile(entry.package);
    if (file) return `/covers/${path.basename(file)}?v=${Math.round(statSync(file).mtimeMs)}`;
    return entry.cover || null;
  }

  entries() {
    const map = new Map();
    const add = (pkg, fields) => map.set(pkg, { ...map.get(pkg), ...fields, package: pkg });
    for (const g of this.seed.games || []) if (isValidPackage(g.package)) add(g.package, g);

    const installed = this.pool.installedPackages();
    if (this.seed.autoDiscover !== false) {
      for (const pkg of installed) {
        if (map.has(pkg)) continue;
        const known = this.catalogEntry(pkg);
        add(pkg, known ? { ...known } : { title: titleFromPackage(pkg) });
      }
    }
    // With demo devices, show the free catalog so the menu isn't empty.
    if (this.pool.hasDemo) for (const g of this.catalog) if (!map.has(g.package)) add(g.package, { ...g });

    for (const [pkg, o] of Object.entries(this.overrides)) {
      if (map.has(pkg) || o.title) add(pkg, o);
    }
    return [...map.values()].filter((e) => !e.hidden);
  }

  list() {
    return this.entries()
      .map((e) => ({
        id: e.package,
        package: e.package,
        title: e.title || titleFromPackage(e.package),
        publisher: e.publisher || null,
        color: e.color || null,
        description: e.description || null,
        cover: this.coverUrl(e),
        devices: this.pool.countWith(e.package),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  get(pkg) {
    return this.list().find((g) => g.package === pkg) || null;
  }

  async update(pkg, fields) {
    const allowed = {};
    for (const key of ['title', 'publisher', 'color', 'description']) {
      if (typeof fields[key] === 'string') allowed[key] = fields[key].slice(0, 120);
    }
    if (typeof fields.hidden === 'boolean') allowed.hidden = fields.hidden;
    this.overrides[pkg] = { ...this.overrides[pkg], ...allowed };
    await this.save();
  }

  async saveCover(pkg, ext, buffer) {
    for (const e of COVER_EXTS) await fs.rm(path.join(this.coversDir, `${pkg}.${e}`), { force: true });
    await fs.writeFile(path.join(this.coversDir, `${pkg}.${ext}`), buffer);
  }
}
