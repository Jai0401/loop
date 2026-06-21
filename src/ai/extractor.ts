/**
 * AI extraction — Loop's "brain" for converting Slack conversations into
 * structured memory entries (decisions + action items + topics).
 *
 * LLM-only: relies on the Anthropic Claude tool-use feature. The model is
 * forced to return a strongly-typed JSON payload via the `record_extraction`
 * tool, validated with Zod before storage.
 *
 * No regex fallbacks — if the LLM is unavailable or fails, extraction is
 * skipped (empty result). Loop is a smart agent; degraded extraction is
 * worse than no extraction (creates noise).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import type {
  ExtractionResult,
  SlackConversationBatch,
} from '../core/types.js';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required for AI extraction');
  }
  // Pass the token as apiKey so the SDK sends it as `x-api-key` (MiniMax proxy expects this).
  _client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? 'placeholder',
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
  });
  return _client;
}

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

  try {
    return await llmExtract(batch, opts);
  } catch (err) {
    logger.error({ err }, 'AI: extraction failed — returning empty result');
    return { decisions: [], action_items: [], topics: [] };
  }
}

/* ----------------------------- LLM path ----------------------------- */

const SYSTEM_PROMPT = `You are Loop — a precise, conservative memory agent for Slack teams.

Your job: read a batch of Slack messages and extract structured memory entries.

Rules:
1. ONLY extract things that were genuinely decided or committed to — not idle chatter, status updates, bug reports, or questions.
2. A "decision" must reflect a real commitment by the team, not a question, option list, or pending discussion.
3. An "action item" must have a clear owner (the person who said "I'll do X", or who was @-mentioned with intent to do it). If no owner is identifiable, set owner_slack_id to null and lower confidence.
4. Due dates: parse relative dates ("by Friday", "EOD", "next sprint") to ISO 8601 UTC. If ambiguous, omit.
5. Be conservative on confidence:
   - 0.9+ = explicit, unambiguous statement
   - 0.6-0.8 = clear intent but slightly indirect
   - <0.6 = inference; only include if high-signal
6. Topics should be 1-3 word noun phrases capturing the thread's subject (e.g., "Q3 roadmap", "auth migration", "Stripe integration").
7. Always include source_message_ts from the message you extracted from.

Return your extraction by calling the record_extraction tool with structured JSON. Do not write prose.`;

async function llmExtract(
  batch: SlackConversationBatch,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  const userPrompt = renderBatch(batch);

  const response = await client().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'record_extraction',
        description:
          'Record the structured extraction of decisions, action items, and topics from the Slack conversation batch.',
        input_schema: zodToJsonSchema(ExtractionSchema) as Anthropic.Tool.InputSchema,
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

function renderBatch(batch: SlackConversationBatch): string {
  const lines = batch.messages.map((m) => {
    const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (thread ${m.thread_ts})` : '';
    return `[${m.ts}] <@${m.user}>${thread}: ${m.text}`;
  });
  return `Channel: <#${batch.channel}>\nWindow: ${batch.oldest_ts} → ${batch.latest_ts}\n\n${lines.join('\n')}`;
}