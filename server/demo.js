// A fake device that streams an ffmpeg test pattern through the same packet
// framing scrcpy uses, so the UI and the browser decode path can be exercised
// without any Android device.

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('demo');

export function ffmpegEncoders() {
  try {
    const out = spawnSync(config.ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (out.status !== 0) return [];
    const codecs = [];
    if (/\blibx264\b/.test(out.stdout)) codecs.push('h264');
    if (/\blibsvtav1\b/.test(out.stdout)) codecs.push('av1');
    return codecs;
  } catch {
    return [];
  }
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

// Offsets of Annex-B start codes (3 or 4 bytes) in buf, with the NAL start after each.
export function findStartCodes(buf, from = 0) {
  const out = [];
  for (let i = from; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const start = i > from && buf[i - 1] === 0 ? i - 1 : i;
      out.push({ start, nal: i + 3 });
      i += 2;
    }
  }
  return out;
}

/** Split an H.264 access unit into a config packet (SPS/PPS) and the frame. */
export function splitH264AccessUnit(au) {
  const codes = findStartCodes(au);
  const config = [];
  const frame = [];
  let key = false;
  codes.forEach((c, i) => {
    const end = i + 1 < codes.length ? codes[i + 1].start : au.length;
    const nal = au.subarray(c.nal, end);
    if (!nal.length) return;
    const type = nal[0] & 0x1f;
    if (type === 9) return; // access unit delimiter
    if (type === 7 || type === 8) config.push(START_CODE, nal);
    else {
      if (type === 5) key = true;
      frame.push(START_CODE, nal);
    }
  });
  return {
    config: config.length ? Buffer.concat(config) : null,
    frame: frame.length ? Buffer.concat(frame) : null,
    key,
  };
}

/** Incrementally splits an Annex-B H.264 stream on access unit delimiters. */
export class H264Splitter {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let begin = -1;
    for (const c of findStartCodes(this.buf)) {
      if (c.nal >= this.buf.length) break;
      if ((this.buf[c.nal] & 0x1f) !== 9) continue;
      if (begin >= 0) this.onAccessUnit(this.buf.subarray(begin, c.start));
      begin = c.start;
    }
    if (begin > 0) this.buf = this.buf.subarray(begin);
  }
}

function readLeb128(buf, offset) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return { value, length: i + 1 };
  }
  return null;
}

/**
 * Incrementally splits an AV1 low-overhead OBU stream into temporal units,
 * pulling sequence headers out as config packets.
 */
export class Av1Splitter {
  constructor(onUnit) {
    this.onUnit = onUnit;
    this.buf = Buffer.alloc(0);
    this.obus = [];
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let offset = 0;
    while (offset < this.buf.length) {
      const header = this.buf[offset];
      const hasExtension = (header >> 2) & 1;
      const hasSize = (header >> 1) & 1;
      if (!hasSize) throw new Error('AV1 OBU without size field');
      const leb = readLeb128(this.buf, offset + 1 + hasExtension);
      if (!leb) break;
      const payloadStart = offset + 1 + hasExtension + leb.length;
      const end = payloadStart + leb.value;
      if (end > this.buf.length) break;
      const type = (header >> 3) & 0xf;
      if (type === 2 && this.obus.length) this.flush();
      this.obus.push({ type, data: this.buf.subarray(offset, end), payload: this.buf.subarray(payloadStart, end) });
      offset = end;
    }
    this.buf = this.buf.subarray(offset);
  }

  flush() {
    const config = [];
    const frame = [];
    let key = false;
    for (const obu of this.obus) {
      if (obu.type === 1) {
        config.push(obu.data);
        continue;
      }
      // OBU_FRAME_HEADER (3) / OBU_FRAME (6): show_existing_frame(1) frame_type(2)
      if ((obu.type === 3 || obu.type === 6) && obu.payload.length) {
        const b = obu.payload[0];
        if (!(b & 0x80) && ((b >> 5) & 0x3) === 0) key = true;
      }
      frame.push(obu.data);
    }
    this.obus = [];
    this.onUnit({
      config: config.length ? Buffer.concat(config) : null,
      frame: frame.length ? Buffer.concat(frame) : null,
      key,
    });
  }
}

function ffmpegArgs(codec, { width, height, fps, bitrate }) {
  const input = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`];
  const gop = String(fps * 2);
  if (codec === 'av1') {
    return [...input, '-c:v', 'libsvtav1', '-preset', '12', '-g', gop, '-b:v', String(bitrate), '-pix_fmt', 'yuv420p', '-f', 'obu', 'pipe:1'];
  }
  return [
    ...input,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline',
    '-pix_fmt', 'yuv420p', '-g', gop, '-b:v', String(bitrate),
    '-x264-params', 'aud=1:repeat-headers=1', '-f', 'h264', 'pipe:1',
  ];
}

/** Same event interface as ScrcpySession. */
export class DemoSession extends EventEmitter {
  constructor(name, options) {
    super();
    this.name = name;
    this.options = options;
    this.closed = false;
  }

  async start() {
    const fps = Math.min(this.options.fps, 30);
    const height = Math.min(720, Math.round((this.options.maxSize * 9) / 16));
    const width = Math.round((height * 16) / 9 / 2) * 2;
    const codec = this.options.codec;
    this.proc = spawn(config.ffmpegPath, ffmpegArgs(codec, { width, height, fps, bitrate: Math.min(this.options.bitrate, 4_000_000) }), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', (d) => log.warn(d.toString().trim()));
    this.proc.on('exit', () => this.close('demo-ended'));

    let pts = 0;
    const frameUs = Math.round(1e6 / fps);
    const emit = ({ config: cfg, frame, key }) => {
      if (cfg) this.emit('video', { config: true, key: false, pts: 0n, data: cfg });
      if (frame) {
        this.emit('video', { config: false, key, pts: BigInt(pts), data: frame });
        pts += frameUs;
      }
    };
    const splitter = codec === 'av1' ? new Av1Splitter(emit) : new H264Splitter((au) => emit(splitH264AccessUnit(au)));
    this.proc.stdout.on('data', (chunk) => {
      try {
        splitter.push(chunk);
      } catch (err) {
        log.error(err.message);
        this.close('demo-error');
      }
    });

    this.emit('device', this.name);
    this.emit('video-meta', { codec, width, height });
    this.emit('audio-disabled', { reason: 'demo' });
  }

  send(buf) {
    log.debug(`control message type ${buf[0]} (${buf.length} bytes)`);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.proc?.kill('SIGKILL');
    this.emit('close', reason);
  }
}
