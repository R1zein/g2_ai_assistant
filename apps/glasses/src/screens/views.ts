import type { AgendaItem, AssistantMode, AssistantNotification, SourceRef } from '@g2/shared';

/** Everything the glasses can be showing. Rendering is a pure function of this. */
export type View =
  | { kind: 'boot'; message: string }
  | { kind: 'pairing'; code: string; url: string; note: string }
  | { kind: 'agenda'; items: AgendaItem[]; page: number; note?: string }
  | { kind: 'listening'; seconds: number }
  | { kind: 'working'; step: string }
  | { kind: 'answer'; question: string; pages: string[]; page: number; sources?: SourceRef[] }
  | { kind: 'notification'; notification: AssistantNotification }
  | { kind: 'message'; title: string; body: string };

export interface Chrome {
  battery?: number;
  connected: boolean;
  /** Set while a request is in flight, so the header can show it. */
  busy?: boolean;
  /** Shown in the header so the wearer knows whether the web is in play. */
  mode: AssistantMode;
}

/** Contextual-menu action ids, shared between the menu spec and the handler. */
export const MENU = {
  ask: 1,
  agenda: 2,
  brief: 3,
  toggleMode: 4,
  syncMail: 5,
  account: 6,
  exit: 7,
} as const;

export type MenuAction = (typeof MENU)[keyof typeof MENU];
