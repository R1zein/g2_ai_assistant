import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { htmlToText, truncate } from '../util/text.js';
import { logger } from '../logger.js';

const log = logger('google:gmail');

function api(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth });
}

export interface MailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  receivedAt: string;
  snippet: string;
  /** Plain-text body, HTML flattened, truncated for the model. */
  body: string;
  labelIds: string[];
}

/**
 * Gmail search that casts a wide net for reservations while staying cheap.
 *
 * Two halves ORed together: vocabulary that shows up in confirmation mail, and
 * the Gmail-side `category:` buckets where such mail usually lands. Both are
 * scoped to the requested window.
 */
export function bookingSearchQuery(afterDays: number): string {
  const vocabulary = [
    'confirmation',
    'reservation',
    'booking',
    '"check-in"',
    'itinerary',
    '"boarding pass"',
    '"e-ticket"',
    'бронирование',
    'бронь',
    'подтверждение',
    'buchung',
    'reserva',
    'réservation',
  ]
    .map((t) => `subject:(${t}) OR ${t}`)
    .join(' OR ');

  const after = new Date(Date.now() - afterDays * 86_400_000);
  const stamp = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;

  return `(${vocabulary} OR category:travel OR category:reservations) after:${stamp} -in:spam -in:trash`;
}

/** Walks the MIME tree and prefers `text/plain`, falling back to flattened HTML. */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart): void => {
    const data = part.body?.data;
    if (data) {
      const decoded = Buffer.from(data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/plain') plain.push(decoded);
      else if (part.mimeType === 'text/html') html.push(decoded);
    }
    for (const child of part.parts ?? []) walk(child);
  };

  walk(payload);

  if (plain.length > 0) return plain.join('\n').trim();
  if (html.length > 0) return htmlToText(html.join('\n'));
  return '';
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const found = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

/** Max characters of email body handed to the extractor. */
const BODY_CHAR_LIMIT = 12_000;

export async function getMessage(auth: OAuth2Client, id: string): Promise<MailMessage | null> {
  try {
    const { data } = await api(auth).users.messages.get({ userId: 'me', id, format: 'full' });
    const receivedMs = Number(data.internalDate ?? 0);

    return {
      id: data.id ?? id,
      threadId: data.threadId ?? '',
      subject: header(data, 'Subject'),
      from: header(data, 'From'),
      to: header(data, 'To'),
      receivedAt: receivedMs > 0 ? new Date(receivedMs).toISOString() : new Date().toISOString(),
      snippet: data.snippet ?? '',
      body: truncate(extractBody(data.payload), BODY_CHAR_LIMIT),
      labelIds: data.labelIds ?? [],
    };
  } catch (err) {
    log.warn(`failed to fetch message ${id}`, err);
    return null;
  }
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
}

/** Returns message ids only — bodies are fetched lazily, they are expensive. */
export async function searchMessageIds(
  auth: OAuth2Client,
  opts: SearchOptions,
): Promise<string[]> {
  const ids: string[] = [];
  const limit = opts.maxResults ?? 50;
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const { data } = await api(auth).users.messages.list({
      userId: 'me',
      q: opts.query,
      maxResults: Math.min(100, limit - ids.length),
      ...(pageToken ? { pageToken } : {}),
    });

    for (const m of data.messages ?? []) if (m.id) ids.push(m.id);

    pageToken = data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  return ids.slice(0, limit);
}

/** Convenience for the assistant's `search_email` tool: ids + headers, no bodies. */
export async function searchMessages(
  auth: OAuth2Client,
  opts: SearchOptions,
): Promise<MailMessage[]> {
  const ids = await searchMessageIds(auth, opts);
  const messages = await Promise.all(ids.map((id) => getMessage(auth, id)));
  return messages.filter((m): m is MailMessage => m !== null);
}

export async function getProfile(
  auth: OAuth2Client,
): Promise<{ emailAddress: string; historyId?: string }> {
  const { data } = await api(auth).users.getProfile({ userId: 'me' });
  return {
    emailAddress: data.emailAddress ?? '',
    historyId: data.historyId ?? undefined,
  };
}
