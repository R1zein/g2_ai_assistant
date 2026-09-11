import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForGlasses, truncate, htmlToText, transliterate } from '../dist/util/text.js';

test('sanitizeForGlasses strips markdown and unsupported glyphs', () => {
  assert.equal(sanitizeForGlasses('**Gate B14** is open'), 'Gate B14 is open');
  assert.equal(sanitizeForGlasses('## Heading\nbody'), 'Heading\nbody');
  assert.equal(sanitizeForGlasses('use `npm run dev`'), 'use npm run dev');
  assert.equal(sanitizeForGlasses('Ready 🚀 to go'), 'Ready to go');
  assert.equal(sanitizeForGlasses('“curly” — dash…'), '"curly" - dash...');
});

test('sanitizeForGlasses collapses runaway whitespace but keeps paragraphs', () => {
  assert.equal(sanitizeForGlasses('a    b\n\n\n\nc'), 'a b\n\nc');
});

test('truncate breaks on a word boundary when it can', () => {
  assert.equal(truncate('short', 20), 'short');
  assert.equal(truncate('the quick brown fox jumps', 20), 'the quick brown…');
  // No usable boundary near the end: fall back to a hard cut.
  assert.equal(truncate('aaaaaaaaaaaaaaaaaaaaaaa', 10), 'aaaaaaaaa…');
});

test('htmlToText flattens a mail body', () => {
  const html = '<div>Check-in<br>15:00</div><script>evil()</script><p>Room&nbsp;204</p>';
  assert.equal(htmlToText(html), 'Check-in\n15:00\nRoom 204');
});

test('transliterate romanises Cyrillic and preserves case', () => {
  assert.equal(transliterate('Бронь'), 'Bron');
  assert.equal(transliterate('Шереметьево'), 'Sheremetevo');
  assert.equal(transliterate('Gate B14'), 'Gate B14');
});
