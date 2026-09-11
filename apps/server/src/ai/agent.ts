import Anthropic from '@anthropic-ai/sdk';
import type {
  AgendaItem,
  AssistantAnswer,
  AssistantMode,
  AssistantStep,
  ClientContext,
  SourceRef,
} from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { clientForUser } from '../google/oauth.js';
import type { Store, UserRecord } from '../store/index.js';
import { hasCyrillic, sanitizeForGlasses, transliterate, truncate } from '../util/text.js';
import { uuid } from '../util/id.js';
import { anthropicFor, describeApiError } from './anthropic.js';
import { ASSISTANT_SYSTEM, NO_WEB_ADDENDUM, WEB_ADDENDUM, buildContextBlock } from './prompts.js';
import { ASSISTANT_TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools/index.js';

const log = logger('agent');

/** Ceiling on a single tool result handed back to the model. */
const TOOL_RESULT_CHAR_LIMIT = 12_000;
/** Hard ceiling on the text we send to the glasses. */
const ANSWER_CHAR_LIMIT = 700;
/** Conversation turns kept across questions. Enough for "and the one after that?". */
const HISTORY_TURN_LIMIT = 12;
/** Sources shown; the HUD has room for a handful at most. */
const SOURCE_LIMIT = 5;

export interface AskOptions {
  store: Store;
  user: UserRecord;
  question: string;
  conversationId?: string;
  context?: ClientContext;
  /** Overrides the account default for this question. */
  mode?: AssistantMode;
}

/** Per-mode budgets. `deep` waits on web round-trips, so it gets more room. */
function budgetFor(mode: AssistantMode): {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxIterations: number;
  timeoutMs: number;
} {
  const cfg = loadConfig();
  return mode === 'deep'
    ? {
        effort: cfg.deepEffort,
        maxIterations: cfg.deepMaxAgentIterations,
        timeoutMs: cfg.deepAgentTimeoutMs,
      }
    : {
        effort: cfg.assistantEffort,
        maxIterations: cfg.maxAgentIterations,
        timeoutMs: cfg.agentTimeoutMs,
      };
}

/**
 * The tool set for a mode.
 *
 * Order is fixed and the local tools always come first: tool definitions render
 * before everything else in the request, so a stable prefix keeps the cache warm.
 */
function toolsFor(mode: AssistantMode, timeZone: string): Anthropic.Beta.BetaToolUnion[] {
  const cfg = loadConfig();

  const local = ASSISTANT_TOOLS.map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    input_schema: t.spec.input_schema,
  })) as Anthropic.Beta.BetaToolUnion[];

  if (mode !== 'deep') return local;

  const blocked = cfg.webBlockedDomains;

  return [
    ...local,
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: cfg.webMaxUses,
      // Coordinates would need a reverse-geocode round trip on every question;
      // the timezone alone is enough to localise most results.
      user_location: { type: 'approximate', timezone: timeZone },
      ...(blocked.length > 0 ? { blocked_domains: blocked } : {}),
    },
    {
      type: 'web_fetch_20260209',
      name: 'web_fetch',
      max_uses: cfg.webMaxUses,
      // Whole articles would blow the latency budget for one line of HUD text.
      max_content_tokens: 20_000,
      ...(blocked.length > 0 ? { blocked_domains: blocked } : {}),
    },
  ] satisfies Anthropic.Beta.BetaToolUnion[];
}

function stringifyToolContent(content: unknown): string {
  const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 0);
  return truncate(raw ?? '', TOOL_RESULT_CHAR_LIMIT);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Pulls the pages the model actually consulted out of one response.
 *
 * Search results arrive as an array under `web_search_tool_result`; a failed
 * search puts an error object there instead, hence the array check.
 */
export function collectSources(content: Anthropic.Beta.BetaContentBlock[], into: SourceRef[]): void {
  for (const block of content) {
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) continue;
      for (const result of block.content) {
        into.push({ title: result.title, url: result.url, host: hostOf(result.url) });
      }
      continue;
    }

    if (block.type === 'web_fetch_tool_result') {
      const fetched = block.content;
      if ('url' in fetched && typeof fetched.url === 'string') {
        into.push({ title: hostOf(fetched.url), url: fetched.url, host: hostOf(fetched.url) });
      }
    }
  }
}

/** Server-side tool calls are invisible otherwise; surface them in the trace. */
export function collectServerSteps(
  content: Anthropic.Beta.BetaContentBlock[],
  into: AssistantStep[],
): void {
  for (const block of content) {
    if (block.type !== 'server_tool_use') continue;

    const query = (block.input as { query?: string; url?: string } | undefined)?.query;
    const url = (block.input as { query?: string; url?: string } | undefined)?.url;

    into.push({
      tool: block.name,
      summary:
        block.name === 'web_search'
          ? `Searched the web for "${truncate(query ?? '', 40)}"`
          : `Read ${hostOf(url ?? '')}`,
      ok: true,
      durationMs: 0,
    });
  }
}

/**
 * Runs one question to completion.
 *
 * This is a hand-written loop rather than the SDK tool runner because each turn
 * needs per-user tool context (a live Google client, the caller's timezone and
 * location), a shared wall-clock deadline, and a trace of every tool call to
 * echo back onto the HUD. The runner's beta surface does not give us those three
 * together, and it does not auto-resume `pause_turn`, which server-side web
 * tools produce routinely.
 */
