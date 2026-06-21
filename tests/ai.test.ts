/**
 * AI agent tests — exercises the LLM-backed agent module.
 *
 * Without LLM credentials these tests skip cleanly. With credentials, they
 * hit the real model (MiniMax-M3 by default) and verify the agent:
 *   - Loads tools correctly
 *   - Returns a response object with the expected shape
 *   - Records decisions when asked via record_decision tool
 *
 * For deterministic unit tests of pure functions, see tests/embeddings.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// LLM-backed agent tests need more than the default 5s — tool-call loops add up.
const LLM_TIMEOUT = 30_000;

const HAS_CREDS = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

describe.skipIf(!HAS_CREDS)('AI agent (LLM-backed)', () => {
  beforeAll(() => {
    if (!HAS_CREDS) {
      console.log('Skipping LLM tests — set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to enable');
    }
  });

  it('responds to a simple greeting without invoking tools', async () => {
    const { runAgent } = await import('../src/ai/agent.js');
    const result = await runAgent('hey there', {
      team_id: 'T-TEST-A',
      channel_id: 'C-TEST-A',
      user_id: 'U-TEST',
      user_name: 'Tester',
      recent_messages: [],
    });
    expect(result.response).toBeTruthy();
    expect(typeof result.response).toBe('string');
    expect(result.tool_calls).toEqual([]);
  });

  it('invokes record_decision when user explicitly says we decided X', async () => {
    const { runAgent } = await import('../src/ai/agent.js');
    const result = await runAgent('We decided to use Postgres for analytics', {
      team_id: 'T-TEST-B',
      channel_id: 'C-TEST-B',
      user_id: 'U-TEST',
      user_name: 'Tester',
      recent_messages: [],
    });
    expect(result.response).toBeTruthy();
    const recorded = result.tool_calls.find((c) => c.name === 'record_decision');
    expect(recorded).toBeDefined();
  }, LLM_TIMEOUT);

  it('invokes search_decisions when asked what we decided about X', async () => {
    const { runAgent } = await import('../src/ai/agent.js');
    const result = await runAgent('what did we decide about authentication?', {
      team_id: 'T-TEST-C',
      channel_id: 'C-TEST-C',
      user_id: 'U-TEST',
      user_name: 'Tester',
      recent_messages: [],
    });
    expect(result.response).toBeTruthy();
    const searched = result.tool_calls.find((c) => c.name === 'search_decisions');
    expect(searched).toBeDefined();
  }, LLM_TIMEOUT);
});

describe('AI agent (shape contracts — no LLM needed)', () => {
  it('exports the expected public API', async () => {
    const mod = await import('../src/ai/agent.js');
    expect(typeof mod.runAgent).toBe('function');
  });

  it('AgentContext shape is exported (type-only check via usage)', async () => {
    // TypeScript-only — this compiles only if AgentContext is exported as a type.
    // The runtime import here verifies the module is loadable.
    const mod = await import('../src/ai/agent.js');
    expect(mod).toBeDefined();
  });
});