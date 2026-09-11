import { calendarTools } from './calendarTools.js';
import { contextTools } from './contextTools.js';
import { mailTools } from './mailTools.js';
import { reminderTools } from './reminderTools.js';
import type { AssistantTool } from './types.js';

export * from './types.js';
export { toAgendaItem } from './calendarTools.js';

/**
 * The assistant's tool surface, in a fixed order.
 *
 * Order matters: tool definitions are the first thing rendered into the request,
 * so a stable array keeps the prompt-cache prefix intact across requests.
 */
export const ASSISTANT_TOOLS: AssistantTool[] = [
  ...calendarTools,
  ...mailTools,
  ...contextTools,
  ...reminderTools,
];

export const TOOLS_BY_NAME = new Map<string, AssistantTool>(
  ASSISTANT_TOOLS.map((t) => [t.spec.name, t]),
);