export async function ask(opts: AskOptions): Promise<AssistantAnswer> {
  const cfg = loadConfig();
  const started = Date.now();

  const mode: AssistantMode = opts.mode ?? opts.user.mode ?? 'fast';
  const budget = budgetFor(mode);
  const deadline = started + budget.timeoutMs;

  const conversationId = opts.conversationId ?? uuid();
  const timeZone = opts.context?.timeZone || opts.user.timeZone || 'UTC';

  // Resolve the key before doing any work, so a missing key fails immediately
  // with a message the wearer can act on.
  const { client } = anthropicFor(opts.store, opts.user);

  const toolCtx: ToolContext = {
    store: opts.store,
    user: opts.user,
    auth: clientForUser(opts.store, opts.user),
    timeZone,
    location: opts.context?.location,
    log: log.child(opts.user.email),
    deadline,
  };

  const prior = opts.store.getConversation(conversationId, opts.user.id);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...((prior?.messages ?? []) as Anthropic.Beta.BetaMessageParam[]),
    { role: 'user', content: opts.question },
  ];

  const steps: AssistantStep[] = [];
  const items: AgendaItem[] = [];
  const sources: SourceRef[] = [];
  let answer = '';
  let truncated = false;
  let model = cfg.assistantModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let webSearches = 0;
  let webFetches = 0;

  const tools = toolsFor(mode, timeZone);

  // Both halves of the prefix are constant per mode, so each mode keeps its own
  // warm cache; the volatile context block goes after the breakpoint.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: ASSISTANT_SYSTEM },
    {
      type: 'text',
      text: mode === 'deep' ? WEB_ADDENDUM : NO_WEB_ADDENDUM,
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: buildContextBlock(opts.user, opts.context) },
  ];

  for (let iteration = 0; iteration < budget.maxIterations; iteration++) {
    if (Date.now() > deadline) {
      truncated = true;
      log.warn(`deadline hit after ${iteration} iteration(s) in ${mode} mode`);
      break;
    }

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: cfg.assistantModel,
        max_tokens: 16_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: budget.effort },
        system,
        tools,
        messages,
        ...(cfg.refusalFallback
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      });
    } catch (err) {
      log.error('model call failed', err);
      throw new Error(describeApiError(err));
    }

    model = response.model;
    inputTokens += response.usage.input_tokens ?? 0;
    outputTokens += response.usage.output_tokens ?? 0;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    webSearches += response.usage.server_tool_use?.web_search_requests ?? 0;
    webFetches += response.usage.server_tool_use?.web_fetch_requests ?? 0;

    collectServerSteps(response.content, steps);
    collectSources(response.content, sources);

    if (response.stop_reason === 'refusal') {
      answer = 'I can\'t help with that one. Try asking it a different way.';
      break;
    }

    // A server-side tool ran out of its own iteration budget: echo the turn back
    // unchanged so it can carry on where it stopped.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      answer = text;
      if (response.stop_reason === 'max_tokens') truncated = true;
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    // Independent calls in one turn run concurrently; results go back in a
    // single user message so the model keeps batching them.
    const results = await Promise.all(
      toolUses.map(async (use): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const tool = TOOLS_BY_NAME.get(use.name);
        const callStarted = Date.now();

        if (!tool) {
          steps.push({ tool: use.name, summary: 'Unknown tool', ok: false, durationMs: 0 });
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `No tool named ${use.name} exists.`,
          };
        }

        try {
          const input = (use.input ?? {}) as Record<string, unknown>;
          const result = await tool.handler(input, toolCtx);

          steps.push({
            tool: use.name,
            summary: result.summary,
            ok: !result.isError,
            durationMs: Date.now() - callStarted,
          });
          if (result.items) items.push(...result.items);

          return {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: result.isError ?? false,
            content: stringifyToolContent(result.content),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`tool ${use.name} threw`, err);
          steps.push({
            tool: use.name,
            summary: `Failed: ${truncate(message, 60)}`,
            ok: false,
            durationMs: Date.now() - callStarted,
          });
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Tool failed: ${truncate(message, 400)}`,
          };
        }
      }),
    );

    messages.push({ role: 'user', content: results });

    if (iteration === budget.maxIterations - 1) {
      truncated = true;
      log.warn(`hit the ${budget.maxIterations}-iteration cap in ${mode} mode`);
    }
  }

  if (!answer) {
    answer = truncated
      ? 'That took longer than I have. Ask me again, or narrow it down.'
      : 'I could not work that one out.';
  }

  let shaped = sanitizeForGlasses(answer);
  if (cfg.transliterateOutput && hasCyrillic(shaped)) shaped = transliterate(shaped);
  const finalAnswer =
    shaped.length > ANSWER_CHAR_LIMIT ? truncate(shaped, ANSWER_CHAR_LIMIT) : shaped;

  // Persist the thread, trimmed — a HUD conversation does not need deep history.
  messages.push({ role: 'assistant', content: finalAnswer });
  opts.store.saveConversation(conversationId, opts.user.id, messages.slice(-HISTORY_TURN_LIMIT));

  return {
    conversationId,
    question: opts.question,
    answer: finalAnswer,
    steps,
    items: dedupeItems(items).slice(0, 8),
    sources: dedupeSources(sources).slice(0, SOURCE_LIMIT),
    meta: {
      model,
      mode,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      webSearches,
      webFetches,
      latencyMs: Date.now() - started,
      truncated: truncated || shaped.length > ANSWER_CHAR_LIMIT,
    },
  };
}

function dedupeItems(items: AgendaItem[]): AgendaItem[] {
  const seen = new Set<string>();
  const out: AgendaItem[] = [];
  for (const item of items) {
    const key = `${item.id}|${item.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
  }
  return out;
}
