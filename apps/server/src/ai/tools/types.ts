import type Anthropic from '@anthropic-ai/sdk';
import type { OAuth2Client } from 'google-auth-library';
import type { AgendaItem } from '@g2/shared';
import type { Logger } from '../../logger.js';
import type { Store, UserRecord } from '../../store/index.js';

export interface ToolContext {
  store: Store;
  user: UserRecord;
  auth: OAuth2Client;
  /** IANA zone the answer should be phrased in. */
  timeZone: string;
  location?: { latitude: number; longitude: number; accuracy?: number };
  log: Logger;
  /** Deadline for the whole question, so slow tools can bail early. */
  deadline: number;
}

export interface ToolResult {
  /** One short line for the "Checking calendar…" trace on the HUD. */
  summary: string;
  /** Payload handed back to the model. Objects are JSON-stringified. */
  content: unknown;
  isError?: boolean;
  /** Rows worth rendering as a list on the glasses instead of prose. */
  items?: AgendaItem[];
}

export interface AssistantTool {
  spec: Anthropic.Tool;
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Small helper: every tool schema is closed and fully required for `strict`. */
export function toolSpec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Anthropic.Tool {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties: properties as Anthropic.Tool.InputSchema['properties'],
      required,
      additionalProperties: false,
    },
  };
}
