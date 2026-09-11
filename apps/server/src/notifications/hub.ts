import type { StreamEvent } from '@g2/shared';
import { logger } from '../logger.js';

const log = logger('notify:hub');

type Sink = (event: StreamEvent) => void;

/**
 * Fan-out of server-sent events to every glasses app currently connected for a
 * user. A user may have several (phone WebView reloaded, simulator open beside
 * real hardware), so subscribers are held per connection, not per user.
 */
class NotificationHub {
  private readonly subscribers = new Map<string, Set<Sink>>();

  subscribe(userId: string, sink: Sink): () => void {
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(sink);
    log.debug(`subscriber attached (${set.size} for this user)`);

    return () => {
      const current = this.subscribers.get(userId);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) this.subscribers.delete(userId);
    };
  }

  /** Returns how many live connections received the event. */
  emit(userId: string, event: StreamEvent): number {
    const set = this.subscribers.get(userId);
    if (!set || set.size === 0) return 0;

    let delivered = 0;
    for (const sink of set) {
      try {
        sink(event);
        delivered++;
      } catch (err) {
        log.warn('subscriber threw while receiving an event', err);
        set.delete(sink);
      }
    }
    return delivered;
  }

  isOnline(userId: string): boolean {
    return (this.subscribers.get(userId)?.size ?? 0) > 0;
  }
}

export const hub = new NotificationHub();
