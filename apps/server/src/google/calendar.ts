import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Booking } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

const log = logger('google:calendar');

/** Marks events this assistant owns so we can update rather than duplicate. */
export const SOURCE_TAG = 'g2-ai-assistant';

function api(auth: OAuth2Client): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth });
}

export async function getPrimaryTimeZone(auth: OAuth2Client): Promise<string> {
  try {
    const { data } = await api(auth).calendars.get({ calendarId: 'primary' });
    return data.timeZone || 'UTC';
  } catch (err) {
    log.warn('could not read primary calendar timezone, defaulting to UTC', err);
    return 'UTC';
  }
}

/**
 * Finds (or creates) the calendar bookings are written into. Keeping them off
 * `primary` means the user can hide or delete everything the assistant added
 * with a single toggle in Google Calendar.
 */
export async function ensureBookingsCalendar(auth: OAuth2Client, timeZone: string): Promise<string> {
  const cfg = loadConfig();
  const cal = api(auth);

  const { data } = await cal.calendarList.list({ maxResults: 250, showHidden: true });
  const found = data.items?.find((c) => c.summary === cfg.bookingsCalendarName);
  if (found?.id) return found.id;

  const created = await cal.calendars.insert({
    requestBody: {
      summary: cfg.bookingsCalendarName,
      description: 'Reservations detected in Gmail by the G2 AI assistant.',
      timeZone,
    },
  });
  if (!created.data.id) throw new Error('Google Calendar did not return an id for the new calendar.');
  log.info(`created calendar "${cfg.bookingsCalendarName}" (${created.data.id})`);
  return created.data.id;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  description?: string;
  hangoutLink?: string;
  attendees?: string[];
  /** Present on events this assistant wrote. */
  bookingId?: string;
}

function toEvent(calendarId: string, raw: calendar_v3.Schema$Event): CalendarEvent | null {
  const start = raw.start?.dateTime ?? raw.start?.date;
  if (!raw.id || !start) return null;
  return {
    id: raw.id,
    calendarId,
    title: raw.summary ?? '(no title)',
    start,
    end: raw.end?.dateTime ?? raw.end?.date ?? undefined,
    allDay: Boolean(raw.start?.date && !raw.start?.dateTime),
    location: raw.location ?? undefined,
    description: raw.description ?? undefined,
    hangoutLink: raw.hangoutLink ?? undefined,
    attendees: raw.attendees?.map((a) => a.email ?? '').filter(Boolean),
    bookingId: raw.extendedProperties?.private?.bookingId ?? undefined,
  };
}

export interface ListEventsOptions {
  timeMin: Date;
  timeMax: Date;
  /** Free-text search passed to Google. */
  query?: string;
  maxResults?: number;
  /** Restrict to specific calendars; defaults to every calendar the user selected. */
  calendarIds?: string[];
}

/** Reads across every selected calendar and merges the results chronologically. */
export async function listEvents(
  auth: OAuth2Client,
  opts: ListEventsOptions,
): Promise<CalendarEvent[]> {
  const cal = api(auth);
  let calendarIds = opts.calendarIds;

  if (!calendarIds) {
    const { data } = await cal.calendarList.list({ maxResults: 250 });
    calendarIds = (data.items ?? [])
      .filter((c) => c.selected !== false && !c.deleted)
      .map((c) => c.id!)
      .filter(Boolean);
    if (calendarIds.length === 0) calendarIds = ['primary'];
  }

  const perCalendar = Math.max(5, Math.ceil((opts.maxResults ?? 25) / calendarIds.length) + 5);

  const batches = await Promise.all(
    calendarIds.map(async (calendarId) => {
      try {
        const { data } = await cal.events.list({
          calendarId,
          timeMin: opts.timeMin.toISOString(),
          timeMax: opts.timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: perCalendar,
          ...(opts.query ? { q: opts.query } : {}),
        });
        return (data.items ?? [])
          .map((raw) => toEvent(calendarId, raw))
          .filter((e): e is CalendarEvent => e !== null);
      } catch (err) {
        log.warn(`listing ${calendarId} failed`, err);
        return [];
      }
    }),
  );

  return batches
    .flat()
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, opts.maxResults ?? 25);
}

