import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { Store } from './store/index.js';
import { registerRoutes } from './routes/index.js';
import { startScheduler } from './notifications/scheduler.js';
import { syncAllUsers } from './bookings/sync.js';
import { encryptionAvailable } from './util/crypto.js';

const log = logger('server');

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  // Neither of these is fatal, but both silently disable a feature, so say so
  // at boot rather than letting the wearer discover it mid-question.
  if (!encryptionAvailable()) {
    log.warn(
      'ENCRYPTION_KEY is not set — accounts cannot store their own Anthropic key. ' +
        'Generate one with: openssl rand -base64 32',
    );
  }
  if (!cfg.anthropicApiKey && !cfg.requireUserApiKey) {
    log.warn(
      'ANTHROPIC_API_KEY is not set — accounts must each add their own key before the assistant works.',
    );
  }

  const store = await Store.open(cfg.dataDir);

  const app = Fastify({
    logger: false,
    // Voice captures arrive as base64 PCM; 20s of 16 kHz mono is ~850 KB.
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });

  // The glasses app is served from the Even Hub WebView (an opaque origin in
  // production, localhost in the simulator), so the device API is open to any
  // origin and authenticated purely by bearer token.
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  registerRoutes(app, store);

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    log.error('unhandled route error', error);
    void reply.code(error.statusCode ?? 500).send({
      error: 'internal_error',
      message: error.message || 'Something went wrong.',
    });
  });

  const scheduler = startScheduler(store);

  let syncTimer: NodeJS.Timeout | null = null;
  if (cfg.gmailSyncIntervalMs > 0) {
    syncTimer = setInterval(() => {
      void syncAllUsers(store).catch((err) => log.error('scheduled sync failed', err));
    }, cfg.gmailSyncIntervalMs);
    syncTimer.unref?.();
    log.info(`gmail sync every ${Math.round(cfg.gmailSyncIntervalMs / 60_000)} min`);
  }

  await app.listen({ port: cfg.port, host: cfg.host });
  log.info(`listening on ${cfg.host}:${cfg.port} (public base ${cfg.publicBaseUrl})`);
  log.info(
    `assistant: ${cfg.assistantModel} (fast=${cfg.assistantEffort}, deep=${cfg.deepEffort}) | ` +
      `extraction: ${cfg.extractionModel} (${cfg.extractionEffort})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — shutting down`);
    if (syncTimer) clearInterval(syncTimer);
    scheduler.stop();
    await app.close();
    await store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
