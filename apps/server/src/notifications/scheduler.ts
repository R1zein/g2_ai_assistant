import type { Booking } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import type { Store } from '../store/index.js';
import { formatInZone, relativeTime } from '../util/time.js';
import { hub } from './hub.js';

const log = logger('notify:scheduler');

/** How often the delivery loop wakes up. */
const TICK_MS = 30_000;

function leadLabel(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? 'tomorrow' : `in ${days} days`;
  }
  if (minutes % 60 === 0) return `in ${minutes / 60}h`;
  return `in ${minutes}m`;
}

/**
 * Queues the lead-time reminders for one booking.
 *
 * Idempotent through the dedupe key, so re-syncing the same reservation — or
 * restarting the server — never produces a second card on the HUD.
 */
export function scheduleBookingReminders(store: Store, booking: Booking & { userId: string }): void {
  const cfg = loadConfig();
  const startMs = new Date(booking.start).getTime();
  if (!Number.isFinite(startMs)) return;

  for (const lead of cfg.reminderLeadMinutes) {
    const fireAt = startMs - lead * 60_000;
    // Skip leads that already passed; the "added" card already covered those.
    if (fireAt < Date.now()) continue;

    const local = formatInZone(booking.start, booking.timeZone, false);
    const where = booking.location?.name ?? booking.location?.address ?? booking.destination?.name;

    store.scheduleNotification({
      userId: booking.userId,
      kind: 'booking_reminder',
      title: booking.title,
      body: [
        `${local}${booking.timeZoneAssumed ? ' (assumed tz)' : ''} - ${leadLabel(lead)}`,
        where ? `at ${where}` : null,
        booking.confirmationCode ? `ref ${booking.confirmationCode}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      scheduledFor: new Date(fireAt).toISOString(),
      bookingId: booking.id,
      calendarEventId: booking.calendarEventId,
      dedupeKey: `lead:${booking.id}:${lead}`,
    });
  }
}

/**
 * Delivers everything that is due.
 *
 * A notification is only marked delivered once a live connection actually took
 * it — an offline user gets the card on their next launch instead of losing it.
 */
export function deliverDue(store: Store): number {
  const now = Date.now();
  let delivered = 0;

  for (const user of store.listUsers()) {
    if (!hub.isOnline(user.id)) continue;

    for (const notification of store.listNotifications(user.id, { pendingOnly: true })) {
      if (new Date(notification.scheduledFor).getTime() > now) break;

      const expired =
        notification.expiresAt && new Date(notification.expiresAt).getTime() < now;
      if (expired) {
        store.markNotificationDelivered(notification.id);
        continue;
      }

      const count = hub.emit(user.id, { type: 'notification', notification });
      if (count > 0) {
        store.markNotificationDelivered(notification.id);
        delivered++;
      }
    }
  }

  return delivered;
}

export interface SchedulerHandle {
  stop(): void;
}

export function startScheduler(store: Store): SchedulerHandle {
  let pruneCounter = 0;

  const timer = setInterval(() => {
    try {
      const count = deliverDue(store);
      if (count > 0) log.info(`delivered ${count} notification(s)`);

      // Housekeeping roughly every hour.
      if (++pruneCounter >= 120) {
        pruneCounter = 0;
        store.pruneNotifications();
        store.pruneConversations();
      }
    } catch (err) {
      log.error('scheduler tick failed', err);
    }
  }, TICK_MS);

  timer.unref?.();
  log.info(`scheduler running every ${TICK_MS / 1000}s`);

  return { stop: () => clearInterval(timer) };
}
