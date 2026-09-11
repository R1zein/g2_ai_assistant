import { getTextWidth, pxTruncate } from '@evenrealities/pretext';

/**
 * Greedy word wrap against the real firmware metrics.
 *
 * `measureTextWrap` only reports line counts, and we need the line strings
 * themselves to build pages, so the wrapping is done here with the same
 * per-glyph advance widths the glasses use.
 */
export function wrapLines(text: string, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current === '' ? word : `${current} ${word}`;

      if (getTextWidth(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current !== '') {
        lines.push(current);
        current = '';
      }

      // A single word wider than the line gets broken by character.
      if (getTextWidth(word) <= maxWidth) {
        current = word;
      } else {
        let chunk = '';
        for (const ch of word) {
          if (getTextWidth(chunk + ch) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      }
    }

    if (current !== '') lines.push(current);
  }

  return lines;
}

/** Splits wrapped text into screenfuls of `linesPerPage`. */
export function paginate(text: string, maxWidth: number, linesPerPage: number): string[] {
  const lines = wrapLines(text, maxWidth);
  if (lines.length === 0) return [''];

  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage).join('\n'));
  }
  return pages;
}

/** Truncate to a pixel budget, with the firmware's own ellipsis behaviour. */
export function fit(text: string, maxWidth: number): string {
  return pxTruncate(text, maxWidth);
}

/**
 * Shrinks a space run until the whole line fits.
 *
 * The firmware font is not monospaced and applies kerning, so `n * spaceWidth`
 * is only an estimate — the result has to be measured and walked back.
 */
function padToFit(build: (pad: number) => string, estimate: number, maxWidth: number): string {
  let pad = Math.max(0, estimate);
  let line = build(pad);
  while (pad > 0 && getTextWidth(line) > maxWidth) {
    pad--;
    line = build(pad);
  }
  return line;
}

/**
 * Pads with spaces so text sits roughly centred. The display has no alignment
 * control, so this is the only way to centre anything.
 */
export function centre(text: string, maxWidth: number): string {
  const spaceWidth = getTextWidth(' ') || 5;
  const estimate = Math.floor((maxWidth - getTextWidth(text)) / 2 / spaceWidth);
  return padToFit((pad) => `${' '.repeat(pad)}${text}`, estimate, maxWidth);
}

/**
 * Right-aligns `right` against `left` on one line, so a header can carry a
 * title and a status without a second container.
 */
export function spread(left: string, right: string, maxWidth: number): string {
  if (right === '') return left;

  const spaceWidth = getTextWidth(' ') || 5;
  const used = getTextWidth(left) + getTextWidth(right);
  const estimate = Math.floor((maxWidth - used) / spaceWidth);

  return padToFit((pad) => `${left}${' '.repeat(Math.max(1, pad))}${right}`, estimate, maxWidth);
}
