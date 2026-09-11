import { formatInZone, relativeTime } from '../../util/time.js';
import { sha256 } from '../../util/id.js';
import { type AssistantTool, toolSpec } from './types.js';

const scheduleReminder: AssistantTool = {
  spec: toolSpec(
    'schedule_reminder',
    'Push a notification to the glasses at a future moment. Use this for "remind me to …" — ' +
      'it does not put anything on the calendar, it just surfaces a card on the HUD.',
    {
      at_iso: { type: 'string', description: 'When to fire, ISO-8601 with an offset.' },
      title: { type: 'string', description: 'Short headline, under 40 characters.' },
      body: { type: 'string', description: 'One or two sentences of detail.' },
    },
    ['at_iso', 'title', 'body'],
  ),
  async handler(input, ctx) {
    const at = new Date(String(input.at_iso ?? ''));
    if (Number.isNaN(at.getTime())) {
      return {
        summary: 'Reminder not set',
        content: 'at_iso must be a valid ISO-8601 timestamp.',
        isError: true,
      };
    }
    if (at.getTime() < Date.now() - 60_000) {
      return {
        summary: 'Reminder not set',
        content: 'at_iso is in the past. Ask the user what time they meant.',
        isError: true,
      };
    }

    const title = String(input.title ?? 'Reminder');
    const body = String(input.body ?? '');

    const created = ctx.store.scheduleNotification({
      userId: ctx.user.id,
      kind: 'system',
      title,
      body,
      scheduledFor: at.toISOString(),
      dedupeKey: `manual:${sha256(`${title}|${body}|${at.toISOString()}`).slice(0, 16)}`,
    });

    if (!created) {
      return { summary: 'Reminder already set', content: 'An identical reminder already exists.' };
    }

    return {
      summary: `Reminder set for ${relativeTime(at)}`,
      content: {
        id: created.id,
        firesAtIso: created.scheduledFor,
        firesAtLocal: formatInZone(created.scheduledFor, ctx.timeZone),
      },
    };
  },
};

const listReminders: AssistantTool = {
  spec: toolSpec(
    'list_reminders',
    'List reminders that have not fired yet, so the user can ask "what did I ask you to remind me about".',
    {},
    [],
  ),
  async handler(_input, ctx) {
    const pending = ctx.store
      .listNotifications(ctx.user.id, { pendingOnly: true })
      .filter((n) => n.kind === 'system');

    return {
      summary: `${pending.length} pending reminder${pending.length === 1 ? '' : 's'}`,
      content: {
        reminders: pending.map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body,
          firesAtIso: n.scheduledFor,
          firesAtLocal: formatInZone(n.scheduledFor, ctx.timeZone),
          relative: relativeTime(new Date(n.scheduledFor)),
        })),
      },
    };
  },
};

export const reminderTools: AssistantTool[] = [scheduleReminder, listReminders];
