import type { PhotoCard } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

const log = logger('photos:unsplash');

const API = 'https://api.unsplash.com';

export class PhotoSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoSourceError';
  }
}

/**
 * Unsplash requires every link back to carry UTM parameters naming the app.
 * This is part of the API terms, not a nicety.
 */
function withUtm(url: string): string {
  const appName = loadConfig().unsplashAppName;
  const parsed = new URL(url);
  parsed.searchParams.set('utm_source', appName);
  parsed.searchParams.set('utm_medium', 'referral');
  return parsed.toString();
}

/** Shape of the fields we use from a photo object. */
interface RawPhoto {
  id: string;
  width: number;
  height: number;
  description: string | null;
  alt_description: string | null;
  urls: { raw: string; full: string; regular: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; username: string; links: { html: string } };
}

/** Everything the server keeps about a photo; only `card` goes to the client. */
export interface PhotoEntry {
  card: PhotoCard;
  /** Resolved server-side, so the client can never make us fetch a chosen URL. */
  sourceUrl: string;
  downloadLocation: string;
}

async function call(path: string, params: Record<string, string>): Promise<{
  body: unknown;
  rateRemaining?: number;
}> {
  const cfg = loadConfig();
  if (!cfg.unsplashAccessKey) {
    throw new PhotoSourceError(
      'UNSPLASH_ACCESS_KEY is not set. Create an app at unsplash.com/oauth/applications and copy its Access Key.',
    );
  }

  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '') url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Unsplash authenticates public reads with the access key directly.
        authorization: `Client-ID ${cfg.unsplashAccessKey}`,
        'accept-version': 'v1',
      },
    });

    const remainingHeader = response.headers.get('x-ratelimit-remaining');
    const rateRemaining = remainingHeader === null ? undefined : Number(remainingHeader);

    if (response.status === 401) {
      throw new PhotoSourceError('Unsplash rejected the access key.');
    }
    if (response.status === 403) {
      // Demo apps get 50 requests an hour, which one careless loop can spend.
      throw new PhotoSourceError(
        `Unsplash rate limit reached${
          rateRemaining !== undefined ? ` (${rateRemaining} left)` : ''
        }. Demo apps get 50 requests an hour.`,
      );
    }
    if (!response.ok) {
      throw new PhotoSourceError(`Unsplash returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    return { body: await response.json(), rateRemaining };
  } catch (err) {
    if (err instanceof PhotoSourceError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new PhotoSourceError('Unsplash did not respond in time.');
    }
    throw new PhotoSourceError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function toEntry(raw: RawPhoto): PhotoEntry {
  return {
    card: {
      id: raw.id,
      description: raw.description ?? raw.alt_description ?? undefined,
      photographer: raw.user.name,
      photographerUrl: withUtm(raw.user.links.html),
      photoUrl: withUtm(raw.links.html),
      imageUrl: raw.urls.small,
      width: raw.width,
      height: raw.height,
    },
    sourceUrl: raw.urls.regular,
    downloadLocation: raw.links.download_location,
  };
}

/**
 * Fetches a batch of photos in one request.
 *
 * Batching is the whole design: a demo key allows 50 requests an hour, so one
 * request per swipe would run dry after fifty swipes. Thirty photos per request
 * turns the same budget into 1500.
 */
export async function fetchBatch(
  query: string,
  count: number,
): Promise<{ entries: PhotoEntry[]; rateRemaining?: number }> {
  const { body, rateRemaining } = await call('/photos/random', {
    count: String(Math.min(30, Math.max(1, count))),
    query,
    // Landscape matches a 2:1 display far better than portrait.
    orientation: 'landscape',
    content_filter: 'high',
  });

  // The endpoint returns a bare object when count is omitted and an array when
  // it is present; tolerate both rather than depending on that.
  const list = (Array.isArray(body) ? body : [body]) as RawPhoto[];
  const entries = list.filter((raw) => raw?.id && raw.urls?.regular).map(toEntry);

  if (entries.length === 0) throw new PhotoSourceError('Unsplash returned no usable photos.');

  log.info(`fetched ${entries.length} photo(s)${query ? ` for "${query}"` : ''}`);
  return { entries, rateRemaining };
}

/**
 * Reports a use back to Unsplash.
 *
 * Required by the API terms whenever a photo is actually used — displaying one
 * on the glasses counts. Failure is logged and swallowed: it must never break
 * the feed the wearer is looking at.
 */
export async function trackDownload(downloadLocation: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.unsplashAccessKey || !downloadLocation) return;

  try {
    await fetch(downloadLocation, {
      headers: { authorization: `Client-ID ${cfg.unsplashAccessKey}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    log.warn('download tracking ping failed', err);
  }
}
