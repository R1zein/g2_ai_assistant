import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ANTHROPIC_API_KEY ??= 'sk-test';
process.env.GOOGLE_CLIENT_ID ??= 'test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-secret';

const { Store } = await import('../dist/store/index.js');

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'g2-store-'));
  const store = await Store.open(dir);
  try {
    await fn(store, dir);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('pairing hands the session token over exactly once', async () => {
  await withStore(async (store) => {
    const user = store.upsertUser({
      email: 'a@example.com',
      timeZone: 'Europe/Prague',
      tokens: { refreshToken: 'r1', scopes: [] },
    });

    const pairing = store.createPairing('device-1', 'Even G2');
    assert.equal(store.getPairing(pairing.code)?.status, 'pending');

    store.linkPairing(pairing.code, user.id);
    const token = store.claimPairingToken(pairing.code);
    assert.ok(token && token.length > 20);
    assert.equal(store.claimPairingToken(pairing.code), undefined);

    const session = store.authenticate(token);
    assert.equal(session?.user.email, 'a@example.com');
    assert.equal(store.authenticate('wrong-token'), undefined);
  });
});

test('upsertUser never drops an existing refresh token', async () => {
  await withStore(async (store) => {
    const first = store.upsertUser({
      email: 'b@example.com',
      timeZone: 'UTC',
      tokens: { refreshToken: 'original', scopes: ['a'] },
    });

    const second = store.upsertUser({
      email: 'b@example.com',
      timeZone: 'Europe/Berlin',
      // Google omits the refresh token on repeat consent.
      tokens: { refreshToken: '', accessToken: 'fresh', scopes: ['a'] },
    });

    assert.equal(second.id, first.id);
    assert.equal(second.tokens.refreshToken, 'original');
    assert.equal(second.tokens.accessToken, 'fresh');
    assert.equal(second.timeZone, 'Europe/Berlin');
  });
});

test('notifications dedupe on the dedupe key', async () => {
  await withStore(async (store) => {
    const user = store.upsertUser({
      email: 'c@example.com',
      timeZone: 'UTC',
      tokens: { refreshToken: 'r', scopes: [] },
    });

    const payload = {
      userId: user.id,
      kind: 'booking_reminder',
      title: 'Hotel Astoria',
      body: '15:00',
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      dedupeKey: 'lead:abc:120',
    };

    assert.ok(store.scheduleNotification(payload));
    assert.equal(store.scheduleNotification(payload), undefined);
    assert.equal(store.listNotifications(user.id, { pendingOnly: true }).length, 1);
  });
});

test('the database survives a reopen', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'g2-store-'));
  try {
    const first = await Store.open(dir);
    const user = first.upsertUser({
      email: 'd@example.com',
      timeZone: 'UTC',
      tokens: { refreshToken: 'r', scopes: [] },
    });
    first.markMessageSeen(user.id, 'msg-1');
    await first.close();

    const second = await Store.open(dir);
    assert.equal(second.listUsers().length, 1);
    assert.equal(second.hasSeenMessage(second.listUsers()[0].id, 'msg-1'), true);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
