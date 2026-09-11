import sharp from 'sharp';
import type { PhotoFrame, PixelFormat } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { ditherTo16, packNibbles, stretchContrast } from './dither.js';

const log = logger('photos:render');

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Image containers accept 20-288 wide and 20-144 tall; nothing outside that. */
export function clampToContainer(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.min(288, Math.max(20, Math.round(width))),
    height: Math.min(144, Math.max(20, Math.round(height))),
  };
}

async function download(url: string, timeoutMs = 15_000): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new RenderError(`image host returned ${response.status}`);

  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    throw new RenderError(`expected an image, got ${type || 'no content-type'}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export interface RenderOptions {
  width?: number;
  height?: number;
  format?: PixelFormat;
  /** Skip error diffusion — for line art rather than photographs. */
  flat?: boolean;
}

/**
 * Turns a photo URL into pixels the glasses can take.
 *
 * The whole pipeline lives here: download, crop to the container's aspect,
 * greyscale, stretch the contrast, diffuse the quantisation error, and encode.
 * Everything downstream of this is transport.
 */
export async function renderFrame(
  id: string,
  sourceUrl: string,
  options: RenderOptions = {},
): Promise<PhotoFrame> {
  const cfg = loadConfig();
  const { width, height } = clampToContainer(
    options.width ?? cfg.photoWidth,
    options.height ?? cfg.photoHeight,
  );
  const format = options.format ?? cfg.photoPixelFormat;

  const started = Date.now();
  const original = await download(sourceUrl);

  // Type inferred rather than annotated: sharp exports its types through an
  // `export =` namespace that a default import cannot name.
  let raw;
  try {
    raw = await sharp(original)
      // `cover` fills the container and crops the overflow, which suits a feed
      // better than letterboxing into a frame that is mostly unlit pixels.
      .resize(width, height, { fit: 'cover', position: 'attention' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new RenderError(`could not decode the image: ${err instanceof Error ? err.message : err}`);
  }

  if (raw.info.channels !== 1) {
    throw new RenderError(`expected single-channel output, got ${raw.info.channels}`);
  }

  const stretched = stretchContrast(new Uint8Array(raw.data));
  const levels = ditherTo16(stretched, width, height, { flat: options.flat });
  const pixels = format === 'nibble' ? packNibbles(levels, width, height) : levels;

  log.debug(
    `rendered ${id} to ${width}x${height} ${format} (${pixels.length} bytes) in ${Date.now() - started}ms`,
  );

  return {
    id,
    width,
    height,
    format,
    pixelsBase64: Buffer.from(pixels).toString('base64'),
  };
}
