import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a-test-passphrase-long-enough-to-pass';

const { seal, unseal, encryptionAvailable, SealedValueError } = await import('../dist/util/crypto.js');

test('seal/unseal round-trips', () => {
  assert.equal(encryptionAvailable(), true);
  const secret = 'sk-ant-api03-abcdefghijklmnop';
  const sealed = seal(secret);
  assert.notEqual(sealed, secret);
  assert.ok(sealed.startsWith('g2v1.'));
  assert.equal(unseal(sealed), secret);
});

test('the same plaintext seals differently every time', () => {
  // A fixed IV would let an observer tell two users share a key.
  assert.notEqual(seal('same'), seal('same'));
});

test('a tampered envelope is rejected rather than partially decrypted', () => {
  const sealed = seal('sk-ant-secret');
  const parts = sealed.split('.');
  // Flip a byte in the ciphertext.
  const data = Buffer.from(parts[3], 'base64url');
  data[0] ^= 0xff;
  parts[3] = data.toString('base64url');

  assert.throws(() => unseal(parts.join('.')), SealedValueError);
});

test('a malformed envelope is rejected', () => {
  assert.throws(() => unseal('not-an-envelope'), SealedValueError);
  assert.throws(() => unseal('g2v1.a.b'), SealedValueError);
});
