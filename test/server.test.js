// End-to-end: real HTTP/WebSocket server with one demo device (needs ffmpeg).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasFfmpeg = /libx264|libsvtav1/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let server;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'synapse-test-'));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DEMO_DEVICES: '1', ANDROID_DEVICES: '', DATA_DIR: dataDir, ADMIN_TOKEN: 'secret', LOG_LEVEL: 'warn' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/info`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

function connect(pkg) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/play?pkg=${pkg}&codecs=h264,av1`);
  const messages = [];
  let binary = 0;
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      binary++;
      return;
    }
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  return {
    ws,
    messages,
    get binary() {
      return binary;
    },
    waitFor(t, timeout = 8000) {
      const found = messages.find((m) => m.t === t);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({ match: (m) => m.t === t, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), timeout);
      });
    },
  };
}

test('serves the app and its API', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<div id="screens">/);
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.adminEnabled, true);
  const { games } = await (await fetch(`${base}/api/games`)).json();
  assert.ok(games.length > 0);
  assert.equal((await fetch(`${base}/../server/config.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/admin/check`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/check`, { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 200);
});

test('a second player queues until the device is free', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const pkg = 'com.uberspot.a2048';
  const first = connect(pkg);
  await first.waitFor('starting');
  const meta = await first.waitFor('video-meta');
  assert.ok(['h264', 'av1'].includes(meta.codec));
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(first.binary > 0, 'video packets arrive');

  const second = connect(pkg);
  const queued = await second.waitFor('queue');
  assert.deepEqual([queued.position, queued.total], [1, 1]);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.queue, 1);
  assert.equal(status.busy, 1);

  first.ws.close();
  const started = await second.waitFor('starting');
  assert.equal(started.device.id, 'demo-1');
  second.ws.close();
});

test('unknown games are rejected', async () => {
  const c = connect('com.example.not.installed');
  const end = await c.waitFor('end');
  assert.equal(end.reason, 'error');
});
