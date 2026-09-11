import test from 'node:test';
import assert from 'node:assert/strict';
import { getTextWidth } from '@evenrealities/pretext';
import { wrapLines, paginate, spread, fit } from '../src/display/text.ts';

/** Body width used by the real layout: 576 minus 6px padding on each side. */
const WIDTH = 564;

test('wrapLines never exceeds the pixel budget', () => {
  const text =
    'Check-in at Hotel Astoria is at 15:00, the address is Namesti Republiky 7 and your ' +
    'confirmation code is BK-4471209. Breakfast is included until 10:30.';

  for (const line of wrapLines(text, WIDTH)) {
    assert.ok(
      getTextWidth(line) <= WIDTH,
      `line exceeded ${WIDTH}px: "${line}" (${getTextWidth(line)}px)`,
    );
  }
});

test('wrapLines preserves explicit line breaks', () => {
  const lines = wrapLines('first\nsecond\n\nfourth', WIDTH);
  assert.deepEqual(lines, ['first', 'second', '', 'fourth']);
});

test('wrapLines breaks a word that cannot fit on its own line', () => {
  const long = 'X'.repeat(400);
  const lines = wrapLines(long, WIDTH);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(getTextWidth(line) <= WIDTH);
  assert.equal(lines.join(''), long);
});

test('paginate chunks into screenfuls and always returns at least one page', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const pages = paginate(text, WIDTH, 8);
  assert.equal(pages.length, 3);
  assert.equal(pages[0]!.split('\n').length, 8);
  assert.deepEqual(paginate('', WIDTH, 8), ['']);
});

test('spread pushes the right-hand text towards the right edge', () => {
  const line = spread('Next: in 2h', '84%', WIDTH);
  assert.ok(line.startsWith('Next: in 2h'));
  assert.ok(line.endsWith('84%'));
  assert.ok(getTextWidth(line) <= WIDTH);
});

test('fit truncates to the pixel budget', () => {
  const short = fit('Gate B14', WIDTH);
  assert.equal(short, 'Gate B14');
  const clipped = fit('A very long booking title that will not fit at all', 80);
  assert.ok(getTextWidth(clipped) <= 80);
});
