import type { PhotoCard, PhotoFrame } from '@g2/shared';
import { api } from './api';

/** Decoded frames kept in memory so swiping back does not re-download. */
const FRAME_CACHE_LIMIT = 12;

/** base64 -> bytes. The buffer is ~41 KB, so chunking keeps the loop cheap. */
function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface DecodedFrame {
  id: string;
  width: number;
  height: number;
  pixels: Uint8Array;
}

function decode(frame: PhotoFrame): DecodedFrame {
  return {
    id: frame.id,
    width: frame.width,
    height: frame.height,
    pixels: decodeBase64(frame.pixelsBase64),
  };
}

/**
 * Holds the feed and the decoded frames.
 *
 * Fetching a frame and pushing it to the glasses are deliberately separate: the
 * HTTP round trip is fast and safe to run ahead, while the BLE push is slow and
 * must never overlap another one. So the next photo is fetched while the
 * current one is on screen, and only pushed when the wearer swipes to it.
 */
export class PhotoLibrary {
  private cards: PhotoCard[] = [];
  private readonly frames = new Map<string, DecodedFrame>();
  private readonly inFlight = new Map<string, Promise<DecodedFrame>>();
  private attribution = { source: 'Unsplash', sourceUrl: 'https://unsplash.com' };

  get photos(): PhotoCard[] {
    return this.cards;
  }

  get source(): { source: string; sourceUrl: string } {
    return this.attribution;
  }

  get size(): number {
    return this.cards.length;
  }

  cardAt(index: number): PhotoCard | undefined {
    return this.cards[index];
  }

  /** Loads (or reloads) the feed. Frames from the previous batch are dropped. */
  async load(refresh = false): Promise<void> {
    const feed = await api.photoFeed(refresh);
    this.cards = feed.photos;
    this.attribution = feed.attribution;
    this.frames.clear();
    this.inFlight.clear();
  }

  /** Already-decoded pixels for a photo, if we have them. */
  cached(id: string): DecodedFrame | undefined {
    return this.frames.get(id);
  }

  /**
   * Fetches and decodes one frame, collapsing concurrent requests for the same
   * photo — a fast swipe can easily ask for the same one twice.
   */
  async frame(id: string): Promise<DecodedFrame> {
    const ready = this.frames.get(id);
    if (ready) return ready;

    const pending = this.inFlight.get(id);
    if (pending) return pending;

    const request = api
      .photoFrame(id)
      .then((frame) => {
        const decoded = decode(frame);
        this.remember(decoded);
        return decoded;
      })
      .finally(() => this.inFlight.delete(id));

    this.inFlight.set(id, request);
    return request;
  }

  /** Warms the neighbours of `index` without blocking or throwing. */
  prefetchAround(index: number): void {
    for (const neighbour of [index + 1, index - 1]) {
      const card = this.cards[neighbour];
      if (card && !this.frames.has(card.id)) {
        void this.frame(card.id).catch(() => undefined);
      }
    }
  }

  private remember(frame: DecodedFrame): void {
    if (this.frames.size >= FRAME_CACHE_LIMIT) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
    this.frames.set(frame.id, frame);
  }
}
