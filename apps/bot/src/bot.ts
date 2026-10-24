import { Bot, type Context, GrammyError } from 'grammy';
import type { Chat, Message, User } from 'grammy/types';
import type { BotConfig } from './config.js';
import { logger } from './logger.js';
import { downloadFile, extractMedia } from './media.js';
import { BotStore } from './store.js';

const log = logger('bot');

/** Permissions that silence a member. Everything that could post is off. */
const MUTED_PERMS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
} as const;

/** Restore the default "can talk" set. */
const UNMUTED_PERMS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
} as const;

type CommandKind =
  | 'mute'
  | 'unmute'
  | 'save'
  | 'enable'
  | 'disable'
  | 'status'
  | 'start'
  | 'help'
  | null;

function parseCommand(raw: string): CommandKind {
  const body = raw.trim();
  const lower = body.toLowerCase();
  // Slash command, possibly addressed as /mute@esgrambot.
  if (body.startsWith('/')) {
    const token = lower.slice(1).split(/[\s@]/, 1)[0] ?? '';
    if (['mute', 'unmute', 'save', 'enable', 'disable', 'status', 'start', 'help'].includes(token)) {
      return token as CommandKind;
    }
    return null;
  }
  // Bare keywords (require privacy mode OFF to reach the bot in groups).
  if (lower === 'мут') return 'mute';
  if (lower === 'анмут') return 'unmute';
  if (lower === 'сохрани' || lower === 'сохранить') return 'save';
  return null;
}

function displayName(user: User | undefined): string {
  if (!user) return 'кто-то';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return user.username ? `${name || user.username} (@${user.username})` : name || String(user.id);
}