function buildEventBody(booking: Booking, contentHash: string): calendar_v3.Schema$Event {
  const descriptionLines = [
    booking.vendor ? `Vendor: ${booking.vendor}` : null,
    booking.confirmationCode ? `Confirmation: ${booking.confirmationCode}` : null,
    booking.travellers ? `Guests/passengers: ${booking.travellers}` : null,
    booking.price ? `Price: ${booking.price.amount} ${booking.price.currency}` : null,
    booking.cancellationPolicy ? `Cancellation: ${booking.cancellationPolicy}` : null,
    booking.notes ?? null,
    '',
    `Added automatically by the G2 AI assistant from an email${
      booking.sourceSubject ? ` ("${booking.sourceSubject}")` : ''
    }.`,
  ].filter((l): l is string => l !== null);

  // A journey without a stated arrival still needs an end time; one hour is the
  // least-wrong default and keeps the event visible in day view.
  const end = booking.end ?? new Date(new Date(booking.start).getTime() + 3_600_000).toISOString();

  return {
    summary: booking.title,
    description: descriptionLines.join('\n'),
    location: booking.location?.address ?? booking.location?.name ?? undefined,
    start: { dateTime: booking.start, timeZone: booking.timeZone },
    end: { dateTime: end, timeZone: booking.timeZone },
    extendedProperties: {
      private: {
        source: SOURCE_TAG,
        bookingId: booking.id,
        bookingType: booking.type,
        gmailMessageId: booking.sourceMessageId,
        contentHash,
      },
    },
    // Google's own defaults would add popups the user did not ask for; our
    // reminders are pushed to the glasses instead.
    reminders: { useDefault: false, overrides: [] },
  };
}

/**
 * Creates or updates the calendar event for a booking.
 *
 * Idempotent twice over: we look the event up by `bookingId`, and we skip the
 * write entirely when the stored `contentHash` already matches.
 */
export async function upsertBookingEvent(
  auth: OAuth2Client,
  calendarId: string,
  booking: Booking,
  contentHash: string,
): Promise<{ eventId: string; written: boolean }> {
  const cal = api(auth);

  const existing = await cal.events.list({
    calendarId,
    privateExtendedProperty: [`bookingId=${booking.id}`],
    showDeleted: false,
    maxResults: 1,
  });

  const match = existing.data.items?.[0];
  const body = buildEventBody(booking, contentHash);

  if (match?.id) {
    if (match.extendedProperties?.private?.contentHash === contentHash) {
      return { eventId: match.id, written: false };
    }
    const updated = await cal.events.update({ calendarId, eventId: match.id, requestBody: body });
    log.info(`updated calendar event ${match.id} for booking ${booking.id}`);
    return { eventId: updated.data.id ?? match.id, written: true };
  }

  const created = await cal.events.insert({ calendarId, requestBody: body });
  if (!created.data.id) throw new Error('Google Calendar did not return an event id.');
  log.info(`created calendar event ${created.data.id} for booking ${booking.id}`);
  return { eventId: created.data.id, written: true };
}

export interface CreateEventInput {
  title: string;
  start: string;
  end?: string;
  timeZone: string;
  location?: string;
  description?: string;
  calendarId?: string;
}

/** Used by the assistant's `create_calendar_event` tool. */
export async function createEvent(
  auth: OAuth2Client,
  input: CreateEventInput,
): Promise<CalendarEvent> {
  const calendarId = input.calendarId ?? 'primary';
  const end = input.end ?? new Date(new Date(input.start).getTime() + 3_600_000).toISOString();

  const { data } = await api(auth).events.insert({
    calendarId,
    requestBody: {
      summary: input.title,
      location: input.location,
      description: input.description,
      start: { dateTime: input.start, timeZone: input.timeZone },
      end: { dateTime: end, timeZone: input.timeZone },
      extendedProperties: { private: { source: SOURCE_TAG } },
    },
  });

  const event = toEvent(calendarId, data);
  if (!event) throw new Error('Google Calendar returned an event without an id or start time.');
  return event;
}

export async function deleteEvent(
  auth: OAuth2Client,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await api(auth).events.delete({ calendarId, eventId });
}
