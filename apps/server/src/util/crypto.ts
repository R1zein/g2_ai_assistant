import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for secrets at rest — currently the per-user Anthropic
 * API key.
 *
 * AES-256-GCM, random IV per record, authentication tag stored alongside. The
 * master key is derived from `ENCRYPTION_KEY` with scrypt, so any passphrase
 * length works and a leaked database is useless without the env var.
 */

const MAGIC = 'g2v1';
const SALT = 'g2-ai-assistant.secretbox.v1';
const IV_BYTES = 12;

let masterKey: Buffer | null = null;
let resolved = false;

function deriveKey(): Buffer | null {
  if (resolved) return masterKey;
  resolved = true;

  const secret = (process.env.ENCRYPTION_KEY ?? '').trim();
  if (secret.length < 16) {
    masterKey = null;
    return null;
  }

  masterKey = scryptSync(secret, SALT, 32);
  return masterKey;
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'ENCRYPTION_KEY is not set (or is shorter than 16 characters), so secrets ' +
        'cannot be stored. Generate one with: openssl rand -base64 32',
    );
    this.name = 'EncryptionUnavailableError';
  }
}

export function encryptionAvailable(): boolean {
  return deriveKey() !== null;
}

/** Returns `g2v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(plaintext: string): string {
  const key = deriveKey();
  if (!key) throw new EncryptionUnavailableError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [MAGIC, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export class SealedValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedValueError';
  }
}

/** Throws rather than returning a partial result if the record was tampered with. */
export function unseal(sealed: string): string {
  const key = deriveKey();
  if (!key) throw new EncryptionUnavailableError();

  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== MAGIC) {
    throw new SealedValueError('Stored secret is not in the expected envelope format.');
  }

  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A bad tag means either the wrong ENCRYPTION_KEY or a modified record.
    throw new SealedValueError(
      'Stored secret could not be decrypted. ENCRYPTION_KEY has probably changed since it was saved.',
    );
  }
}

/** Constant-time comparison, for anything that is checked rather than decrypted. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
