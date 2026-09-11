import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

export class BridgeCallError extends Error {
  constructor(
    readonly label: string,
    message: string,
  ) {
    super(`${label}: ${message}`);
    this.name = 'BridgeCallError';
  }
}

/**
 * Serialising wrapper around the Even App bridge.
 *
 * Two rules the SDK expects and does not enforce: bridge calls must not overlap
 * (a concurrent render plus a storage write can drop the BLE link), and every
 * call needs its own timeout, because a flaky hop otherwise hangs for ~30s.
 */
export class GlassesBridge {
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(readonly raw: EvenAppBridge) {}

  static async connect(): Promise<GlassesBridge> {
    return new GlassesBridge(await waitForEvenAppBridge());
  }

  /** Queues a bridge call behind every earlier one and caps how long it may take. */
  run<T>(label: string, fn: (bridge: EvenAppBridge) => Promise<T>, timeoutMs = 8_000): Promise<T> {
    const next = this.chain.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(this.raw),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new BridgeCallError(label, `timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });

    // Keep the chain alive even when this call rejects, or one failure would
    // permanently wedge every later render.
    this.chain = next.catch(() => undefined);
    return next;
  }
}
