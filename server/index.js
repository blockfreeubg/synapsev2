import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { DevicePool } from './devices.js';
import { Library } from './library.js';
import { PlaySession } from './session.js';
import { installApk, installFromFdroid, tempFile, removeTemp } from './install.js';
import { isValidPackage } from './adb.js';
import { logger } from './log.js';

const log = logger('http');
const publicDir = path.join(config.root, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(data);
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function readBodyToFile(req, file, limit) {
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) req.destroy(new HttpError(413, 'Upload too large'));
  });
  await pipeline(req, fs.createWriteStream(file));
  if (!size) throw new HttpError(400, 'Empty upload');
}

function checkAccess(req, url) {
  if (!config.accessCode) return;
  const code = req.headers['x-access-code'] || url.searchParams.get('code') || '';
  if (!safeEqual(code, config.accessCode)) throw new HttpError(401, 'Access code required');
}

function checkAdmin(req) {
  if (!config.adminToken) throw new HttpError(403, 'Admin features are disabled. Set ADMIN_TOKEN on the server.');
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(token, config.adminToken)) throw new HttpError(401, 'Wrong admin token');
}

async function serveFile(req, res, file, cacheControl = 'no-cache') {
  let stat;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new HttpError(404, 'Not found');
  }
  const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cacheControl,
    etag,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function resolveInside(dir, relative) {
  const file = path.normalize(path.join(dir, relative));
  if (file !== dir && !file.startsWith(dir + path.sep)) throw new HttpError(404, 'Not found');
  return file;
}

const pool = new DevicePool();
const library = new Library(pool);

async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/info' && method === 'GET') {
    return json(res, 200, {
      name: config.name,
      accessCodeRequired: Boolean(config.accessCode),
      adminEnabled: Boolean(config.adminToken),
      audio: config.audio,
      limits: config.limits,
      defaults: config.defaults,
      idleTimeout: config.idleTimeout,
      sessionMaxMinutes: config.sessionMaxMinutes,
    });
  }

  if (pathname === '/api/status' && method === 'GET') {
    return json(res, 200, pool.snapshot());
  }

  if (pathname === '/api/games' && method === 'GET') {
    checkAccess(req, url);
    return json(res, 200, { games: library.list(), demo: pool.hasDemo });
  }

  if (pathname === '/api/catalog' && method === 'GET') {
    checkAccess(req, url);
    const installed = pool.installedPackages();
    return json(res, 200, {
      games: library.catalog.map((g) => ({ ...g, installed: installed.has(g.package) })),
    });
  }

  if (pathname.startsWith('/api/admin/')) {
    checkAdmin(req);
    const rest = pathname.slice('/api/admin/'.length).split('/').map(decodeURIComponent);

    if (rest[0] === 'check' && method === 'POST') return json(res, 200, { ok: true });

    if (rest[0] === 'apps' && rest.length === 1 && method === 'PUT') {
      const pkg = url.searchParams.get('package') || null;
      if (pkg && !isValidPackage(pkg)) throw new HttpError(400, 'Invalid package name');
      const file = await tempFile('.apk');
      try {
        await readBodyToFile(req, file, config.maxUploadBytes);
        const result = await installApk(pool, file, pkg);
        const title = url.searchParams.get('title');
        if (result.package && title) await library.update(result.package, { title, hidden: false });
        else if (result.package) await library.update(result.package, { hidden: false });
        return json(res, 200, result);
      } finally {
        await removeTemp(file);
      }
    }

    if (rest[0] === 'fdroid' && rest.length === 2 && method === 'POST') {
      const result = await installFromFdroid(pool, rest[1]);
      const entry = library.catalogEntry(rest[1]);
      await library.update(rest[1], { title: entry?.title || undefined, hidden: false });
      return json(res, 200, result);
    }

    if (rest[0] === 'apps' && rest.length >= 2) {
      const pkg = rest[1];
      if (!isValidPackage(pkg)) throw new HttpError(400, 'Invalid package name');

      if (rest.length === 2 && method === 'PATCH') {
        await library.update(pkg, await readJsonBody(req));
        return json(res, 200, { game: library.get(pkg) });
      }

      if (rest.length === 2 && method === 'DELETE') {
        const results = [];
        for (const device of pool.adbDevices.filter((d) => d.state !== 'offline')) {
          try {
            await device.adb.uninstall(pkg);
            await device.refreshPackages();
            results.push({ device: device.id, ok: true });
          } catch (err) {
            results.push({ device: device.id, ok: false, error: err.message });
          }
        }
        await pool.apks.remove(pkg);
        await library.update(pkg, { hidden: true });
        return json(res, 200, { results });
      }

      if (rest.length === 3 && rest[2] === 'cover' && method === 'PUT') {
        const ext = IMAGE_TYPES[(req.headers['content-type'] || '').split(';')[0]];
        if (!ext) throw new HttpError(415, 'Cover must be PNG, JPEG or WebP');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new HttpError(413, 'Cover image too large (max 8 MB)');
          chunks.push(chunk);
        }
        await library.saveCover(pkg, ext, Buffer.concat(chunks));
        return json(res, 200, { game: library.get(pkg) });
      }
    }
  }

  throw new HttpError(404, 'Unknown API route');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (url.pathname.startsWith('/covers/')) {
      const file = resolveInside(library.coversDir, decodeURIComponent(url.pathname.slice('/covers/'.length)));
      return await serveFile(req, res, file, 'public, max-age=86400');
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
    await serveFile(req, res, resolveInside(publicDir, relative));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log.error(err.stack || err.message);
    if (res.headersSent) return res.destroy();
    if (url.pathname.startsWith('/api/')) json(res, status, { error: err.message });
    else {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status === 404 ? 'Not found' : 'Error');
    }
  }
});
// Large APK uploads and F-Droid installs can take a while.
server.requestTimeout = 30 * 60_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws/play') return socket.destroy();
  try {
    checkAccess(req, url);
  } catch {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = new PlaySession(ws, { pool, library, params: url.searchParams });
    session.run().catch((err) => {
      log.error(err.stack || err.message);
      session.end('error', 'Internal server error');
    });
  });
});

await library.load();
await pool.start();
server.listen(config.port, config.host, () => {
  const s = pool.snapshot();
  log.info(`${config.name} listening on http://${config.host}:${config.port}`);
  log.info(`${s.devices.length} device(s): ${s.devices.map((d) => `${d.id}=${d.state}`).join(', ') || 'none'}`);
  if (!config.adminToken) log.info('ADMIN_TOKEN not set: installing games from the UI is disabled');
  if (config.devices.length && !fs.existsSync(config.scrcpyServerPath)) {
    log.warn(`scrcpy server not found at ${config.scrcpyServerPath}. Run "npm run fetch-scrcpy" or set SCRCPY_SERVER_PATH.`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('Shutting down');
    for (const ws of wss.clients) ws.close(1001);
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
