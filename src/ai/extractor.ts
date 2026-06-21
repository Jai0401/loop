/**
 * AI extraction — Loop's "brain".
 *
 * Input:  a batch of Slack messages (optionally with thread context).
 * Output: structured JSON of decisions, action items, and topics.
 *
 * We use Anthropic's tool-use feature so the model is forced to return a
 * well-typed payload we can validate with Zod. This is dramatically more
 * reliable than parsing free-text JSON from the model.
 *
 * Graceful degradation: if ANTHROPIC_API_KEY is missing we run a heuristic
 * fallback so the rest of the system stays testable in dev.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import type {
  ExtractionResult,
  ExtractedActionItem,
  ExtractedDecision,
  ExtractedTopic,
  SlackConversationBatch,
  SlackMessage,
} from '../core/types.js';

/* ----------------------------- Schemas ----------------------------- */

export const DecisionConfidenceSchema = z.enum(['stated', 'inferred', 'tentative']);

const ExtractionSchema = z.object({
  decisions: z.array(
    z.object({
      summary: z.string().min(3).max(500),
      rationale: z.string().max(500).optional(),
      participant_slack_ids: z.array(z.string().regex(/^U[A-Z0-9]+$/)).default([]),
      confidence: DecisionConfidenceSchema,
      source_message_ts: z.string(),
      evidence_quote: z.string().max(280).optional(),
    }),
  ),
  action_items: z.array(
    z.object({
      title: z.string().min(3).max(200),
      description: z.string().max(500).optional(),
      owner_slack_id: z.string().regex(/^U[A-Z0-9]+$/).optional(),
      due_iso: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
      confidence: z.number().min(0).max(1),
      source_message_ts: z.string(),
      evidence_quote: z.string().max(280).optional(),
    }),
  ),
  topics: z.array(
    z.object({
      label: z.string().min(2).max(60),
      mention_count: z.number().int().min(1).default(1),
    }),
  ),
});

/* ----------------------------- Public API ----------------------------- */

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for AI extraction');
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export interface ExtractOptions {
  /** If true, log every extraction. Off in tests. */
  verbose?: boolean;
}

export async function extractFromBatch(
  batch: SlackConversationBatch,
  opts: ExtractOptions = {},
): Promise<ExtractionResult> {
  if (batch.messages.length === 0) {
    return { decisions: [], action_items: [], topics: [] };
  }

  if (!env.ANTHROPIC_API_KEY) {
    logger.debug('AI: no ANTHROPIC_API_KEY — using heuristic fallback');
    return heuristicExtract(batch);
  }

  try {
    return await llmExtract(batch, opts);
  } catch (err) {
    logger.error({ err }, 'AI: extraction failed, falling back to heuristic');
    return heuristicExtract(batch);
  }
}

/* ----------------------------- LLM path ----------------------------- */

async function llmExtract(
  batch: SlackConversationBatch,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = renderBatch(batch);

  const response = await client().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    tools: [
      {
        name: 'record_extraction',
        description:
          'Record the structured extraction of decisions, action items, and topics from the Slack conversation batch.',
        input_schema: zodToToolSchema(ExtractionSchema) as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: 'record_extraction' },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const toolUse = response.content.find((c) => c.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    logger.warn({ response }, 'AI: model did not call the extraction tool');
    return { decisions: [], action_items: [], topics: [] };
  }

  const parsed = ExtractionSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.flatten(), input: toolUse.input },
      'AI: extraction payload failed validation',
    );
    return { decisions: [], action_items: [], topics: [] };
  }

  if (opts.verbose) {
    logger.info(
      {
        decisions: parsed.data.decisions.length,
        actions: parsed.data.action_items.length,
        topics: parsed.data.topics.length,
        usage: response.usage,
      },
      'AI: extraction complete',
    );
  }

  return parsed.data as ExtractionResult;
}

/* ----------------------------- Heuristic fallback ----------------------------- */

/**
 * Cheap regex/keyword-based extractor. Used when ANTHROPIC_API_KEY is missing
 * OR when the LLM call fails. Intentionally conservative — we'd rather miss
 * a decision than hallucinate one.
 */
function heuristicExtract(batch: SlackConversationBatch): ExtractionResult {
  const decisions: ExtractedDecision[] = [];
  const action_items: ExtractedActionItem[] = [];
  const topics: ExtractedTopic[] = [];
  const topicCounts = new Map<string, number>();

  const DECISION_PATTERNS = [
    /\b(we(?:'ll| will)?|let's|agreed|decided|decision)\b.*\b(go with|use|ship|launch|adopt|move to|switch to|standardize on)\b/i,
    /\b(approved?|sign(ed)? off|locked in|confirmed)\b/i,
  ];
  const ACTION_PATTERNS = [
    /\b(I|we|you|@?\w+)\s+(will|'ll|should|'ll|can|could|need to|have to|must)\s+(.{8,180}?)(?:\.|$)/i,
    /\b(action item|todo|to-?do|follow[- ]?up|task):\s*(.{8,180})/i,
    /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|eow|next week|\d{1,2}\/\d{1,2})\b/i,
  ];

  for (const msg of batch.messages) {
    const text = msg.text ?? '';

    for (const pat of DECISION_PATTERNS) {
      const match = text.match(pat);
      if (match) {
        decisions.push({
          summary: truncate(firstSentence(extractDecisionSummary(text)), 280) ?? text.slice(0, 280),
          rationale: undefined,
          participant_slack_ids: [msg.user],
          confidence: 'inferred',
          source_message_ts: msg.ts,
          evidence_quote: truncate(text, 200),
        });
        break;
      }
    }

    for (const pat of ACTION_PATTERNS) {
      const match = text.match(pat);
      if (match) {
        const rawTitle = match[2] ?? match[1] ?? text;
        action_items.push({
          title: truncate(rawTitle.trim(), 180) ?? text.slice(0, 180),
          description: undefined,
          owner_slack_id: extractMentionedUser(text),
          due_iso: extractDueDate(text),
          priority: 'medium',
          confidence: 0.5,
          source_message_ts: msg.ts,
          evidence_quote: truncate(text, 200),
        });
        break;
      }
    }

    // Topic = most-frequent non-trivial word pair
    const pair = extractTopicPair(text);
    if (pair) topicCounts.set(pair, (topicCounts.get(pair) ?? 0) + 1);
  }

  for (const [label, count] of topicCounts) {
    if (count >= 2) topics.push({ label, mention_count: count });
  }

  return { decisions, action_items, topics };
}