function chatTitle(chat: Chat): string {
  if ('title' in chat && chat.title) return chat.title;
  if ('username' in chat && chat.username) return `@${chat.username}`;
  return String(chat.id);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** LRU-ish text cache so edits can show the previous version. */
class TextCache {
  private readonly map = new Map<string, string>();
  constructor(private readonly limit: number) {}
  private key(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }
  set(chatId: number, messageId: number, text: string): void {
    const k = this.key(chatId, messageId);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, text);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  get(chatId: number, messageId: number): string | undefined {
    return this.map.get(this.key(chatId, messageId));
  }
}

export function createBot(cfg: BotConfig, store: BotStore): Bot {
  const bot = new Bot(cfg.token);
  const cache = new TextCache(cfg.textCacheLimit);

  const isOwner = (userId: number | undefined): boolean =>
    userId !== undefined && cfg.ownerIds.has(userId);

  async function isAdmin(chatId: number, userId: number): Promise<boolean> {
    if (isOwner(userId)) return true;
    try {
      const member = await bot.api.getChatMember(chatId, userId);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  }

  async function safeDelete(chatId: number, messageId: number): Promise<void> {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch (err) {
      if (!(err instanceof GrammyError)) log.warn('deleteMessage failed', err);
    }
  }

  // Someone edited a message -> record it and repost the diff where enabled.
  bot.on('edited_message', async (ctx) => {
    const m = ctx.editedMessage;
    const chat = ctx.chat;
    const cfgChat = store.getChat(chat.id);
    if (!cfgChat?.enabled || !cfgChat.trackEdits) return;

    const after = m.text ?? m.caption ?? '';
    const before = cache.get(chat.id, m.message_id) ?? '(версия до запуска бота не сохранена)';
    if (before === after) return;

    const name = displayName(m.from);
    store.addEdit({
      chatId: chat.id,
      chatTitle: chatTitle(chat),
      messageId: m.message_id,
      userId: m.from?.id ?? 0,
      userName: name,
      before,
      after,
      at: Date.now(),
    });
    cache.set(chat.id, m.message_id, after);

    try {
      await ctx.api.sendMessage(
        chat.id,
        `✏️ <b>${escapeHtml(name)}</b> изменил сообщение:\n\n` +
          `<s>${escapeHtml(before)}</s>\n→\n${escapeHtml(after) || '<i>(пусто)</i>'}`,
        { parse_mode: 'HTML', reply_parameters: { message_id: m.message_id } },
      );
    } catch (err) {
      log.warn('edit repost failed', err);
    }
  });

  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    const chat = ctx.chat;
    const from = msg.from;
    const isPrivate = chat.type === 'private';

    // Register known group chats so the panel can toggle them.
    if (!isPrivate) {
      store.ensureChat(chat.id, chatTitle(chat), chat.type, from?.id ?? 0);
    }

    // Mute enforcement: a muted member's messages are removed on arrival.
    if (!isPrivate && from && store.getChat(chat.id)?.enabled && store.isMuted(chat.id, from.id)) {
      await safeDelete(chat.id, msg.message_id);
      return;
    }

    const text = msg.text ?? msg.caption ?? '';
    if (msg.text) cache.set(chat.id, msg.message_id, msg.text);

    // Auto-archive anything media sent straight to the bot in a DM.
    if (isPrivate) {
      const media = extractMedia(msg);
      if (media) {
        await saveMedia(ctx, msg, media, from?.id ?? 0);
        return;
      }
    }

    const cmd = parseCommand(text);
    if (!cmd) return;
    const reply = msg.reply_to_message;

    switch (cmd) {
      case 'start':
      case 'help':
        await ctx.reply(helpText(), { parse_mode: 'HTML' });
        return;

      case 'status': {
        if (isPrivate) {
          await ctx.reply(
            `Чатов под наблюдением: ${store.listChats().length}\n` +
              `Активных мутов: ${store.listMutes().length}\n` +
              `Сохранено медиа: ${store.listMedia(10_000).length}`,
          );
          return;
        }
        const c = store.getChat(chat.id);
        await ctx.reply(
          `Этот чат: ${c?.enabled ? 'включён' : 'выключен'}, ` +
            `трекинг правок ${c?.trackEdits ? 'вкл' : 'выкл'}.`,
        );
        return;
      }

      case 'enable':
      case 'disable': {
        if (isPrivate || !from) return;
        if (!(await isAdmin(chat.id, from.id))) {
          await ctx.reply('Только админ чата может это менять.');
          return;
        }
        store.setChatFlag(chat.id, 'enabled', cmd === 'enable');
        await ctx.reply(cmd === 'enable' ? 'Бот включён в этом чате.' : 'Бот выключен в этом чате.');
        return;
      }

      case 'mute':
      case 'unmute': {
        if (isPrivate || !from) {
          await ctx.reply('Мут работает только в группе, где бот — админ.');
          return;
        }
        if (!reply?.from) {
          await ctx.reply('Ответь этой командой на сообщение человека.');
          return;
        }
        if (!(await isAdmin(chat.id, from.id))) {
          await ctx.reply('Только админ чата может мутить.');
          return;
        }
        const target = reply.from;
        if (target.is_bot) {
          await ctx.reply('Ботов мутить нельзя.');
          return;
        }
        await handleMute(ctx, chat, target, from.id, cmd === 'mute');
        await safeDelete(chat.id, msg.message_id);
        return;
      }

      case 'save': {
        if (!reply) {
          await ctx.reply('Ответь словом «сохрани» на фото, видео, кружок или голосовое.');
          return;
        }
        const media = extractMedia(reply);
        if (!media) {
          await ctx.reply('В том сообщении нет медиа, которое я могу скачать.');
          return;
        }
        await saveMedia(ctx, reply, media, from?.id ?? 0);
        return;
      }
    }
  });

  async function handleMute(
    ctx: Context,
    chat: Chat,
    target: User,
    actorId: number,
    mute: boolean,
  ): Promise<void> {
    const name = displayName(target);
    try {
      await bot.api.restrictChatMember(chat.id, target.id, mute ? MUTED_PERMS : UNMUTED_PERMS);
    } catch (err) {
      await ctx.reply(
        'Не вышло — проверь, что бот админ с правами «ограничивать участников».',
      );
      log.warn('restrictChatMember failed', err);
      return;
    }
    if (mute) {
      store.addMute({
        chatId: chat.id,
        userId: target.id,
        userName: name,
        mutedBy: actorId,
        since: Date.now(),
      });
      await ctx.reply(`🔇 ${escapeHtml(name)} в муте: новые сообщения буду удалять.`, {
        parse_mode: 'HTML',
      });
    } else {
      store.removeMute(chat.id, target.id);
      await ctx.reply(`🔈 ${escapeHtml(name)} размучен.`, { parse_mode: 'HTML' });
    }
  }

  async function saveMedia(
    ctx: Context,
    source: Message,
    media: { kind: string; fileId: string; mime: string },
    savedBy: number,
  ): Promise<void> {
    try {
      const file = await ctx.api.getFile(media.fileId);
      if (!file.file_path) throw new Error('no file_path');
      const { id, file: stored } = await downloadFile(cfg.token, file.file_path, store.mediaDirectory);
      store.addMedia({
        id,
        chatId: ctx.chat?.id ?? 0,
        chatTitle: ctx.chat ? chatTitle(ctx.chat) : '',
        fromId: source.from?.id ?? 0,
        fromName: displayName(source.from),
        kind: media.kind,
        file: stored,
        mime: media.mime,
        caption: source.caption ?? '',
        savedBy,
        at: Date.now(),
      });
      await ctx.reply(`💾 Сохранил ${media.kind}.`);
    } catch (err) {
      log.warn('saveMedia failed', err);
      await ctx.reply('Не смог сохранить — Telegram не отдаёт этот файл (одноразовое медиа ботам недоступно).');
    }
  }

  bot.catch((err) => log.error('bot error', err.error));
  return bot;
}

function helpText(): string {
  return (
    '<b>esgram</b> — помощник для чатов.\n\n' +
    'Добавь меня в группу и сделай админом (права: удалять сообщения, ограничивать участников).\n\n' +
    '<b>Правки.</b> Когда кто-то редактирует сообщение, я показываю «было → стало».\n' +
    '<b>Архив.</b> Ответь на фото/видео/кружок словом «сохрани», или пришли медиа мне в личку — я его сохраню.\n' +
    '<b>Мут.</b> Ответь на сообщение человека словом «Мут» (или /mute) — я заберу право писать и буду удалять его сообщения. «Анмут» — вернуть.\n\n' +
    'Команды: /status, /enable, /disable.\n\n' +
    '<i>Я вижу только те чаты, куда меня добавили. Удалённые сообщения и одноразовые медиа Telegram ботам не отдаёт.</i>'
  );
}
