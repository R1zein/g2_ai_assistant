import type { AgendaItem, AssistantMode, PhotoCard, SourceRef } from '@g2/shared';
import { BRIGHTNESS, DISPLAY, LAYOUT } from '../config';
import type { ImageSpec, PageSpec, TextSpec } from '../display/renderer';
import { centre, fit, spread } from '../display/text';
import { MENU, type Chrome, type View } from './views';

const CONTAINER = { header: 1, body: 2, footer: 3 } as const;

/** Usable text width inside a full-bleed container. */
export const BODY_WIDTH = DISPLAY.width - 2 * LAYOUT.padding;
/** Whole lines that fit in the body container. */
export const BODY_LINES = Math.floor(LAYOUT.body.height / DISPLAY.lineHeight);

/**
 * The OS contextual menu. The mode entry shows what a tap would switch *to*,
 * which is why the list is built per render rather than being a constant.
 */
function menuItems(mode: AssistantMode) {
  return [
    { itemID: MENU.ask, itemName: 'Ask' },
    { itemID: MENU.agenda, itemName: 'Agenda' },
    { itemID: MENU.brief, itemName: 'Brief me' },
    { itemID: MENU.photos, itemName: 'Photos' },
    { itemID: MENU.toggleMode, itemName: mode === 'deep' ? 'Web: on' : 'Web: off' },
    { itemID: MENU.syncMail, itemName: 'Scan mail' },
    { itemID: MENU.account, itemName: 'Account' },
    { itemID: MENU.exit, itemName: 'Exit' },
  ];
}

function header(left: string, chrome: Chrome): TextSpec {
  const right = [
    chrome.busy ? '...' : '',
    // Only flagged when on: `fast` is the normal state and needs no badge.
    chrome.mode === 'deep' ? 'web' : '',
    chrome.connected ? '' : 'offline',
    typeof chrome.battery === 'number' ? `${chrome.battery}%` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    id: CONTAINER.header,
    name: 'hdr',
    x: 0,
    y: LAYOUT.header.y,
    width: DISPLAY.width,
    height: LAYOUT.header.height,
    padding: LAYOUT.padding,
    brightness: BRIGHTNESS.chrome,
    content: spread(fit(left, BODY_WIDTH - 80), right, BODY_WIDTH),
  };
}

function body(content: string): TextSpec {
  return {
    id: CONTAINER.body,
    name: 'body',
    x: 0,
    y: LAYOUT.body.y,
    width: DISPLAY.width,
    height: LAYOUT.body.height,
    padding: LAYOUT.padding,
    brightness: BRIGHTNESS.body,
    // The event-capture layer must be the one the user scrolls.
    capture: true,
    // An empty string is rejected by the firmware; a single space is not.
    content: content === '' ? ' ' : content,
  };
}

function footer(content: string): TextSpec {
  return {
    id: CONTAINER.footer,
    name: 'ftr',
    x: 0,
    y: LAYOUT.footer.y,
    width: DISPLAY.width,
    height: LAYOUT.footer.height,
    padding: LAYOUT.padding,
    brightness: BRIGHTNESS.dim,
    content: content === '' ? ' ' : content,
  };
}

function page(top: string, middle: string, bottom: string, chrome: Chrome): PageSpec {
  return {
    containers: [header(top, chrome), body(middle), footer(bottom)],
    menu: menuItems(chrome.mode),
  };
}

/**
 * Sources get their own trailing page.
 *
 * Hostnames only — a full URL wraps across three lines and cannot be tapped
 * anyway. The phone panel carries the real links.
 */
export function sourcesPage(sources: SourceRef[]): string {
  return ['Sources:', ...sources.map((s) => fit(`- ${s.host}  ${s.title}`, BODY_WIDTH))].join('\n');
}

/* ------------------------------------------------------------------ *
 * Photo feed
 * ------------------------------------------------------------------ */

/**
 * The image container, centred on the display.
 *
 * 288x144 is the firmware maximum for a single image container, which is half
 * the 576x288 canvas. Filling the whole display would mean tiling four
 * containers and paying four serial BLE pushes per photo.
 */
export const PHOTO_BOX = {
  width: 288,
  height: 144,
  x: Math.round((DISPLAY.width - 288) / 2),
  y: 32,
} as const;

const PHOTO_CONTAINER = { image: 10, caption: 11 } as const;

export const photoImageSpec: ImageSpec = {
  id: PHOTO_CONTAINER.image,
  name: 'photo',
  x: PHOTO_BOX.x,
  y: PHOTO_BOX.y,
  width: PHOTO_BOX.width,
  height: PHOTO_BOX.height,
  // z-order is all-or-nothing per page, so every container on this page sets it.
  zOrder: 3,
};

/**
 * Credit line.
 *
 * Unsplash's API terms require a visible credit to the photographer and to
 * Unsplash. The HUD cannot carry a tappable link, so it shows the names and the
 * phone panel carries the linked attribution with the required UTM parameters.
 */
function photoCaption(card: PhotoCard | undefined, status: string): string {
  if (!card) return status;

  const lines = [];
  if (card.description) lines.push(fit(card.description, BODY_WIDTH));
  lines.push(fit(`photo: ${card.photographer} / Unsplash`, BODY_WIDTH));
  if (status) lines.push(status);
  return lines.join('\n');
}

