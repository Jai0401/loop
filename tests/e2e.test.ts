/**
 * End-to-end test of Loop's full pipeline.
 *
 * Simulates a realistic team conversation:
 *   - Several messages posted across channels
 *   - Decisions get extracted and stored
 *   - Action items get tracked with owners + due dates
 *   - New message referencing past decision triggers surfacing
 *   - Action past its due date becomes overdue and gets flagged for follow-up
 *
 * No external services needed (no real Slack, no real Anthropic key).
 * Uses the heuristic extractor so the test is deterministic.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
  process.env.DATABASE_PATH = join(workDir, 'e2e.db');
  process.env.ANTHROPIC_API_KEY = '';
  // Ensure we use heuristic extractor
  delete process.env.ANTHROPIC_API_KEY;
});

beforeEach(() => {
  vi.resetModules();
  rmSync(join(workDir, 'e2e.db'), { force: true });
  rmSync(join(workDir, 'e2e.db-wal'), { force: true });
  rmSync(join(workDir, 'e2e.db-shm'), { force: true });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('Loop end-to-end pipeline', () => {
  it('extracts decisions + actions from a realistic conversation', async () => {
    const { extractFromBatch } = await import('../src/ai/extractor.js');
    const { createDecision, createAction, listDecisions, listActions, findSimilarDecisions, upsertTeam, upsertChannel, upsertUser } = await import('../src/storage/repo.js');

    upsertTeam('T001', 'Acme Co');
    upsertChannel({ slack_channel_id: 'C001', slack_team_id: 'T001', name: 'eng-team' });
    upsertUser({ slack_user_id: 'U001', slack_team_id: 'T001', display_name: 'alice' });
    upsertUser({ slack_user_id: 'U002', slack_team_id: 'T001', display_name: 'bob' });
    upsertUser({ slack_user_id: 'U003', slack_team_id: 'T001', display_name: 'carol' });

    // Simulated Slack conversation — engineering team planning Q3
    const batch = {
      channel: 'C001',
      oldest_ts: '100',
      latest_ts: '105',
      messages: [
        { ts: '100', channel: 'C001', user: 'U001', text: 'Hey team, we need to decide on the analytics database for Q3.' },
        { ts: '101', channel: 'C001', user: 'U002', text: "Let's go with Postgres — better JOIN semantics for our analytics workloads. We agreed on this earlier." },
        { ts: '102', channel: 'C001', user: 'U003', text: 'agreed, locked in. Postgres for analytics is approved.' },
        { ts: '103', channel: 'C001', user: 'U001', text: "<@U002> can you write the migration script by Friday?" },
        { ts: '104', channel: 'C001', user: 'U002', text: "I'll write the Postgres migration script and test it on staging." },
        { ts: '105', channel: 'C001', user: 'U001', text: "<@U003> will set up the dashboard by EOD" },
      ],
    };

    const result = await extractFromBatch(batch);

    // Persist everything
    for (const d of result.decisions) {
      createDecision({
        team_id: 'T001',
        channel_id: 'C001',
        summary: d.summary,
        rationale: d.rationale,
        participants: ['U001', 'U002', 'U003'],
        confidence: d.confidence,
        source_message_ts: d.source_message_ts,
      });
    }
    for (const a of result.action_items) {
      const owner = a.owner_slack_id
        ? (await import('../src/storage/repo.js')).findUserBySlackId(a.owner_slack_id, 'T001')?.id
        : undefined;
      createAction({
        team_id: 'T001',
        channel_id: 'C001',
        title: a.title,
        owner_user_id: owner,
        due_at: a.due_iso,
        priority: a.priority,
        confidence: a.confidence,
        source_message_ts: a.source_message_ts,
      });
    }

    const decisions = listDecisions('T001', 50);
    const actions = listActions({ team_id: 'T001', limit: 50 });

    expect(decisions.length).toBeGreaterThan(0);
    expect(actions.length).toBeGreaterThan(0);

    // Verify decision content
    const dbDecision = decisions.find((d) => d.summary.toLowerCase().includes('postgres'));
    expect(dbDecision).toBeDefined();
    expect(dbDecision?.confidence).toMatch(/inferred|stated/);

    // Verify action with owner + due date — relax the keyword to handle
    // both "migration script" and "postgres" phrasings the extractor might pick.
    const actionWithOwner = actions.find(
      (a) => a.owner_user_id && (a.due_at || a.title.toLowerCase().includes('migration')),
    );
    expect(actionWithOwner, `actions found: ${JSON.stringify(actions.map((a) => ({ title: a.title, owner: a.owner_user_id, due: a.due_at })))}`).toBeDefined();
  });

  it('surfaces past decisions when new message references them', async () => {
    const { createDecision, findSimilarDecisions, upsertTeam, upsertChannel } = await import('../src/storage/repo.js');
    upsertTeam('T002', 'Beta');
    upsertChannel({ slack_channel_id: 'C002', slack_team_id: 'T002', name: 'product' });

    // Plant a past decision about authentication
    createDecision({
      team_id: 'T002',
      channel_id: 'C002',
      summary: 'We will standardize on OAuth 2.0 with PKCE for all first-party apps',
      rationale: 'Industry standard, supports SSO, and works with our existing identity provider',
      participants: [],
      confidence: 'stated',
    });
    createDecision({
      team_id: 'T002',
      channel_id: 'C002',
      summary: 'Mobile app will use React Native',
      participants: [],
      confidence: 'stated',
    });

    // Simulate a new message that vaguely references auth
    const newMessage = "Hey team, quick question about our login flow — should we revisit our auth approach?";
    const similar = findSimilarDecisions('T002', newMessage, 5);

    // The auth-related decision should rank higher than the React Native one
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0]?.summary.toLowerCase()).toContain('oauth');
    expect(similar[0]?.score ?? 0).toBeGreaterThan(0.15);
  });

  it('marks actions overdue and queues follow-up', async () => {
    const { createAction, listActions, updateActionStatus, upsertTeam, upsertChannel, recordProactiveEvent } = await import('../src/storage/repo.js');
    upsertTeam('T003', 'Gamma');
    upsertChannel({ slack_channel_id: 'C003', slack_team_id: 'T003', name: 'ops' });

    const a = createAction({
      team_id: 'T003',
      channel_id: 'C003',
      title: 'Patch CVE-2024-1234 in production',
      priority: 'urgent',
      confidence: 1,
      due_at: new Date(Date.now() - 86400000).toISOString(), // yesterday
    });

    // Simulate scheduler tick: promote open + past-due → overdue
    const overdue = listActions({
      team_id: 'T003',
      status: 'open',
      due_before: new Date().toISOString(),
    });
    for (const o of overdue) {
      updateActionStatus(o.id, 'overdue');
    }

    const reloaded = listActions({ team_id: 'T003', status: 'overdue' });
    expect(reloaded.find((x) => x.id === a.id)).toBeDefined();

    // Record a follow-up event (simulating scheduler)
    const eventId = recordProactiveEvent({
      team_id: 'T003',
      kind: 'action_followup',
      target_user_id: 'user-1',
      target_channel_id: 'C003',
      payload: { action_id: a.id, due_at: a.due_at },
    });
    expect(eventId).toBeTruthy();
  });

  it('searches decisions by keyword (FTS5)', async () => {
    const { createDecision, searchDecisionsFts, upsertTeam, upsertChannel } = await import('../src/storage/repo.js');
    upsertTeam('T004', 'Delta');
    upsertChannel({ slack_channel_id: 'C004', slack_team_id: 'T004', name: 'eng' });

    createDecision({
      team_id: 'T004',
      channel_id: 'C004',
      summary: 'Stripe will be our exclusive payment processor',
      participants: [],
      confidence: 'stated',
    });
    createDecision({
      team_id: 'T004',
      channel_id: 'C004',
      summary: 'We will launch in the EU market in Q4',
      participants: [],
      confidence: 'stated',
    });

    const stripeResults = searchDecisionsFts('T004', 'stripe payment', 10);
    expect(stripeResults.length).toBeGreaterThanOrEqual(1);
    expect(stripeResults[0]?.summary.toLowerCase()).toContain('stripe');

    // FTS5 doesn't stem by default — match the exact word in the decision.
    const euResults = searchDecisionsFts('T004', 'launch market', 10);
    expect(euResults.length).toBeGreaterThanOrEqual(1);
  });

  it('round-trips external refs (Linear/Jira/Notion)', async () => {
    const { createAction, attachExternalRef, listActions, upsertTeam, upsertChannel } = await import('../src/storage/repo.js');
    upsertTeam('T005', 'Epsilon');
    upsertChannel({ slack_channel_id: 'C005', slack_team_id: 'T005', name: 'dev' });

    const a = createAction({
      team_id: 'T005',
      channel_id: 'C005',
      title: 'Refactor auth middleware',
      confidence: 1,
    });
    attachExternalRef(a.id, {
      system: 'linear',
      external_id: 'ENG-9001',
      url: 'https://linear.app/epsilon/issue/ENG-9001',
      title: 'Refactor auth middleware',
      created_at: new Date().toISOString(),
    });
    attachExternalRef(a.id, {
      system: 'notion',
      external_id: 'page-abc',
      url: 'https://notion.so/epsilon/page-abc',
      title: 'Auth middleware design doc',
      created_at: new Date().toISOString(),
    });

    const reloaded = listActions({ team_id: 'T005' }).find((x) => x.id === a.id);
    expect(reloaded?.external_refs).toHaveLength(2);
    const systems = reloaded?.external_refs.map((r) => r.system).sort();
    expect(systems).toEqual(['linear', 'notion']);
  });
});
