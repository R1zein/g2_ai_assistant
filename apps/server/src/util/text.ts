/**
 * Text shaping for a 576x288, 16-shade, single-font display.
 *
 * The glasses firmware silently drops glyphs it has no bitmap for, so anything
 * heading for the HUD goes through `sanitizeForGlasses` first.
 */

const SMART_QUOTES: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
  ' ': ' ',
  '•': '*',
};

/** Collapse whitespace, normalise punctuation, strip markdown decoration. */
export function sanitizeForGlasses(input: string): string {
  let out = input.normalize('NFC');
  for (const [from, to] of Object.entries(SMART_QUOTES)) {
    out = out.split(from).join(to);
  }
  out = out
    // Markdown emphasis and headings are noise without font styling.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(?!\s)(.+?)\*(?=\s|$)/g, '$1$2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    // Drop anything outside BMP (emoji) — the firmware font has no coverage.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

/** Hard cap a string, breaking on a word boundary where possible. */
export function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const slice = input.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/** Strip HTML down to readable text — used on `text/html` email parts. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    // Tag removal leaves ragged indentation; trim per line before collapsing.
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Best-effort Cyrillic -> Latin transliteration.
 *
 * G2 firmware glyph coverage for Cyrillic is not guaranteed; when
 * `DISPLAY_TRANSLITERATE` is on we romanise HUD text so a Russian answer stays
 * readable instead of rendering as gaps. The phone-side panel always shows the
 * original.
 */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function transliterate(input: string): string {
  let out = '';
  for (const ch of input) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC[lower];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out;
}

export function hasCyrillic(input: string): boolean {
  return /[Ѐ-ӿ]/.test(input);
}
