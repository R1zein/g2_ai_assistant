import type { Bot } from 'grammy';
import type { Chat, User } from 'grammy/types';
import { logger } from './logger.js';
import type { BotStore } from './store.js';
import { escapeHtml } from './util.js';

const log = logger('moderation');

/**
 * Iris-style group tools: the bot, as an admin, hands out admin rights, sets
 * titles, runs a warn system with an auto-action, greets newcomers and keeps a
 * simple reputation score. Every action here is admin-gated by the caller in
 * bot.ts; these helpers just do the work and report back.
 */

/** A sensible "trusted member" admin set — not owner-level, no anonymity. */
const ADMIN_RIGHTS = {
  can_manage_chat: true,
  can_delete_messages: true,
  can_restrict_members: true,
  can_pin_messages: true,
  can_invite_users: true,
  can_manage_video_chats: true,
  can_promote_members: false,
  can_change_info: false,
  is_anonymous: false,
} as const;

const NO_RIGHTS = {
  can_manage_chat: false,
  can_delete_messages: false,
  can_restrict_members: false,
  can_pin_messages: false,
  can_invite_users: false,
  can_manage_video_chats: false,
  can_promote_members: false,
  can_change_info: false,
  is_anonymous: false,
} as const;

const MUTE_PERMS = { can_send_messages: false } as const;

export async function promote(
  bot: Bot,
  chatId: number,
  target: User,
  title: string,
): Promise<string> {
  try {
    await bot.api.promoteChatMember(chatId, target.id, ADMIN_RIGHTS);
    if (title) {
      // Custom titles are capped at 16 chars by Telegram.
      await bot.api
        .setChatAdministratorCustomTitle(chatId, target.id, title.slice(0, 16))
        .catch(() => undefined);
    }
    return `⭐ ${escapeHtml(name(target))} теперь админ${title ? ` — «${escapeHtml(title.slice(0, 16))}»` : ''}.`;
  } catch (err) {
    log.warn('promote failed', err);
    return 'Не вышло. Бот должен быть админом с правом «назначать администраторов».';
  }
}

export async function demote(bot: Bot, chatId: number, target: User): Promise<string> {
  try {
    await bot.api.promoteChatMember(chatId, target.id, NO_RIGHTS);
    return `➖ ${escapeHtml(name(target))} больше не админ.`;
  } catch (err) {
    log.warn('demote failed', err);
    return 'Не вышло — снять можно только тех, кого назначил сам бот.';
  }
}

export async function setTitle(
  bot: Bot,
  chatId: number,
  target: User,
  title: string,
): Promise<string> {
  try {
    await bot.api.setChatAdministratorCustomTitle(chatId, target.id, title.slice(0, 16));
    return `🏷 Титул ${escapeHtml(name(target))}: «${escapeHtml(title.slice(0, 16))}».`;
  } catch (err) {
    log.warn('setTitle failed', err);
    return 'Не вышло — титул можно задать только админу, которого назначил бот.';
  }
}

/** Add a warn; when the limit is reached, mute the user and reset the count. */
export async function warn(
  bot: Bot,
  store: BotStore,
  chatId: number,
  target: User,
  reason: string,
): Promise<string> {
  const limit = store.getChat(chatId)?.warnLimit ?? 3;
  const rec = store.addWarn(chatId, target.id, name(target), reason);
  if (rec.count >= limit) {
    try {
      await bot.api.restrictChatMember(chatId, target.id, MUTE_PERMS);
    } catch (err) {
      log.warn('warn auto-mute failed', err);
    }
    store.clearWarns(chatId, target.id);
    return `⚠️ ${escapeHtml(name(target))} — ${limit}/${limit} варнов, выдан мут. Счётчик сброшен.`;
  }
  const reasonText = reason ? ` (${escapeHtml(reason)})` : '';
  return `⚠️ ${escapeHtml(name(target))}: ${rec.count}/${limit} варнов${reasonText}.`;
}

export function unwarn(store: BotStore, chatId: number, target: User): string {
  return store.clearWarns(chatId, target.id)
    ? `✅ Варны ${escapeHtml(name(target))} сняты.`
    : `У ${escapeHtml(name(target))} нет варнов.`;
}

export function rep(
  store: BotStore,
  chatId: number,
  target: User,
  delta: number,
): string {
  const rec = store.addRep(chatId, target.id, name(target), delta);
  const sign = delta > 0 ? '👍' : '👎';
  return `${sign} Репутация ${escapeHtml(name(target))}: ${rec.score}.`;
}

export function repTop(store: BotStore, chatId: number): string {
  const top = store.topReps(chatId, 10);
  if (top.length === 0) return 'Репутации пока ни у кого нет.';
  return (
    '<b>Топ по репутации:</b>\n' +
    top.map((r, i) => `${i + 1}. ${escapeHtml(r.userName)} — ${r.score}`).join('\n')
  );
}

/** Fill {name}/{title}/{username} placeholders in a welcome template. */
export function renderWelcome(template: string, user: User, chat: Chat): string {
  const uname = user.username ? `@${user.username}` : name(user);
  const title = 'title' in chat && chat.title ? chat.title : '';
  return escapeHtml(template)
    .replaceAll('{name}', `<b>${escapeHtml(name(user))}</b>`)
    .replaceAll('{username}', escapeHtml(uname))
    .replaceAll('{title}', escapeHtml(title));
}

function name(user: User): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || String(user.id);
}
