import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PhotoFeedResponse, PhotoFrame } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { fetchBatch, PhotoSourceError, trackDownload, type PhotoEntry } from '../photos/unsplash.js';
import { renderFrame, RenderError } from '../photos/render.js';
import type { Store, UserRecord } from '../store/index.js';

const log = logger('routes:photos');

/** How long a fetched batch stays usable before we spend another request. */
const FEED_TTL_MS = 30 * 60_000;
/** Rendered frames kept in memory, across all users. */
const FRAME_CACHE_LIMIT = 120;

interface CachedFeed {
  entries: PhotoEntry[];
  fetchedAt: number;
  query: string;
  rateRemaining?: number;
}

/**
 * Per-user feed cache.
 *
 * It also closes an injection hole: the client only ever names a photo id, and
 * ids are resolved to URLs from here. A client that could hand us a URL to
 * fetch would turn the server into an open proxy into its own network.
 */
const feeds = new Map<string, CachedFeed>();

/** Rendering costs a download plus a dither pass, so completed frames are kept. */
const frames = new Map<string, PhotoFrame>();
/** Unsplash wants one use ping per photo, not one per swipe back and forth. */
const tracked = new Set<string>();

function rememberFrame(key: string, frame: PhotoFrame): void {
  if (frames.size >= FRAME_CACHE_LIMIT) {
    // Insertion-ordered, so the first key is the oldest.
    const oldest = frames.keys().next().value;
    if (oldest !== undefined) frames.delete(oldest);
  }
  frames.set(key, frame);
}

async function ensureFeed(user: UserRecord, query: string, refresh: boolean): Promise<CachedFeed> {
  const cfg = loadConfig();
  const existing = feeds.get(user.id);

  const usable =
    existing &&
    !refresh &&
    existing.query === query &&
    Date.now() - existing.fetchedAt < FEED_TTL_MS &&
    existing.entries.length > 0;

  if (usable) return existing;

  const { entries, rateRemaining } = await fetchBatch(query, cfg.photoBatchSize);
  const fresh: CachedFeed = { entries, fetchedAt: Date.now(), query, rateRemaining };
  feeds.set(user.id, fresh);
  return fresh;
}

type Authenticate = (
  request: FastifyRequest,
  reply: FastifyReply,
) => { user: UserRecord } | null;

export function registerPhotoRoutes(
  app: FastifyInstance,
  _store: Store,
  authenticate: Authenticate,
): void {
  const cfg = loadConfig();

  app.get<{ Querystring: { query?: string; refresh?: string } }>(
    '/api/photos/feed',
    async (request, reply) => {
      const session = authenticate(request, reply);
      if (!session) return;

      if (!cfg.unsplashAccessKey) {
        return reply.code(503).send({
          error: 'photos_unavailable',
          message: 'The photo feed needs UNSPLASH_ACCESS_KEY on the server.',
        });
      }

      const query = (request.query.query ?? cfg.photoQuery).trim();

      try {
        const feed = await ensureFeed(session.user, query, request.query.refresh === 'true');
        const response: PhotoFeedResponse = {
          photos: feed.entries.map((e) => e.card),
          attribution: { source: 'Unsplash', sourceUrl: `https://unsplash.com/?utm_source=${cfg.unsplashAppName}&utm_medium=referral` },
          rateRemaining: feed.rateRemaining,
        };
        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`feed failed: ${message}`);
        return reply
          .code(err instanceof PhotoSourceError ? 502 : 500)
          .send({ error: 'photo_source_failed', message });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { w?: string; h?: string } }>(
    '/api/photos/frame/:id',
    async (request, reply) => {
      const session = authenticate(request, reply);
      if (!session) return;

      const feed = feeds.get(session.user.id);
      const entry = feed?.entries.find((e) => e.card.id === request.params.id);

      if (!entry) {
        // Either the feed expired or the id was never in it. Either way the
        // client should ask for the feed again rather than retrying this.
        return reply.code(404).send({
          error: 'photo_not_in_feed',
          message: 'That photo is not in your current feed. Reload the feed first.',
        });
      }

      const width = Number(request.query.w ?? cfg.photoWidth);
      const height = Number(request.query.h ?? cfg.photoHeight);
      const cacheKey = `${entry.card.id}:${width}x${height}:${cfg.photoPixelFormat}`;

      const cached = frames.get(cacheKey);
      if (cached) return cached;

      try {
        const frame = await renderFrame(entry.card.id, entry.sourceUrl, { width, height });
        rememberFrame(cacheKey, frame);

        // Required by the Unsplash API terms: report the photo as used. Fired
        // once per photo, and never awaited — the wearer is waiting on pixels.
        if (!tracked.has(entry.card.id)) {
          tracked.add(entry.card.id);
          void trackDownload(entry.downloadLocation);
        }

        return frame;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`render failed for ${entry.card.id}: ${message}`);
        return reply
          .code(err instanceof RenderError ? 502 : 500)
          .send({ error: 'render_failed', message });
      }
    },
  );
}
