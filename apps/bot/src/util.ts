import type { Chat, User } from 'grammy/types';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function displayName(user: User | undefined): string {
  if (!user) return 'кто-то';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return user.username ? `${name || user.username} (@${user.username})` : name || String(user.id);
}

export function chatTitle(chat: Chat): string {
  if ('title' in chat && chat.title) return chat.title;
  if ('username' in chat && chat.username) return `@${chat.username}`;
  if ('first_name' in chat && chat.first_name) {
    return [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  }
  return String(chat.id);
}
