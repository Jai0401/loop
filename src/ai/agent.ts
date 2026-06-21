/**
 * Loop Agent — the conversational brain.
 *
 * When a user @-mentions Loop (or uses /loop), this agent is invoked with:
 *   - the user's natural-language query
 *   - recent channel context (so it understands what's being discussed)
 *   - a set of tools it can call against Loop's memory layer
 *
 * The agent loops: LLM → tool_use → execute → LLM again → … → final answer.
 * It converses in natural language and decides autonomously what to do
 * (search, list, record, summarize, or just chat).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import {
  createAction,
  createDecision,
  findSimilarDecisions,
  listActions,
  listDecisions,
  searchDecisionsFts,
  upsertChannel,
  upsertTeam,
  upsertUser,
} from '../storage/repo.js';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required');
  }
  // The MiniMax proxy expects the token in the x-api-key header (not Authorization).
  // Anthropic SDK sends authToken as Authorization Bearer — so we pass the token as apiKey.
  // If a real ANTHROPIC_API_KEY is set, prefer that (standard API key path).
  _client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? 'placeholder',
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
  });
  return _client;
}

/* ----------------------------- Public API ----------------------------- */

export interface AgentContext {
  team_id: string;
  channel_id: string;
  user_id: string;        // Slack user id of the person who invoked
  user_name: string;      // display name
  recent_messages: Array<{ ts: string; user: string; text: string }>;
}

export interface AgentResult {
  response: string;
  tool_calls: Array<{ name: string; input: unknown; output: unknown }>;
}

export interface AgentOptions {
  max_tool_rounds?: number;
  verbose?: boolean;
}

const SYSTEM_PROMPT = `You are Loop — an intelligent memory agent for Slack teams. You watch conversations, remember decisions and action items, surface relevant past context, and help teams stay aligned.

Your personality:
- Concise but warm
- Proactive — if you notice something relevant in past memory, surface it
- Honest — if you don't know or can't find something, say so

You have these tools available. Use them when the user's intent calls for it:

- search_decisions(query): semantic search of past team decisions
- list_actions(status?): list action items (status: open | in_progress | overdue | done | cancelled)
- record_decision(summary, rationale?): manually save a new decision
- record_action(title, owner_slack_id?, due_iso?, priority?): manually save an action item
- summarize_digest(): generate a digest of recent decisions + open actions

When the user asks a question:
- "what did we decide about X" → call search_decisions
- "summarize this channel" or "give me a digest" → call summarize_digest (you can use list_actions + list_decisions directly too)
- "we decided Y" → call record_decision
- "X needs to be done by Friday" → call record_action
- "what action items are open" → call list_actions

When you respond:
- Use Slack mrkdwn formatting (*bold*, _italic_, \`code\`, > quote, • bullets)
- Don't announce tool calls — just use them and respond naturally
- Reference source messages when relevant so the user can dig deeper
- Keep responses under 1500 chars when possible
- If no tools are needed (small talk, thanks), just respond conversationally`;

/* ----------------------------- Tool definitions ----------------------------- */

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_decisions',
    description:
      'Search the team\'s past decisions semantically and by keyword. Use when the user asks "what did we decide about X" or wants to find prior context.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query (e.g. "auth migration", "database choice", "billing decisions")',
        },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_actions',
    description:
      'List action items, optionally filtered by status. Use when the user asks what needs to be done, who owes what, or wants a status check.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'overdue', 'done', 'cancelled', 'all'],
          description: 'Filter by status. "open" returns open + in_progress + overdue.',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'record_decision',
    description: 'Manually record a decision on behalf of the user. Use when the user explicitly says "we decided X" or "record this decision".',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '1-2 sentence decision summary' },
        rationale: { type: 'string', description: 'Why this was decided (optional)' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'record_action',
    description: 'Manually record an action item on behalf of the user.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What needs to be done' },
        owner_slack_id: { type: 'string', description: 'Slack user id (U...) of the owner, if known' },
        due_iso: { type: 'string', description: 'ISO 8601 due date/time, if mentioned' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'summarize_digest',
    description:
      'Generate a digest of recent decisions + open action items. Use when the user asks for a summary, recap, or status overview.',
    input_schema: {
      type: 'object',
      properties: {
        decisions_limit: { type: 'number' },
        actions_limit: { type: 'number' },
      },
    },
  },
];

/* ----------------------------- Main agent loop ----------------------------- */

