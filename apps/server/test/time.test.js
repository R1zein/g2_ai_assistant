import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, formatInZone, zonedLocalToInstant } from '../dist/util/time.js';

test('relativeTime renders minutes, hours and days', () => {
  const base = new Date('2026-09-11T12:00:00Z');
  assert.equal(relativeTime(new Date('2026-09-11T12:00:20Z'), base), 'now');
  assert.equal(relativeTime(new Date('2026-09-11T12:45:00Z'), base), 'in 45m');
  assert.equal(relativeTime(new Date('2026-09-11T14:15:00Z'), base), 'in 2h 15m');
  assert.equal(relativeTime(new Date('2026-09-11T15:00:00Z'), base), 'in 3h');
  assert.equal(relativeTime(new Date('2026-09-14T12:00:00Z'), base), 'in 3 days');
  assert.equal(relativeTime(new Date('2026-09-11T10:00:00Z'), base), '2h ago');
});

test('formatInZone shifts into the requested zone', () => {
  // 12:00 UTC is 14:00 in Prague during CEST.
  assert.equal(formatInZone('2026-09-11T12:00:00Z', 'Europe/Prague', false), '14:00');
  assert.equal(formatInZone('2026-09-11T12:00:00Z', 'Asia/Tokyo', false), '21:00');
});

test('zonedLocalToInstant reads a naive timestamp as local wall-clock time', () => {
  // 15:00 in Prague during summer time is 13:00 UTC.
  const summer = zonedLocalToInstant('2026-07-01T15:00:00', 'Europe/Prague');
  assert.equal(summer?.toISOString(), '2026-07-01T13:00:00.000Z');

  // The same clock time in winter is 14:00 UTC — the two-pass fix matters here.
  const winter = zonedLocalToInstant('2026-01-15T15:00:00', 'Europe/Prague');
  assert.equal(winter?.toISOString(), '2026-01-15T14:00:00.000Z');
});

test('zonedLocalToInstant respects an offset that is already present', () => {
  const explicit = zonedLocalToInstant('2026-07-01T15:00:00+09:00', 'Europe/Prague');
  assert.equal(explicit?.toISOString(), '2026-07-01T06:00:00.000Z');
});

test('zonedLocalToInstant rejects nonsense', () => {
  assert.equal(zonedLocalToInstant('not a date', 'UTC'), null);
  assert.equal(zonedLocalToInstant('', 'UTC'), null);
});
