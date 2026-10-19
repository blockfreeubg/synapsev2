import { test } from 'node:test';
import assert from 'node:assert/strict';
import { H264Splitter, splitH264AccessUnit, Av1Splitter } from '../server/demo.js';
import { codecString, withConfig, nalUnits } from '../public/js/stream/codecs.js';

const sc = [0, 0, 0, 1];
const AUD = [...sc, 0x09, 0xf0];
const SPS = [...sc, 0x67, 0x42, 0xc0, 0x1f, 0xaa];
const PPS = [...sc, 0x68, 0xce, 0x3c, 0x80];
const IDR = [...sc, 0x65, 0x88, 0x84];
const P = [...sc, 0x41, 0x9a, 0x02];

test('H264Splitter emits complete access units split on AUDs', () => {
  const units = [];
  const splitter = new H264Splitter((au) => units.push([...au]));
  const stream = Buffer.from([...AUD, ...SPS, ...PPS, ...IDR, ...AUD, ...P, ...AUD]);
  for (let i = 0; i < stream.length; i += 3) splitter.push(stream.subarray(i, i + 3));
  assert.equal(units.length, 2);
  assert.deepEqual(units[1], [...AUD, ...P]);
});

test('splitH264AccessUnit separates parameter sets from the frame', () => {
  const { config, frame, key } = splitH264AccessUnit(Buffer.from([...AUD, ...SPS, ...PPS, ...IDR]));
  assert.deepEqual([...config], [...SPS, ...PPS]);
  assert.deepEqual([...frame], IDR);
  assert.equal(key, true);
  assert.equal(splitH264AccessUnit(Buffer.from([...AUD, ...P])).key, false);
});

test('codecString derives avc1 from the SPS', () => {
  assert.equal(codecString('h264', Uint8Array.from([...SPS, ...PPS])), 'avc1.42C01F');
  assert.equal([...nalUnits(Uint8Array.from([...SPS, ...PPS]))].length, 2);
});

test('codecString derives hvc1 from an HEVC SPS', () => {
  // NAL header (type 33), then: vps id/sub-layers byte, profile byte (Main),
  // compatibility flags 0x60000000, constraint flags 0x90 00.., level 93.
  const sps = [...sc, 0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d];
  assert.equal(codecString('h265', Uint8Array.from(sps)), 'hvc1.1.6.L93.90');
});

function obu(type, payload) {
  return [(type << 3) | 0x02, payload.length, ...payload];
}

test('Av1Splitter groups OBUs into temporal units and detects keyframes', () => {
  const units = [];
  const splitter = new Av1Splitter((u) => units.push(u));
  // seq header: profile 0, not still, not reduced, no timing info, 0 extra
  // operating points, idc 0, level 8 -> bits 000 0 0 0 0 00000 000000000000 01000
  const seq = obu(1, [0x00, 0x00, 0x00, 0x40]);
  const keyFrame = obu(6, [0x10, 0xaa]); // show_existing=0, frame_type=0 (KEY)
  const interFrame = obu(6, [0x30, 0xbb]); // frame_type=1 (INTER)
  const td = obu(2, []);
  splitter.push(Buffer.from([...td, ...seq, ...keyFrame, ...td, ...interFrame, ...td]));
  assert.equal(units.length, 2);
  assert.ok(units[0].config);
  assert.equal(units[0].key, true);
  assert.equal(units[1].key, false);
  assert.equal(codecString('av1', units[0].config), 'av01.0.08M.08');

  // The sequence header goes after the temporal delimiter.
  const merged = withConfig('av1', units[0].config, units[0].frame);
  assert.deepEqual([...merged.subarray(0, 2)], td);
  assert.deepEqual([...merged.subarray(2, 2 + seq.length)], seq);
});
