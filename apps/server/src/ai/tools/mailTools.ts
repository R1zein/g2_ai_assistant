import { getMessage, searchMessages } from '../../google/gmail.js';
import { syncMailbox } from '../../bookings/sync.js';
import { formatInZone } from '../../util/time.js';
import { truncate } from '../../util/text.js';
import { type AssistantTool, toolSpec } from './types.js';

const searchEmail: AssistantTool = {
  spec: toolSpec(
    'search_email',
    'Search the user\'s Gmail using Gmail query syntax (from:, subject:, after:, has:attachment, ' +
      'newer_than:7d, …). Returns headers and a snippet, not full bodies. Use read_email to open one. ' +
      'Reach for this when the answer is likely in a mail the assistant has not turned into a booking.',
    {
      query: {
        type: 'string',
        description: 'A Gmail search query, e.g. `from:booking.com newer_than:30d`.',
      },
      max_results: { type: 'integer', minimum: 1, maximum: 15 },
    },
    ['query', 'max_results'],
  ),
  async handler(input, ctx) {
    const query = String(input.query ?? '').trim();
    if (!query) {
      return { summary: 'Email search rejected', content: 'query must not be empty.', isError: true };
    }

    const messages = await searchMessages(ctx.auth, {
      query,
      maxResults: Number(input.max_results ?? 5),
    });

    return {
      summary: `Searched mail for "${truncate(query, 40)}" (${messages.length} hit${
        messages.length === 1 ? '' : 's'
      })`,
      content: {
        messages: messages.map((m) => ({
          id: m.id,
          subject: m.subject,
          from: m.from,
          receivedIso: m.receivedAt,
          receivedLocal: formatInZone(m.receivedAt, ctx.timeZone),
          snippet: m.snippet,
        })),
      },
    };
  },
};

const readEmail: AssistantTool = {
  spec: toolSpec(
    'read_email',
    'Read the full plain-text body of one Gmail message by id, as returned by search_email. ' +
      'Use it to pull out a specific detail (a door code, a gate number, a policy line).',
    { message_id: { type: 'string', description: 'The Gmail message id.' } },
    ['message_id'],
  ),
  async handler(input, ctx) {
    const id = String(input.message_id ?? '').trim();
    const message = await getMessage(ctx.auth, id);

    if (!message) {
      return { summary: 'Message not found', content: `No Gmail message with id ${id}.`, isError: true };
    }

    return {
      summary: `Read "${truncate(message.subject || '(no subject)', 40)}"`,
      content: {
        id: message.id,
        subject: message.subject,
        from: message.from,
        to: message.to,
        receivedIso: message.receivedAt,
        receivedLocal: formatInZone(message.receivedAt, ctx.timeZone),
        body: truncate(message.body, 6_000),
      },
    };
  },
};

const refreshBookings: AssistantTool = {
  spec: toolSpec(
    'refresh_bookings',
    'Re-scan recent mail for reservations and sync anything new into Google Calendar. ' +
      'Call this only when the user says a booking is missing or has just arrived — ' +
      'a background sync already runs on a schedule, and this one is slow.',
    {
      days_back: {
        type: 'integer',
        description: 'How many days of mail to re-examine. Keep it small (1-14) — this is slow.',
        minimum: 1,
        maximum: 90,
      },
    },
    ['days_back'],
  ),
  async handler(input, ctx) {
    const result = await syncMailbox(ctx.store, ctx.user, {
      backfillDays: Number(input.days_back ?? 7),
      maxMessages: 25,
    });

    return {
      summary: `Scanned ${result.scannedMessages} mail(s), ${result.newBookings} new booking(s)`,
      content: result,
    };
  },
};

export const mailTools: AssistantTool[] = [searchEmail, readEmail, refreshBookings];
