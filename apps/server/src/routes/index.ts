import type { FastifyInstance } from 'fastify';
import type { Store } from '../store/index.js';
import { loadConfig } from '../config.js';
import { speechEnabled } from '../speech/index.js';
import { encryptionAvailable } from '../util/crypto.js';
import { registerApiRoutes, makeAuthenticator } from './api.js';
import { registerAuthRoutes } from './auth.js';
import { registerPhotoRoutes } from './photos.js';

export function registerRoutes(app: FastifyInstance, store: Store): void {
  const cfg = loadConfig();

  app.get('/health', async () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    assistantModel: cfg.assistantModel,
    extractionModel: cfg.extractionModel,
    voiceEnabled: speechEnabled(),
    photoFeedEnabled: cfg.unsplashAccessKey !== '',
    webModeAvailable: true,
    sharedKeyConfigured: cfg.anthropicApiKey !== '',
    userKeysStorable: encryptionAvailable(),
    pairedUsers: store.listUsers().length,
  }));

  registerAuthRoutes(app, store);
  registerApiRoutes(app, store);
  registerPhotoRoutes(app, store, makeAuthenticator(store));
}
