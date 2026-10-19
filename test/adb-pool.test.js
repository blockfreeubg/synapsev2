// End-to-end through the ADB path: real server, real AdbDevice/ScrcpySession,
// with test/fixtures/fake-adb.mjs standing in for adb and Android.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeAdb = path.join(root, 'test', 'fixtures', 'fake-adb.mjs');
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let server;
let tmp;
let stateDir;
let output = '';

const logOf = (serial) => {
  const file = path.join(stateDir, `${serial.replace(/[^\w.-]/g, '_')}.log`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met\n${output.slice(-2000)}`);
}

function startServer(env, dataDir) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      DEMO_DEVICES: '0',
      ADB_PATH: fakeAdb,
      FAKE_ADB_STATE: stateDir,
      SCRCPY_SERVER_PATH: path.join(tmp, 'scrcpy-server'),
      DATA_DIR: dataDir,
      ADMIN_TOKEN: 'secret',
      HEALTH_INTERVAL: '1',
      LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  return proc;
}

before(async () => {
  chmodSync(fakeAdb, 0o755);
  tmp = mkdtempSync(path.join(os.tmpdir(), 'synapse-adb-'));
  stateDir = path.join(tmp, 'adb');
  writeFileSync(path.join(tmp, 'scrcpy-server'), 'not a real jar');
  server = startServer({ PORT: String(port), ANDROID_DEVICES: 'phone-1:5555' }, path.join(tmp, 'data'));
  await until(async () => {
    try {
      const s = await (await fetch(`${base}/api/status`)).json();
      return s.devices[0]?.state === 'idle';
    } catch {
      return false;
    }
  });
});

after(() => {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('uploading an APK installs it and adds it to the library', async () => {
  const res = await fetch(`${base}/api/admin/apps?title=${encodeURIComponent('Test Racer')}`, {
    method: 'PUT',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/vnd.android.package-archive' },
    body: 'package=com.example.racer',
  });
  const result = await res.json();
  assert.equal(res.status, 200, JSON.stringify(result));
  assert.equal(result.package, 'com.example.racer');
  assert.deepEqual(result.results, [{ device: 'phone-1:5555', ok: true }]);
  const { games } = await (await fetch(`${base}/api/games`)).json();
  const game = games.find((g) => g.package === 'com.example.racer');
  assert.equal(game.title, 'Test Racer');
  assert.equal(game.devices, 1);
});

test('playing launches the app, streams scrcpy video and delivers input', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/play?pkg=com.example.racer&codecs=h264&audio=1`);
  const messages = [];
  let binary = 0;
  ws.on('message', (data, isBinary) => (isBinary ? binary++ : messages.push(JSON.parse(data.toString()))));
  const meta = await until(() => messages.find((m) => m.t === 'video-meta'));
  assert.deepEqual([meta.codec, meta.width, meta.height, meta.deviceName], ['h264', 1280, 720, 'Fake Phone']);
  const audio = await until(() => messages.find((m) => m.t === 'audio-meta'));
  assert.equal(audio.codec, null, 'the fake device reports audio as disabled');
  await until(() => binary > 5);

  const log = logOf('phone-1:5555');
  assert.match(log, /launch com\.example\.racer/);
  assert.match(log, /scrcpy .*tunnel_forward=true/);
  assert.match(log, /video_codec=h264/);

  ws.send(JSON.stringify({ t: 'touch', a: 0, id: 0, x: 640, y: 360, w: 1280, h: 720 }));
  ws.send(JSON.stringify({ t: 'key', a: 0, k: 3 })); // HOME: must be filtered out
  ws.send(JSON.stringify({ t: 'key', a: 0, k: 96 }));
  const controlBytes = () =>
    Buffer.from(
      logOf('phone-1:5555').split('\n').filter((l) => l.startsWith('control ')).map((l) => l.slice(8)).join(''),
      'hex',
    );
  // touch (type 2, 32 bytes) then BUTTON_A (type 0, 14 bytes); HOME never arrives
  const bytes = await until(() => (controlBytes().length >= 46 ? controlBytes() : null));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(controlBytes().length, 46);
  assert.equal(bytes[0], 2);
  assert.equal(bytes[32], 0);
  assert.equal(bytes.readUInt32BE(34), 96);

  ws.close();
  await until(() => /am force-stop com\.example\.racer/.test(logOf('phone-1:5555')));
  await until(async () => (await (await fetch(`${base}/api/status`)).json()).devices[0].state === 'idle');
});

test('devices found through DNS get stored games installed automatically', async () => {
  // Pre-seed the APK store with two architecture variants of one game.
  const dataDir = path.join(tmp, 'data-dns');
  const apkDir = path.join(dataDir, 'apks', 'com.example.puzzle');
  mkdirSync(apkDir, { recursive: true });
  writeFileSync(path.join(apkDir, '100.apk'), 'package=com.example.puzzle\nabi=arm64-v8a');
  writeFileSync(path.join(apkDir, '101.apk'), 'package=com.example.puzzle\nabi=x86_64');
  const dnsPort = port + 1;
  const proc = startServer({ PORT: String(dnsPort), ANDROID_DEVICES: 'dns:localhost:5555' }, dataDir);
  try {
    const status = await until(async () => {
      try {
        const s = await (await fetch(`http://127.0.0.1:${dnsPort}/api/status`)).json();
        return s.devices[0]?.state === 'idle' && s.devices[0].games > 0 ? s : null;
      } catch {
        return null;
      }
    });
    assert.equal(status.devices[0].id, '127.0.0.1:5555');
    assert.match(logOf('127.0.0.1:5555'), /install com\.example\.puzzle/);
    const { games } = await (await fetch(`http://127.0.0.1:${dnsPort}/api/games`)).json();
    assert.ok(games.some((g) => g.package === 'com.example.puzzle' && g.devices === 1));
  } finally {
    proc.kill();
  }
});
