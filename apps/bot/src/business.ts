import type { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import type { BotConfig } from './config.js';
import { logger } from './logger.js';
import { downloadFile, extractMedia } from './media.js';
import type { BotStore } from './store.js';
import { chatTitle, displayName, escapeHtml } from './util.js';

const log = logger('business');

/**
 * Telegram Business connection support — the "ghost mode" half of esgram.
 *
 * The owner connects the bot to their OWN account (Settings -> Telegram
 * Business -> Chatbots; requires Telegram Premium) and grants rights. Only then
 * does Telegram deliver the owner's private-chat messages, their edits and,
 * crucially, their deletions. Everything here acts for that one account, on its
 * own chats — the same model as running AyuGram as your client.
 *
 * What we do with it:
 *  - cache each incoming message so a later deletion can be reconstructed;
 *  - on an edit, log the before/after and tell the owner;
 *  - on a deletion, resend the cached content back to the owner;
 *  - optionally download media on arrival (catches view-once before it burns);
 *  - per-peer "mute": delete the peer's incoming messages as they arrive.
 *
 * We never call readBusinessMessage, so staying unread (ghost) is the default.
 */

interface Cached {
  text: string;
  peerName: string;
  media?: { kind: string; fileId: string; mime: string };
  caption: string;
}

export function registerBusiness(bot: Bot, cfg: BotConfig, store: BotStore): void {
  // connectionId:peerChatId:messageId -> cached content
  const cache = new Map<string, Cached>();
  const key = (conn: string, chatId: number, msgId: number): string => `${conn}:${chatId}:${msgId}`;

  function remember(conn: string, chatId: number, msgId: number, value: Cached): void {
    const k = key(conn, chatId, msgId);
    if (cache.has(k)) cache.delete(k);
    cache.set(k, value);
    if (cache.size > cfg.textCacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  async function notifyOwner(ownerChatId: number, html: string): Promise<void> {
    try {
      await bot.api.sendMessage(ownerChatId, html, { parse_mode: 'HTML' });
    } catch (err) {
      log.warn('owner notify failed', err);
    }
  }

  // Owner connected, re-granted rights, or disconnected the bot.
  bot.on('business_connection', (ctx) => {
    const c = ctx.businessConnection;
    const rights = c.rights ?? {};
    store.upsertBizConnection({
      id: c.id,
      userChatId: c.user_chat_id,
      ownerName: displayName(c.user),
      canReadMessages: rights.can_read_messages === true,
      canDelete: rights.can_delete_all_messages === true,
      isEnabled: c.is_enabled,
      at: Date.now(),
    });
    log.info(`business connection ${c.id} ${c.is_enabled ? 'enabled' : 'disabled'}`);
    void notifyOwner(
      c.user_chat_id,
      c.is_enabled
        ? '🔗 Подключено. Я буду сохранять удалённые и изменённые сообщения в твоих личных чатах. ' +
            'Отключить — там же, в Telegram Business → Чат-боты.'
        : '🔌 Отключено. Больше не слежу за твоими чатами.',
    );
  });

  // Incoming/outgoing message in one of the owner's private chats.
  bot.on('business_message', async (ctx) => {
    const m = ctx.businessMessage;
    const connId = ctx.businessConnectionId;
    if (!connId) return;
    const conn = store.getBizConnection(connId);
    const peerName = chatTitle(m.chat);
    const media = extractMedia(m);

    remember(connId, m.chat.id, m.message_id, {
      text: m.text ?? m.caption ?? '',
      peerName,
      ...(media ? { media } : {}),
      caption: m.caption ?? '',
    });

    // Ghost "mute": the peer's own messages get removed from the owner's chat.
    const fromOwner = conn && m.from && m.from.id === conn.userChatId;
    if (!fromOwner && conn?.canDelete && store.isBizMuted(connId, m.chat.id)) {
      try {
        await bot.api.deleteBusinessMessages(connId, [m.message_id]);
      } catch (err) {
        log.warn('business delete (mute) failed', err);
      }
      return;
    }

    // Grab media while the message still exists — this is what catches
    // view-once / self-destructing media that a plain bot never sees.
    if (media && !fromOwner && conn) {
      await archiveBusinessMedia(connId, m, media, conn.userChatId);
    }
  });

  bot.on('edited_business_message', async (ctx) => {
    const m = ctx.editedBusinessMessage;
    const connId = ctx.businessConnectionId;
    if (!connId) return;
    const conn = store.getBizConnection(connId);
    const after = m.text ?? m.caption ?? '';
    const k = key(connId, m.chat.id, m.message_id);
    const before = cache.get(k)?.text ?? '(версия до запуска не сохранена)';
    if (before === after) return;
    const peerName = chatTitle(m.chat);

    store.addBizCapture({
      connectionId: connId,
      kind: 'edited',
      peerChatId: m.chat.id,
      peerName,
      text: after,
      before,
      at: Date.now(),
    });
    remember(connId, m.chat.id, m.message_id, {
      text: after,
      peerName,
      caption: m.caption ?? '',
    });

    if (conn) {
      await notifyOwner(
        conn.userChatId,
        `✏️ <b>${escapeHtml(peerName)}</b> изменил сообщение:\n\n` +
          `<s>${escapeHtml(before)}</s>\n→\n${escapeHtml(after) || '<i>(пусто)</i>'}`,
      );
    }
  });

  // The headline feature: Telegram tells us which messages were deleted.
  bot.on('deleted_business_messages', async (ctx) => {
    const d = ctx.deletedBusinessMessages;
    const connId = ctx.businessConnectionId;
    if (!connId) return;
    const conn = store.getBizConnection(connId);
    const peerName = chatTitle(d.chat);

    for (const id of d.message_ids) {
      const cached = cache.get(key(connId, d.chat.id, id));
      const text = cached?.text ?? '';
      store.addBizCapture({
        connectionId: connId,
        kind: 'deleted',
        peerChatId: d.chat.id,
        peerName,
        text: text || (cached?.media ? `[${cached.media.kind}]` : '(содержимое не сохранено)'),
        at: Date.now(),
      });
      if (!conn) continue;
      const body = text
        ? `<s>…</s>\n${escapeHtml(text)}`
        : cached?.media
          ? `вложение (${cached.media.kind})`
          : '(содержимое не успел сохранить)';
      await notifyOwner(
        conn.userChatId,
        `🗑 <b>${escapeHtml(peerName)}</b> удалил сообщение:\n\n${body}`,
      );
    }
  });

  async function archiveBusinessMedia(
    connId: string,
    m: Message,
    media: { kind: string; fileId: string; mime: string },
    ownerChatId: number,
  ): Promise<void> {
    try {
      const file = await bot.api.getFile(media.fileId).catch(() => null);
      const path = file?.file_path;
      if (!path) return;
      const { id, file: stored } = await downloadFile(cfg.token, path, store.mediaDirectory);
      store.addMedia({
        id,
        chatId: m.chat.id,
        chatTitle: chatTitle(m.chat),
        fromId: m.from?.id ?? 0,
        fromName: displayName(m.from),
        kind: media.kind,
        file: stored,
        mime: media.mime,
        caption: m.caption ?? '',
        savedBy: ownerChatId,
        at: Date.now(),
      });
    } catch (err) {
      // view-once media may refuse getFile; that is expected, not fatal.
      log.debug('business media archive skipped', err);
    }
  }
}
