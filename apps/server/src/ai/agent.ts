import Anthropic from '@anthropic-ai/sdk';
import type { AgendaItem, AssistantAnswer, AssistantStep, ClientContext } from '@g2/shared';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { clientForUser } from '../google/oauth.js';
import type { Store, UserRecord } from '../store/index.js';
import { hasCyrillic, sanitizeForGlasses, transliterate, truncate } from '../util/text.js';
import { uuid } from '../util/id.js';
import { anthropic, describeApiError } from './anthropic.js';
import { ASSISTANT_SYSTEM, buildContextBlock } from './prompts.js';
import { ASSISTANT_TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools/index.js';

const log = logger('agent');

/** Ceiling on a single tool result handed back to the model. */
const TOOL_RESULT_CHAR_LIMIT = 12_000;
/** Hard ceiling on the text we send to the glasses. */
const ANSWER_CHAR_LIMIT = 700;
/** Conversation turns kept across questions. Enough for "and the one after that?". */
const HISTORY_TURN_LIMIT = 12;

export interface AskOptions {
  store: Store;
  user: UserRecord;
  question: string;
  conversationId?: string;
  context?: ClientContext;
}

function toolSpecs(): Anthropic.Beta.BetaToolUnion[] {
  return ASSISTANT_TOOLS.map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    input_schema: t.spec.input_schema,
  })) as Anthropic.Beta.BetaToolUnion[];
}

function stringifyToolContent(content: unknown): string {
  const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 0);
  return truncate(raw ?? '', TOOL_RESULT_CHAR_LIMIT);
}

/**
 * Runs one question to completion.
 *
 * This is a hand-written loop rather than the SDK tool runner because each turn
 * needs per-user tool context (a live Google client, the caller's timezone and
 * location), a shared wall-clock deadline, and a trace of every tool call to
 * echo back onto the HUD. The runner's beta surface does not give us those three
 * together.
 */
export async function ask(opts: AskOptions): Promise<AssistantAnswer> {
  const cfg = loadConfig();
  const started = Date.now();
  const deadline = started + cfg.agentTimeoutMs;

  const conversationId = opts.conversationId ?? uuid();
  const timeZone = opts.context?.timeZone || opts.user.timeZone || 'UTC';

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
  let answer = '';
  let truncated = false;
  let model = cfg.assistantModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for (let iteration = 0; iteration < cfg.maxAgentIterations; iteration++) {
    if (Date.now() > deadline) {
      truncated = true;
      log.warn(`deadline hit after ${iteration} iteration(s)`);
      break;
    }

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await anthropic().beta.messages.create({
        model: cfg.assistantModel,
        max_tokens: 16_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: cfg.assistantEffort },
        system: [
          // Stable prefix carries the cache breakpoint...
          { type: 'text', text: ASSISTANT_SYSTEM, cache_control: { type: 'ephemeral' } },
          // ...volatile state goes after it, so the clock never busts the cache.
          { type: 'text', text: buildContextBlock(opts.user, opts.context) },
        ],
        tools: toolSpecs(),
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

    if (response.stop_reason === 'refusal') {
      answer =
        'I can\'t help with that one. Ask me about your calendar, your bookings or where you are.';
      break;
    }

    // A server-side tool ran out of its own iteration budget: echo the turn back.
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

    if (iteration === cfg.maxAgentIterations - 1) {
      truncated = true;
      log.warn(`hit the ${cfg.maxAgentIterations}-iteration cap`);
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
    meta: {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
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