/** "15:40" in the wearer's own zone — the display has no room for more. */
function clock(iso: string, timeZone: string, allDay: boolean): string {
  if (allDay) return 'all day';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Calendar date in a specific zone, as YYYY-MM-DD. */
function dayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * '', 'tmrw ' or a weekday prefix.
 *
 * Comparison happens in the account's zone rather than the phone's, so a wearer
 * who has just landed does not see yesterday's events labelled "today".
 */
function dayLabel(iso: string, timeZone: string): string {
  const start = new Date(iso);
  const now = new Date();

  const startKey = dayKey(start, timeZone);
  if (startKey === dayKey(now, timeZone)) return '';
  if (startKey === dayKey(new Date(now.getTime() + 86_400_000), timeZone)) return 'tmrw ';

  try {
    return `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(start)} `;
  } catch {
    return '';
  }
}

const TYPE_MARK: Record<string, string> = {
  hotel: '[H]',
  flight: '[F]',
  train: '[T]',
  bus: '[B]',
  car_rental: '[C]',
  restaurant: '[R]',
  delivery: '[D]',
};

export function agendaLine(item: AgendaItem, timeZone: string): string {
  const mark = item.bookingType ? `${TYPE_MARK[item.bookingType] ?? '[*]'} ` : '';
  const when = `${dayLabel(item.start, timeZone)}${clock(item.start, timeZone, item.allDay)}`;
  return fit(`${when}  ${mark}${item.title}`, BODY_WIDTH);
}

export interface RenderInput {
  view: View;
  chrome: Chrome;
  timeZone: string;
  voiceEnabled: boolean;
}

/** Maps a view onto the three containers the glasses actually draw. */
export function buildPage({ view, chrome, timeZone, voiceEnabled }: RenderInput): PageSpec {
  const askHint = voiceEnabled ? 'Hold to ask' : 'Menu > Ask';

  switch (view.kind) {
    case 'boot':
      return page('AI Assistant', centre(view.message, BODY_WIDTH), '', chrome);

    case 'pairing':
      return page(
        'Pair your account',
        [
          'Open this on your phone:',
          view.url,
          '',
          `Code: ${view.code}`,
          '',
          view.note,
        ].join('\n'),
        'Waiting for sign-in...',
        chrome,
      );

    case 'agenda': {
      if (view.items.length === 0) {
        return page(
          'Nothing scheduled',
          centre('Your calendar is clear.', BODY_WIDTH),
          `${askHint}  -  double-tap to exit`,
          chrome,
        );
      }

      const perPage = BODY_LINES;
      const totalPages = Math.max(1, Math.ceil(view.items.length / perPage));
      const current = Math.min(view.page, totalPages - 1);
      const slice = view.items.slice(current * perPage, current * perPage + perPage);

      const next = view.items[0];
      const title = next ? `Next: ${next.relative}` : 'Agenda';
      const indicator = totalPages > 1 ? `  ${current + 1}/${totalPages}` : '';

      return page(
        title,
        slice.map((item) => agendaLine(item, timeZone)).join('\n'),
        `${view.note ?? askHint}${indicator}`,
        chrome,
      );
    }

    case 'listening':
      return page(
        'Listening',
        centre(`${'-'.repeat(Math.min(30, view.seconds * 2 + 1))}`, BODY_WIDTH),
        'Release to send',
        chrome,
      );

    case 'working':
      return page('Thinking', centre(view.step, BODY_WIDTH), 'Working...', chrome);

    case 'answer': {
      // Sources, when there are any, ride along as one extra page.
      const pages =
        view.sources && view.sources.length > 0
          ? [...view.pages, sourcesPage(view.sources)]
          : view.pages;

      const totalPages = Math.max(1, pages.length);
      const current = Math.min(view.page, totalPages - 1);
      const indicator = totalPages > 1 ? `  ${current + 1}/${totalPages}` : '';

      return page(
        fit(view.question, BODY_WIDTH - 60),
        pages[current] ?? '',
        `${totalPages > 1 ? 'Swipe to read' : askHint}${indicator}`,
        chrome,
      );
    }

    case 'notification':
      return page(
        fit(view.notification.title, BODY_WIDTH - 60),
        view.notification.body,
        'Tap to dismiss',
        chrome,
      );

    case 'message':
      return page(view.title, view.body, `${askHint}  -  double-tap to exit`, chrome);

    case 'photos': {
      const card = view.cards[view.index];
      const counter = view.cards.length > 0 ? `${view.index + 1}/${view.cards.length}` : '';

      const status =
        view.status === 'loading'
          ? 'Loading the feed...'
          : view.status === 'pushing'
            ? 'Drawing...'
            : view.status === 'error'
              ? (view.message ?? 'Could not load the photo.')
              : 'Swipe to browse';

      return {
        containers: [
          // Full-bleed capture layer: image containers never receive events, so
          // this sits behind the photo and takes every gesture.
          {
            id: CONTAINER.body,
            name: 'photoevt',
            x: 0,
            y: 0,
            width: DISPLAY.width,
            height: DISPLAY.height,
            padding: 0,
            capture: true,
            content: ' ',
            zOrder: 1,
          },
          { ...header('Photos', chrome), content: spread('Photos', counter, BODY_WIDTH), zOrder: 2 },
          {
            id: PHOTO_CONTAINER.caption,
            name: 'photocap',
            x: 0,
            y: PHOTO_BOX.y + PHOTO_BOX.height + 8,
            width: DISPLAY.width,
            height: DISPLAY.height - (PHOTO_BOX.y + PHOTO_BOX.height + 8),
            padding: LAYOUT.padding,
            brightness: BRIGHTNESS.chrome,
            content: photoCaption(card, status),
            zOrder: 4,
          },
        ],
        images: [photoImageSpec],
        menu: menuItems(chrome.mode),
      };
    }
  }
}
