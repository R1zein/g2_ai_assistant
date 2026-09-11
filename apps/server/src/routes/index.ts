import type { FastifyInstance } from 'fastify';
import type { Store } from '../store/index.js';
import { loadConfig } from '../config.js';
import { speechEnabled } from '../speech/index.js';
import { registerApiRoutes } from './api.js';
import { registerAuthRoutes } from './auth.js';

export function registerRoutes(app: FastifyInstance, store: Store): void {
  const cfg = loadConfig();

  app.get('/health', async () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    assistantModel: cfg.assistantModel,
    extractionModel: cfg.extractionModel,
    voiceEnabled: speechEnabled(),
    pairedUsers: store.listUsers().length,
  }));

  registerAuthRoutes(app, store);
  registerApiRoutes(app, store);
}
