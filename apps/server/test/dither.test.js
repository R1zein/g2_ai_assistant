import test from 'node:test';
import assert from 'node:assert/strict';
import { ditherTo16, packNibbles, stretchContrast } from '../dist/photos/dither.js';

function uniform(value, width, height) {
  return new Uint8Array(width * height).fill(value);
}

function mean(levels) {
  let sum = 0;
  for (const v of levels) sum += v;
  return sum / levels.length;
}

test('every output pixel is a valid 4-bit level', () => {
  const gray = new Uint8Array(64 * 32);
  for (let i = 0; i < gray.length; i++) gray[i] = (i * 7) % 256;

  const levels = ditherTo16(gray, 64, 32);
  assert.equal(levels.length, 64 * 32);
  for (const v of levels) {
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 15, `level out of range: ${v}`);
  }
});

test('dithering preserves average brightness', () => {
  // This is the property that makes it worth doing: the error is moved around,
  // not discarded, so a flat field keeps its perceived tone.
  const levels = ditherTo16(uniform(128, 64, 64), 64, 64);
  assert.ok(Math.abs(mean(levels) * 17 - 128) < 3, `mean drifted to ${mean(levels) * 17}`);
});

test('a flat mid-tone becomes a mix of levels, not a single band', () => {
  // 128/17 = 7.53, so neither 7 nor 8 alone is right; a naive round would pick
  // one and lose half a level of brightness across the whole image.
  const levels = ditherTo16(uniform(128, 32, 32), 32, 32);
  assert.ok(new Set(levels).size > 1, 'error diffusion produced a single flat level');
});

test('flat mode rounds to the nearest level with no diffusion', () => {
  const levels = ditherTo16(uniform(255, 8, 8), 8, 8, { flat: true });
  assert.ok(levels.every((v) => v === 15));

  const black = ditherTo16(uniform(0, 8, 8), 8, 8, { flat: true });
  assert.ok(black.every((v) => v === 0));
});

test('pure black and pure white survive unchanged', () => {
  assert.ok(ditherTo16(uniform(0, 16, 16), 16, 16).every((v) => v === 0));
  assert.ok(ditherTo16(uniform(255, 16, 16), 16, 16).every((v) => v === 15));
});

test('a wrong-sized buffer is rejected rather than silently mis-read', () => {
  assert.throws(() => ditherTo16(new Uint8Array(10), 4, 4), /expected 16 greyscale bytes/);
});

test('packNibbles puts the first pixel in the high nibble', () => {
  const levels = Uint8Array.from([0x0a, 0x0b, 0x0c, 0x0d]);
  const packed = packNibbles(levels, 4, 1);
  assert.equal(packed.length, 2);
  assert.equal(packed[0], 0xab);
  assert.equal(packed[1], 0xcd);
});

test('packNibbles pads an odd row rather than bleeding into the next', () => {
  const packed = packNibbles(Uint8Array.from([0x0f, 0x01, 0x0f]), 3, 1);
  assert.equal(packed.length, 2);
  assert.equal(packed[0], 0xf1);
  assert.equal(packed[1], 0xf0);
});

test('stretchContrast opens up a low-contrast image', () => {
  // A photo living between 100 and 140 would use three of sixteen levels.
  const gray = new Uint8Array(1000);
  for (let i = 0; i < gray.length; i++) gray[i] = 100 + (i % 41);

  const stretched = stretchContrast(gray);
  assert.ok(Math.min(...stretched) < 20);
  assert.ok(Math.max(...stretched) > 235);
});

test('stretchContrast leaves an almost-flat image alone', () => {
  // Stretching two adjacent values to full range would amplify sensor noise
  // into a strobing mess.
  const gray = uniform(120, 20, 20);
  assert.deepEqual(stretchContrast(gray), gray);
});
