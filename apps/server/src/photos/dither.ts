/**
 * Greyscale -> 16 levels, for the G2's 4-bit display.
 *
 * A naive quantisation of a photograph to 16 levels bands badly: skies turn
 * into stripes. Floyd-Steinberg pushes each pixel's rounding error into its
 * not-yet-drawn neighbours, trading banding for fine noise, which reads far
 * better at this depth.
 */

/** Distance between adjacent output levels: 255 / 15. */
const LEVEL_STEP = 17;

export interface DitherOptions {
  /** Skip error diffusion — right for line art, icons and QR codes. */
  flat?: boolean;
}

/**
 * Takes 8-bit greyscale, one byte per pixel, and returns one byte per pixel
 * holding a level index 0-15.
 */
export function ditherTo16(
  gray: Uint8Array,
  width: number,
  height: number,
  options: DitherOptions = {},
): Uint8Array {
  if (gray.length !== width * height) {
    throw new Error(`expected ${width * height} greyscale bytes, got ${gray.length}`);
  }

  const out = new Uint8Array(width * height);

  if (options.flat) {
    for (let i = 0; i < gray.length; i++) {
      out[i] = Math.round(gray[i]! / LEVEL_STEP);
    }
    return out;
  }

  // Float working copy: diffused error must be allowed to run out of range.
  const buffer = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) buffer[i] = gray[i]!;

  const spread = (index: number, error: number, weight: number): void => {
    buffer[index] = buffer[index]! + (error * weight) / 16;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buffer[i]!;

      const level = Math.min(15, Math.max(0, Math.round(old / LEVEL_STEP)));
      out[i] = level;

      const error = old - level * LEVEL_STEP;
      const lastColumn = x + 1 >= width;
      const lastRow = y + 1 >= height;

      if (!lastColumn) spread(i + 1, error, 7);
      if (!lastRow) {
        if (x > 0) spread(i + width - 1, error, 3);
        spread(i + width, error, 5);
        if (!lastColumn) spread(i + width + 1, error, 1);
      }
    }
  }

  return out;
}

/**
 * Packs two 0-15 pixels into each byte, high nibble first.
 *
 * Only needed if the firmware wants packed nibbles rather than one byte per
 * pixel. An odd-width row pads with a zero low nibble — the only sane choice
 * without a documented stride rule.
 */
export function packNibbles(levels: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 2);
  const out = new Uint8Array(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x += 2) {
      const high = levels[y * width + x]! & 0x0f;
      const low = x + 1 < width ? levels[y * width + x + 1]! & 0x0f : 0;
      out[y * bytesPerRow + x / 2] = (high << 4) | low;
    }
  }

  return out;
}

/**
 * Boosts contrast before quantisation.
 *
 * Black is simply off on this display — it shows the real world through the
 * lens — so a photo with a dark background nearly vanishes. Stretching to the
 * full range first buys most of that back.
 */
export function stretchContrast(gray: Uint8Array, clipPercent = 1): Uint8Array {
  if (gray.length === 0) return gray;

  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value]!++;

  const clip = Math.floor((gray.length * clipPercent) / 100);

  let low = 0;
  for (let seen = 0; low < 255; low++) {
    seen += histogram[low]!;
    if (seen > clip) break;
  }

  let high = 255;
  for (let seen = 0; high > low; high--) {
    seen += histogram[high]!;
    if (seen > clip) break;
  }

  const span = high - low;
  if (span < 8) return gray; // Almost flat already; stretching would amplify noise.

  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = Math.min(255, Math.max(0, Math.round(((gray[i]! - low) * 255) / span)));
  }
  return out;
}
