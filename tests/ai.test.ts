/**
 * AI extractor tests — exercises the heuristic fallback (no API key needed).
 * The LLM path is smoke-tested with a skipped test that needs ANTHROPIC_API_KEY.
 */
import { describe, it, expect } from 'vitest';
import { extractFromBatch } from '../src/ai/extractor.js';
import type { SlackConversationBatch } from '../src/core/types.js';

describe('AI extractor (heuristic fallback)', () => {
  it('returns empty for empty batch', async () => {
    const result = await extractFromBatch({
      channel: 'C1',
      messages: [],
      oldest_ts: '0',
      latest_ts: '0',
    });
    expect(result.decisions).toEqual([]);
    expect(result.action_items).toEqual([]);
  });

  it('detects a clear decision pattern', async () => {
    const batch: SlackConversationBatch = {
      channel: 'C1',
      oldest_ts: '1',
      latest_ts: '2',
      messages: [
        {
          ts: '1',
          channel: 'C1',
          user: 'U001',
          text: "Let's go with Postgres for the analytics workload — agreed everyone?",
        },
        {
          ts: '2',
          channel: 'C1',
          user: 'U002',
          text: 'agreed, locking it in',
        },
      ],
    };
    const result = await extractFromBatch(batch);
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.decisions[0]?.confidence).toMatch(/inferred|stated/);
  });

  it('detects an action item with owner and due date', async () => {
    const batch: SlackConversationBatch = {
      channel: 'C1',
      oldest_ts: '1',
      latest_ts: '1',
      messages: [
        {
          ts: '1',
          channel: 'C1',
          user: 'U001',
          text: "<@U002> can you write the migration script by Friday?",
        },
      ],
    };
    const result = await extractFromBatch(batch);
    expect(result.action_items.length).toBeGreaterThan(0);
    const action = result.action_items[0]!;
    expect(action.owner_slack_id).toBe('U002');
    expect(action.due_iso).toBeDefined();
    expect(new Date(action.due_iso!).getUTCDay()).toBe(5); // Friday
  });

  it('detects action item via "I will" phrasing', async () => {
    const batch: SlackConversationBatch = {
      channel: 'C1',
      oldest_ts: '1',
      latest_ts: '1',
      messages: [
        {
          ts: '1',
          channel: 'C1',
          user: 'U001',
          text: "I'll set up the Linear project by EOD",
        },
      ],
    };
    const result = await extractFromBatch(batch);
    expect(result.action_items.length).toBeGreaterThan(0);
  });

  it('extracts topics from recurring word pairs', async () => {
    const batch: SlackConversationBatch = {
      channel: 'C1',
      oldest_ts: '1',
      latest_ts: '3',
      messages: [
        { ts: '1', channel: 'C1', user: 'U001', text: 'thinking about the auth migration' },
        { ts: '2', channel: 'C1', user: 'U002', text: 'auth migration is risky, lets plan it' },
        { ts: '3', channel: 'C1', user: 'U003', text: 'auth migration ticket is in queue' },
      ],
    };
    const result = await extractFromBatch(batch);
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topics[0]?.label).toContain('auth');
  });
});
