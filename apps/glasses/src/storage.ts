import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { STORAGE_KEYS } from './config';

/**
 * Persistence through the Even App.
 *
 * Browser `localStorage` and IndexedDB are not reliable across app restarts in
 * the Flutter WebView, so the session token has to live on the host side.
 */
export class HostStorage {
  constructor(private readonly bridge: EvenAppBridge) {}

  async get(key: string): Promise<string> {
    try {
      return (await this.bridge.getLocalStorage(key)) ?? '';
    } catch {
      return '';
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.bridge.setLocalStorage(key, value);
    } catch {
      // A failed write costs the user a re-pair, not a crash.
    }
  }

  /** Stable per-install id, minted once and reused for every pairing. */
  async deviceId(): Promise<string> {
    const existing = await this.get(STORAGE_KEYS.deviceId);
    if (existing) return existing;

    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    await this.set(STORAGE_KEYS.deviceId, fresh);
    return fresh;
  }

  sessionToken(): Promise<string> {
    return this.get(STORAGE_KEYS.sessionToken);
  }

  setSessionToken(token: string): Promise<void> {
    return this.set(STORAGE_KEYS.sessionToken, token);
  }

  clearSession(): Promise<void> {
    return this.set(STORAGE_KEYS.sessionToken, '');
  }
}