/* ----------------------------- Prompts ----------------------------- */

const SYSTEM_PROMPT = `You are Loop — a precise, conservative memory agent for Slack teams.

Your job: read a batch of Slack messages and extract structured memory entries.

Rules:
1. ONLY extract things that were genuinely decided or committed to — not idle chatter.
2. A "decision" must reflect a real commitment by the team, not a question or option list.
3. An "action item" must have a clear owner (the person who said "I'll do X", or who was @-mentioned with intent to do it). If no owner is identifiable, set owner_slack_id to null and lower confidence.
4. Due dates: parse relative dates ("by Friday", "EOD", "next sprint") to ISO 8601 UTC. If ambiguous, omit.
5. Be conservative on confidence:
   - 0.9+ = explicit, unambiguous statement
   - 0.6-0.8 = clear intent but slightly indirect
   - <0.6 = inference; only include if high-signal
6. Topics should be 1-3 word noun phrases capturing the thread's subject (e.g., "Q3 roadmap", "auth migration", "Stripe integration").
7. Always include source_message_ts from the message you extracted from.

Return your extraction by calling the record_extraction tool with structured JSON. Do not write prose.`;

function renderBatch(batch: SlackConversationBatch): string {
  const lines = batch.messages.map((m) => {
    const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (thread ${m.thread_ts})` : '';
    return `[${m.ts}] <@${m.user}>${thread}: ${m.text}`;
  });
  return `Channel: <#${batch.channel}>\nWindow: ${batch.oldest_ts} → ${batch.latest_ts}\n\n${lines.join('\n')}`;
}

/* ----------------------------- Helpers ----------------------------- */

function zodToToolSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // zod's native toJSONSchema is in zod v3.23+, but we do a minimal conversion
  // for the subset we use (objects with string/number/enum properties).
  return zodToJsonSchemaInternal(schema);
}

function zodToJsonSchemaInternal(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string; innerType?: z.ZodTypeAny; value?: unknown; values?: unknown };
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchemaInternal(value as z.ZodTypeAny);
        const v = value as z.ZodTypeAny;
        const innerDef = v._def as { typeName?: string; innerType?: z.ZodTypeAny };
        if (innerDef.typeName !== 'ZodOptional' && innerDef.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      return { type: 'object', properties, required };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchemaInternal(def.innerType!) };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: Object.values(def.values as Record<string, string>) };
    case 'ZodOptional':
      return zodToJsonSchemaInternal(def.innerType!);
    case 'ZodDefault':
      return zodToJsonSchemaInternal(def.innerType!);
    case 'ZodNullable':
      return zodToJsonSchemaInternal(def.innerType!);
    default:
      return { type: 'string' };
  }
}

function firstSentence(text: string): string {
  const idx = text.search(/[.!?]\s/);
  return idx > 0 ? text.slice(0, idx + 1) : text;
}

function extractDecisionSummary(text: string): string {
  // take the matched clause or the first 200 chars
  return text.slice(0, 200);
}

function extractMentionedUser(text: string): string | undefined {
  // Slack's canonical format
  const slack = text.match(/<@(U[A-Z0-9]+)>/);
  if (slack) return slack[1];
  // Bare @-mention in plain text
  const bare = text.match(/(?:^|\s)@(U[A-Z0-9]+)/);
  return bare?.[1];
}

function extractDueDate(text: string): string | undefined {
  const lower = text.toLowerCase();
  const now = new Date();
  const dayMap: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  for (const [name, target] of Object.entries(dayMap)) {
    if (lower.includes(`by ${name}`)) {
      const d = new Date(now);
      const diff = (target - d.getUTCDay() + 7) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + diff);
      d.setUTCHours(23, 59, 0, 0);
      return d.toISOString();
    }
  }
  if (lower.includes('by eod')) {
    const d = new Date(now);
    d.setUTCHours(23, 59, 0, 0);
    return d.toISOString();
  }
  if (lower.includes('by eow')) {
    const d = new Date(now);
    const daysToFri = (5 - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysToFri);
    d.setUTCHours(23, 59, 0, 0);
    return d.toISOString();
  }
  return undefined;
}

function extractTopicPair(text: string): string | undefined {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (words.length < 2) return undefined;
  // common-bigram — quick + dirty
  const pairs = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  const sorted = [...pairs.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0];
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
