import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY = 'a-test-passphrase-long-enough-to-pass';
process.env.GOOGLE_CLIENT_ID ??= 'test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-secret';
// Deliberately no ANTHROPIC_API_KEY: exercises the bring-your-own-key path.
delete process.env.ANTHROPIC_API_KEY;

const { Store } = await import('../dist/store/index.js');
const { anthropicFor, assistantReady, MissingApiKeyError } = await import('../dist/ai/anthropic.js');

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'g2-key-'));
  const store = await Store.open(dir);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function newUser(store, email) {
  return store.upsertUser({ email, timeZone: 'UTC', tokens: { refreshToken: 'r', scopes: [] } });
}

test('a stored key is encrypted at rest and never kept in plaintext', async () => {
  await withStore(async (store) => {
    const user = newUser(store, 'a@example.com');
    store.setUserApiKey(user.id, 'sk-ant-api03-SECRETVALUE');

    const raw = JSON.stringify(store.getUser(user.id));
    assert.ok(!raw.includes('SECRETVALUE'), 'plaintext key leaked into the record');
    assert.equal(store.getUser(user.id).apiKeyHint, 'ALUE');
    assert.equal(store.getUserApiKey(user.id), 'sk-ant-api03-SECRETVALUE');
  });
});

test('clearing the key removes the cipher and the hint together', async () => {
  await withStore(async (store) => {
    const user = newUser(store, 'b@example.com');
    store.setUserApiKey(user.id, 'sk-ant-api03-XYZ1');
    store.clearUserApiKey(user.id);

    assert.equal(store.getUserApiKey(user.id), undefined);
    assert.equal(store.getUser(user.id).apiKeyHint, undefined);
  });
});

test('with no key anywhere the assistant refuses instead of guessing', async () => {
  await withStore(async (store) => {
    const user = newUser(store, 'c@example.com');
    assert.equal(assistantReady(store, user), false);
    assert.throws(() => anthropicFor(store, user), MissingApiKeyError);
  });
});

test('a personal key makes the account ready and is preferred', async () => {
  await withStore(async (store) => {
    const user = newUser(store, 'd@example.com');
    store.setUserApiKey(user.id, 'sk-ant-api03-PERSONAL');

    assert.equal(assistantReady(store, store.getUser(user.id)), true);
    assert.equal(anthropicFor(store, store.getUser(user.id)).source, 'user');
  });
});

test('a key sealed under a different ENCRYPTION_KEY is surfaced, not silently ignored', async () => {
  await withStore(async (store) => {
    const user = newUser(store, 'e@example.com');
    store.setUserApiKey(user.id, 'sk-ant-api03-PERSONAL');

    // Simulate the operator rotating ENCRYPTION_KEY without re-entering keys.
    store.getUser(user.id).apiKeyCipher = 'g2v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCC';

    assert.throws(() => anthropicFor(store, store.getUser(user.id)), MissingApiKeyError);
  });
});
