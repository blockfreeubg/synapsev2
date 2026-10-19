#!/usr/bin/env node
// A stand-in for the `adb` CLI that simulates Android devices, including a
// scrcpy server speaking the real wire protocol. State lives in FAKE_ADB_STATE.
//
// Test "APKs" are text files containing `package=<name>` and optionally
// `abi=<abi>`; fake devices report the x86_64 ABI.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const stateDir = process.env.FAKE_ADB_STATE;
fs.mkdirSync(stateDir, { recursive: true });
let args = process.argv.slice(2);
let serial = 'default';
if (args[0] === '-s') {
  serial = args[1];
  args = args.slice(2);
}
const safe = serial.replace(/[^\w.-]/g, '_');
const pkgFile = path.join(stateDir, `${safe}.packages`);
const logFile = path.join(stateDir, `${safe}.log`);
const record = (line) => fs.appendFileSync(logFile, `${line}\n`);
const packages = () => (fs.existsSync(pkgFile) ? fs.readFileSync(pkgFile, 'utf8').split('\n').filter(Boolean) : []);
const out = (text) => process.stdout.write(`${text}\n`);

function shell(cmd) {
  const props = { 'sys.boot_completed': '1', 'ro.product.model': 'Fake Phone', 'ro.build.version.release': '13', 'ro.product.cpu.abi': 'x86_64' };
  let m;
  if ((m = cmd.match(/^getprop (\S+)$/))) return out(props[m[1]] ?? '');
  if (cmd === 'pm list packages -3') return out(packages().map((p) => `package:${p}`).join('\n'));
  if ((m = cmd.match(/^monkey -p (\S+) /))) {
    record(`launch ${m[1]}`);
    return out(packages().includes(m[1]) ? 'Events injected: 1' : '** No activities found to run, monkey aborted.');
  }
  if ((m = cmd.match(/^(am force-stop|pm clear|input keyevent) (\S+)$/))) return record(`${m[1]} ${m[2]}`);
  if (cmd === 'svc power stayon true') return;
  if (cmd.startsWith('CLASSPATH=')) return scrcpy(cmd);
  process.stderr.write(`fake-adb: unknown shell command: ${cmd}\n`);
  process.exit(1);
}

function scrcpy(cmd) {
  const opts = Object.fromEntries([...cmd.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  record(`scrcpy ${cmd.split(' ').slice(4).join(' ')}`);
  const port = Number(fs.readFileSync(path.join(stateDir, `forward-scrcpy_${opts.scid}`), 'utf8'));
  const roles = ['video', ...(opts.audio === 'true' ? ['audio'] : []), 'control'];
  let accepted = 0;
  const server = net.createServer((socket) => {
    const role = roles[accepted++];
    if (role === 'video') {
      const name = Buffer.alloc(64);
      name.write('Fake Phone');
      const meta = Buffer.alloc(12);
      meta.writeUInt32BE(0x68323634, 0);
      meta.writeUInt32BE(1280, 4);
      meta.writeUInt32BE(720, 8);
      socket.write(Buffer.concat([Buffer.from([0]), name, meta]));
      const packet = (pts, data, flags) => {
        const h = Buffer.alloc(12);
        h.writeBigUInt64BE(BigInt(pts) | flags, 0);
        h.writeUInt32BE(data.length, 8);
        return Buffer.concat([h, data]);
      };
      socket.write(packet(0, Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f]), 1n << 63n));
      let pts = 0;
      const timer = setInterval(() => {
        pts += 16666;
        const key = pts % 1_000_000 < 16666;
        socket.write(packet(pts, Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, 1, 2, 3]), key ? 1n << 62n : 0n));
      }, 16);
      socket.on('close', () => {
        clearInterval(timer);
        process.exit(0);
      });
    } else if (role === 'audio') {
      socket.write(Buffer.from([0, 0, 0, 0])); // audio disabled on this device
    } else {
      socket.on('data', (d) => record(`control ${d.toString('hex')}`));
    }
    socket.on('error', () => {});
  });
  // Start late on purpose so the client has to retry through the tunnel.
  setTimeout(() => server.listen(port, '127.0.0.1'), 300);
}

const [command, ...rest] = args;
switch (command) {
  case 'connect':
    out(`connected to ${rest[0]}`);
    break;
  case 'get-state':
    out('device');
    break;
  case 'shell':
    shell(rest.join(' '));
    break;
  case 'push':
    out('1 file pushed');
    break;
  case 'forward': {
    if (rest[0] === '--remove') break;
    const name = rest[1].replace('localabstract:', '');
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => {
        fs.writeFileSync(path.join(stateDir, `forward-${name}`), String(port));
        out(String(port));
      });
    });
    break;
  }
  case 'install': {
    const apk = fs.readFileSync(rest[rest.length - 1], 'utf8');
    const pkg = apk.match(/package=(\S+)/)?.[1];
    const abi = apk.match(/abi=(\S+)/)?.[1];
    if (abi && abi !== 'x86_64') {
      out('Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries]');
      process.exit(1);
    }
    if (!packages().includes(pkg)) fs.appendFileSync(pkgFile, `${pkg}\n`);
    record(`install ${pkg}`);
    out('Performing Streamed Install\nSuccess');
    break;
  }
  case 'uninstall':
    fs.writeFileSync(pkgFile, packages().filter((p) => p !== rest[0]).join('\n') + '\n');
    out('Success');
    break;
  default:
    process.stderr.write(`fake-adb: unsupported command ${args.join(' ')}\n`);
    process.exit(1);
}
