import { randomBytes, randomUUID, createHash } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

/** Opaque bearer token for a paired device. */
export function sessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Short, human-readable pairing code. Excludes characters that are easy to
 * confuse when read off a 576x288 monochrome display (0/O, 1/I/L, 5/S, 8/B).
 */
export function pairingCode(): string {
  const alphabet = 'ACDEFGHJKMNPQRTUVWXY2346789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i === 3) out += '-';
  }
  return out;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
