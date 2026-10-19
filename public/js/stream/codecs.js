// WebCodecs codec strings derived from the stream's own parameter sets.

const PROBES = { h264: 'avc1.42E01F', h265: 'hvc1.1.6.L93.B0', av1: 'av01.0.04M.08' };

/** Video codecs this browser can decode, best first. */
export async function supportedVideoCodecs() {
  if (typeof VideoDecoder === 'undefined') return [];
  const out = [];
  for (const [name, codec] of Object.entries(PROBES)) {
    try {
      if ((await VideoDecoder.isConfigSupported({ codec })).supported) out.push(name);
    } catch {
      /* unsupported */
    }
  }
  return out;
}

export async function opusSupported() {
  if (typeof AudioDecoder === 'undefined') return false;
  try {
    return (await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 })).supported;
  } catch {
    return false;
  }
}

const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();

/** Annex-B NAL units (without start codes). */
export function* nalUnits(data) {
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (data[end - 1] === 0) end--;
        yield data.subarray(start, end);
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

function unescapeRbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function h264Codec(config) {
  for (const nal of nalUnits(config)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
  }
  return 'avc1.42E01F';
}

function h265Codec(config) {
  for (const nal of nalUnits(config)) {
    if (((nal[0] >> 1) & 0x3f) !== 33) continue;
    const r = unescapeRbsp(nal.subarray(2));
    if (r.length < 13) break;
    const space = ['', 'A', 'B', 'C'][r[1] >> 6];
    const tier = (r[1] >> 5) & 1 ? 'H' : 'L';
    const profile = r[1] & 0x1f;
    let compat = ((r[2] << 24) | (r[3] << 16) | (r[4] << 8) | r[5]) >>> 0;
    let reversed = 0;
    for (let i = 0; i < 32; i++) {
      reversed = (reversed << 1) | (compat & 1);
      compat >>>= 1;
    }
    const constraints = Array.from(r.subarray(6, 12));
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    const tail = constraints.length ? `.${constraints.map(hex).join('.')}` : '';
    return `hvc1.${space}${profile}.${(reversed >>> 0).toString(16).toUpperCase()}.${tier}${r[12]}${tail}`;
  }
  return 'hvc1.1.6.L93.B0';
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

/** AV1 OBUs in a buffer: { type, start, end, payloadStart }. */
export function av1Obus(data) {
  const out = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data[offset];
    const type = (header >> 3) & 0xf;
    const ext = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    let p = offset + 1 + ext;
    let size = data.length - p;
    if (hasSize) {
      size = 0;
      for (let i = 0; i < 8; i++) {
        const b = data[p++];
        size += (b & 0x7f) * 2 ** (7 * i);
        if (!(b & 0x80)) break;
      }
    }
    out.push({ type, start: offset, payloadStart: p, end: p + size });
    offset = p + size;
  }
  return out;
}

/** Strip an AV1CodecConfigurationRecord (av1C) header if present. */
export function av1ConfigObus(config) {
  return config[0] === 0x81 && config.length > 4 ? config.subarray(4) : config;
}

function av1Codec(config) {
  const obus = av1ConfigObus(config);
  const seq = av1Obus(obus).find((o) => o.type === 1);
  if (!seq) return 'av01.0.08M.08';
  const r = new BitReader(obus.subarray(seq.payloadStart, seq.end));
  const profile = r.read(3);
  r.read(1); // still_picture
  const reduced = r.read(1);
  let level = 8;
  let tier = 0;
  if (reduced) {
    level = r.read(5);
  } else {
    if (r.read(1)) return `av01.${profile}.08M.08`; // timing info present: keep it simple
    r.read(1); // initial_display_delay_present_flag
    r.read(5); // operating_points_cnt_minus_1
    r.read(12); // operating_point_idc[0]
    level = r.read(5);
    if (level > 7) tier = r.read(1);
  }
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.08`;
}

export function codecString(name, config) {
  if (name === 'h264') return h264Codec(config);
  if (name === 'h265') return h265Codec(config);
  if (name === 'av1') return av1Codec(config);
  throw new Error(`Unsupported codec ${name}`);
}

/** Prepend parameter sets to a keyframe so the decoder can start from it. */
export function withConfig(name, config, frame) {
  if (name === 'av1') {
    const obus = av1ConfigObus(config);
    // A temporal delimiter must stay first in the temporal unit.
    const first = av1Obus(frame)[0];
    const split = first && first.type === 2 ? first.end : 0;
    const out = new Uint8Array(frame.length + obus.length);
    out.set(frame.subarray(0, split), 0);
    out.set(obus, split);
    out.set(frame.subarray(split), split + obus.length);
    return out;
  }
  const out = new Uint8Array(config.length + frame.length);
  out.set(config, 0);
  out.set(frame, config.length);
  return out;
}