export async function runAgent(
  query: string,
  ctx: AgentContext,
  opts: AgentOptions = {},
): Promise<AgentResult> {
  const maxRounds = opts.max_tool_rounds ?? 4;
  const toolCalls: AgentResult['tool_calls'] = [];

  // Ensure team/channel/user rows exist so FK constraints don't bite.
  upsertTeam(ctx.team_id, 'unknown');
  upsertChannel({ slack_channel_id: ctx.channel_id, slack_team_id: ctx.team_id, name: ctx.channel_id });
  upsertUser({ slack_user_id: ctx.user_id, slack_team_id: ctx.team_id, display_name: ctx.user_name });

  const contextBlock =
    ctx.recent_messages.length === 0
      ? ''
      : `\n\nRecent channel context (most recent last):\n${ctx.recent_messages
          .slice(-15)
          .map((m) => `[${m.ts}] <@${m.user}>: ${m.text}`)
          .join('\n')}`;

  const userMessage = `<@${ctx.user_id}> asked: ${query}${contextBlock}`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  for (let round = 0; round < maxRounds; round++) {
    const response = await client().messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Find text blocks (final answer) and tool_use blocks (continue looping)
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    const toolUses = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      if (opts.verbose) logger.info({ round, text_len: text.length, usage: response.usage }, 'agent: final answer');
      return { response: text || '_(no response)_', tool_calls: toolCalls };
    }

    // Push assistant turn onto message history
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool call, build tool_result blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = tu.input as Record<string, unknown>;
      const output = await executeTool(tu.name, input, ctx);
      toolCalls.push({ name: tu.name, input, output });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(output),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Hit max rounds — best-effort final answer
  logger.warn({ round: maxRounds }, 'agent: max tool rounds reached');
  const final = await client().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT + '\n\nYou have hit your tool-call budget. Give a final answer based on what you have.',
    tools: TOOLS,
    messages,
  });
  const finalText = final.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { response: finalText || '_(no response)_', tool_calls: toolCalls };
}

/* ----------------------------- Tool execution ----------------------------- */

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<unknown> {
  try {
    switch (name) {
      case 'search_decisions': {
        const query = String(input.query ?? '');
        const limit = Math.min(Number(input.limit ?? 5), 20);
        const results = findSimilarDecisions(ctx.team_id, query, limit);
        // Also include FTS hits for keyword coverage
        const fts = searchDecisionsFts(ctx.team_id, query, limit);
        const merged = dedupeById([...results, ...fts]).slice(0, limit);
        return merged.map((d) => ({
          id: d.id,
          summary: d.summary,
          confidence: d.confidence,
          created_at: d.created_at,
          channel_id: d.channel_id,
          source_message_ts: d.source_message_ts,
          ...('score' in d ? { score: d.score } : {}),
        }));
      }
      case 'list_actions': {
        const status = String(input.status ?? 'open');
        const limit = Math.min(Number(input.limit ?? 20), 100);
        const statusFilter: Array<'open' | 'in_progress' | 'overdue' | 'done' | 'cancelled'> =
          status === 'open'
            ? ['open', 'in_progress', 'overdue']
            : status === 'all'
              ? ['open', 'in_progress', 'overdue', 'done', 'cancelled']
              : [status as 'open' | 'in_progress' | 'overdue' | 'done' | 'cancelled'];
        const actions = listActions({ team_id: ctx.team_id, status: statusFilter, limit });
        return actions.map((a) => ({
          id: a.id,
          title: a.title,
          owner_user_id: a.owner_user_id,
          due_at: a.due_at,
          status: a.status,
          priority: a.priority,
          channel_id: a.channel_id,
          source_message_ts: a.source_message_ts,
        }));
      }
      case 'record_decision': {
        const summary = String(input.summary ?? '').trim();
        const rationale = input.rationale ? String(input.rationale) : undefined;
        if (!summary) return { error: 'summary required' };
        const d = createDecision({
          team_id: ctx.team_id,
          channel_id: ctx.channel_id,
          summary,
          rationale,
          participants: [ctx.user_id],
          confidence: 'stated',
          source_message_ts: 'agent',
        });
        return { ok: true, id: d.id, summary: d.summary };
      }
      case 'record_action': {
        const title = String(input.title ?? '').trim();
        const owner = input.owner_slack_id ? String(input.owner_slack_id) : undefined;
        const due = input.due_iso ? String(input.due_iso) : undefined;
        const priority = (input.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined) ?? 'medium';
        if (!title) return { error: 'title required' };
        const a = createAction({
          team_id: ctx.team_id,
          channel_id: ctx.channel_id,
          title,
          owner_user_id: owner,
          due_at: due,
          priority,
          confidence: 1.0,
          source_message_ts: 'agent',
        });
        return { ok: true, id: a.id, title: a.title };
      }
      case 'summarize_digest': {
        const decisionsLimit = Math.min(Number(input.decisions_limit ?? 10), 50);
        const actionsLimit = Math.min(Number(input.actions_limit ?? 20), 100);
        const decisions = listDecisions(ctx.team_id, decisionsLimit);
        const actions = listActions({
          team_id: ctx.team_id,
          status: ['open', 'in_progress', 'overdue'],
          limit: actionsLimit,
        });
        return {
          generated_at: new Date().toISOString(),
          decisions_count: decisions.length,
          actions_count: actions.length,
          overdue_count: actions.filter((a) => a.status === 'overdue').length,
          decisions: decisions.map((d) => ({ summary: d.summary, confidence: d.confidence, created_at: d.created_at })),
          actions: actions.map((a) => ({ title: a.title, status: a.status, priority: a.priority, due_at: a.due_at })),
        };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    logger.error({ err, tool: name }, 'agent: tool execution failed');
    return { error: String((err as Error).message ?? err) };
  }
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (!seen.has(it.id)) {
      seen.add(it.id);
      out.push(it);
    }
  }
  return out;
}

// Suppress unused-import warnings for types kept for future use
void z;