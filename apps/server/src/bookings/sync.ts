import type { SyncResult } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { clientForUser } from '../google/oauth.js';
import { bookingSearchQuery, getMessage, searchMessageIds } from '../google/gmail.js';
import { ensureBookingsCalendar, getPrimaryTimeZone, upsertBookingEvent } from '../google/calendar.js';
import type { BookingRecord, Store, UserRecord } from '../store/index.js';
import { anthropicFor } from '../ai/anthropic.js';
import { hub } from '../notifications/hub.js';
import { scheduleBookingReminders } from '../notifications/scheduler.js';
import { nowIso, relativeTime } from '../util/time.js';
import { contentHash, extractBooking, toBooking } from './extract.js';

const log = logger('bookings:sync');

export interface SyncOptions {
  backfillDays?: number;
  maxMessages?: number;
  /** Re-examine messages already scanned. Used by the manual "rescan" action. */
  force?: boolean;
}

/** Gmail + the extraction model are both rate-limited; keep the fan-out small. */
const CONCURRENCY = 3;

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });

  await Promise.all(workers);
  return out;
}

/**
 * Scans recent mail for reservations, stores what it finds and mirrors it into
 * Google Calendar.
 *
 * Safe to run repeatedly: messages are deduped by id, bookings by a stable
 * identity hash, and calendar writes by a content hash on the event itself.
 */
export async function syncMailbox(
  store: Store,
  user: UserRecord,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const cfg = loadConfig();
  const startedAt = nowIso();
  const result: SyncResult = {
    scannedMessages: 0,
    newBookings: 0,
    updatedBookings: 0,
    calendarEventsWritten: 0,
    skipped: 0,
    errors: [],
    startedAt,
    finishedAt: startedAt,
  };

  const auth = clientForUser(store, user);

  // Resolved once for the whole pass — every extraction bills to this account.
  let anthropic;
  try {
    anthropic = anthropicFor(store, user).client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`skipping sync for ${user.email}: ${message}`);
    result.errors.push(message);
    result.finishedAt = nowIso();
    return result;
  }

  let timeZone = user.timeZone;
  if (!timeZone) {
    timeZone = await getPrimaryTimeZone(auth);
    store.updateUser(user.id, { timeZone });
  }

  const backfillDays = options.backfillDays ?? (user.lastGmailSyncAt ? 3 : cfg.gmailBackfillDays);
  const maxMessages = options.maxMessages ?? 60;

  let ids: string[];
  try {
    ids = await searchMessageIds(auth, {
      query: bookingSearchQuery(backfillDays),
      maxResults: maxMessages,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`gmail search failed for ${user.email}: ${message}`);
    result.errors.push(`Gmail search failed: ${message}`);
    result.finishedAt = nowIso();
    return result;
  }

  const pending = options.force ? ids : ids.filter((id) => !store.hasSeenMessage(user.id, id));
  result.skipped = ids.length - pending.length;

  if (pending.length === 0) {
    store.updateUser(user.id, { lastGmailSyncAt: nowIso() });
    result.finishedAt = nowIso();
    return result;
  }

  log.info(`scanning ${pending.length} message(s) for ${user.email}`);

  // Resolved lazily — most syncs find nothing and should not create a calendar.
  let bookingsCalendarId = user.bookingsCalendarId;
  const ensureCalendar = async (): Promise<string> => {
    if (!bookingsCalendarId) {
      bookingsCalendarId = await ensureBookingsCalendar(auth, timeZone);
      store.updateUser(user.id, { bookingsCalendarId });
    }
    return bookingsCalendarId;
  };

  await mapPool(pending, CONCURRENCY, async (messageId) => {
    try {
      const message = await getMessage(auth, messageId);
      if (!message) {
        store.markMessageSeen(user.id, messageId);
        return;
      }

      result.scannedMessages++;

      const extraction = await extractBooking(anthropic, message, timeZone);
      store.markMessageSeen(user.id, messageId);
      if (!extraction) return;

      const normalised = toBooking(extraction, message, user.id, timeZone);
      if (!normalised) return;

      const { booking, calendarEligible } = normalised;
      const existing = store.getBooking(booking.id);
      const hash = contentHash(booking);

      if (existing && existing.contentHash === hash) {
        // Same reservation, re-confirmed by another email. Nothing to do.
        return;
      }

      const record: BookingRecord = {
        ...booking,
        userId: user.id,
        contentHash: hash,
        createdAt: existing?.createdAt ?? booking.createdAt,
        calendarEventId: existing?.calendarEventId,
      };

      if (calendarEligible) {
        try {
          const calendarId = await ensureCalendar();
          const { eventId, written } = await upsertBookingEvent(auth, calendarId, record, hash);
          record.calendarEventId = eventId;
          if (written) result.calendarEventsWritten++;
        } catch (err) {
          const message2 = err instanceof Error ? err.message : String(err);
          log.warn(`calendar write failed for booking ${record.id}: ${message2}`);
          result.errors.push(`Calendar write failed: ${message2}`);
        }
      }

      store.putBooking(record);
      scheduleBookingReminders(store, record);

      if (existing) {
        result.updatedBookings++;
      } else {
        result.newBookings++;
        const notification = store.scheduleNotification({
          userId: user.id,
          kind: 'booking_added',
          title: record.title,
          body: `Added from email - ${relativeTime(new Date(record.start))}`,
          scheduledFor: nowIso(),
          bookingId: record.id,
          calendarEventId: record.calendarEventId,
          dedupeKey: `added:${record.id}`,
        });
        if (notification) {
          const delivered = hub.emit(user.id, { type: 'notification', notification });
          if (delivered > 0) store.markNotificationDelivered(notification.id);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`message ${messageId} failed: ${message}`);
      result.errors.push(`Message ${messageId}: ${message}`);
    }
  });

  store.updateUser(user.id, { lastGmailSyncAt: nowIso() });
  result.finishedAt = nowIso();

  log.info(
    `sync for ${user.email}: ${result.scannedMessages} scanned, ` +
      `${result.newBookings} new, ${result.updatedBookings} updated`,
  );
  return result;
}

/** Background pass over every paired account. */
export async function syncAllUsers(store: Store): Promise<void> {
  for (const user of store.listUsers()) {
    try {
      await syncMailbox(store, user);
    } catch (err) {
      log.error(`background sync failed for ${user.email}`, err);
    }
  }
}
