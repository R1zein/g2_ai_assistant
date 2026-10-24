import type { FastifyInstance } from 'fastify';
import { loadBotConfig } from './config.js';
import { createBot } from './bot.js';
import { logger, setLogLevel } from './logger.js';
import { BotStore } from './store.js';
import { startWeb } from './web.js';

const log = logger('main');

async function main(): Promise<void> {
  const cfg = loadBotConfig();
  setLogLevel(cfg.logLevel);

  const store = await BotStore.open(cfg.dataDir, cfg.editLogLimit);
  const bot = createBot(cfg, store);

  let web: FastifyInstance | null = null;
  if (cfg.webEnabled) {
    web = await startWeb(cfg, store);
  } else {
    log.warn('BOT_WEB_TOKEN is empty — web panel disabled.');
  }

  if (cfg.ownerIds.size === 0) {
    log.warn('BOT_OWNER_IDS is empty — only group admins can run commands in their groups.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — shutting down`);
    await bot.stop();
    if (web) await web.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('starting long polling…');
  // start() resolves only when the bot stops; let it run in the background.
  void bot.start({
    onStart: (me) => log.info(`@${me.username} is live`),
    allowed_updates: [
      'message',
      'edited_message',
      'my_chat_member',
      'business_connection',
      'business_message',
      'edited_business_message',
      'deleted_business_messages',
    ],
  });
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
