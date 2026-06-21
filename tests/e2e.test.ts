/**
 * End-to-end tests of Loop's storage + retrieval pipeline.
 *
 * These tests bypass the LLM extractor (which depends on having a real key)
 * and seed data directly through the repo. They verify:
 *   - Decisions/actions can be stored and retrieved
 *   - Semantic search ranks relevant items first
 *   - FTS5 keyword search works
 *   - Action lifecycle (open → done → overdue)
 *   - External refs round-trip
 *
 * The LLM extraction path itself is exercised end-to-end in Slack via the
 * running dev server — those assertions live outside automated tests because
 * they require a real model and a real workspace.
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
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
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

describe('Loop pipeline (storage + retrieval)', () => {
  it('records decisions and surfaces them via semantic search', async () => {
    const { createDecision, findSimilarDecisions, upsertTeam, upsertChannel } = await import(
      '../src/storage/repo.js'
    );
    upsertTeam('T001', 'Acme Co');
    upsertChannel({ slack_channel_id: 'C001', slack_team_id: 'T001', name: 'eng-team' });

    createDecision({
      team_id: 'T001',
      channel_id: 'C001',
      summary: 'We will standardize on OAuth authentication for all first-party apps',
      rationale: 'Industry standard, supports SSO',
      participants: [],
      confidence: 'stated',
    });
    createDecision({
      team_id: 'T001',
      channel_id: 'C001',
      summary: 'Mobile app will use React Native framework',
      participants: [],
      confidence: 'stated',
    });

    // Query with strong word overlap to bag-of-bigrams embeddings
    const similar = findSimilarDecisions(
      'T001',
      'OAuth authentication decision apps',
      5,
    );
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0]?.summary.toLowerCase()).toContain('oauth');
  });

  it('records action items with owners and due dates, and finds them', async () => {
    const {
      createAction,
      listActions,
      updateActionStatus,
      upsertTeam,
      upsertChannel,
      upsertUser,
    } = await import('../src/storage/repo.js');

    upsertTeam('T002', 'Beta');
    upsertChannel({ slack_channel_id: 'C002', slack_team_id: 'T002', name: 'ops' });
    const owner = upsertUser({ slack_user_id: 'U-ALICE', slack_team_id: 'T002', display_name: 'Alice' });

    const a = createAction({
      team_id: 'T002',
      channel_id: 'C002',
      title: 'Patch CVE-2024-1234 in production',
      owner_user_id: owner.id,
      priority: 'urgent',
      confidence: 1,
      due_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(a.owner_user_id).toBe(owner.id);
    expect(a.status).toBe('open');

    const open = listActions({ team_id: 'T002', status: ['open', 'in_progress', 'overdue'] });
    expect(open.find((x) => x.id === a.id)).toBeDefined();

    updateActionStatus(a.id, 'done');
    const done = listActions({ team_id: 'T002', status: 'done' });
    expect(done.find((x) => x.id === a.id)).toBeDefined();
  });

  it('promotes overdue actions and records follow-up events', async () => {
    const {
      createAction,
      listActions,
      updateActionStatus,
      recordProactiveEvent,
      upsertTeam,
      upsertChannel,
    } = await import('../src/storage/repo.js');

    upsertTeam('T003', 'Gamma');
    upsertChannel({ slack_channel_id: 'C003', slack_team_id: 'T003', name: 'sre' });

    const a = createAction({
      team_id: 'T003',
      channel_id: 'C003',
      title: 'Rotate prod secrets',
      priority: 'high',
      confidence: 1,
      due_at: new Date(Date.now() - 86400000).toISOString(),
    });

    // Simulate scheduler: promote overdue
    const overdue = listActions({
      team_id: 'T003',
      status: 'open',
      due_before: new Date().toISOString(),
    });
    for (const o of overdue) updateActionStatus(o.id, 'overdue');

    const now = listActions({ team_id: 'T003', status: 'overdue' });
    expect(now.find((x) => x.id === a.id)).toBeDefined();

    // Record the follow-up event
    const eventId = recordProactiveEvent({
      team_id: 'T003',
      kind: 'action_followup',
      target_user_id: 'U-X',
      target_channel_id: 'C003',
      payload: { action_id: a.id, due_at: a.due_at },
    });
    expect(eventId).toBeTruthy();
  });

  it('searches decisions by keyword (FTS5)', async () => {
    const { createDecision, searchDecisionsFts, upsertTeam, upsertChannel } = await import(
      '../src/storage/repo.js'
    );
    upsertTeam('T004', 'Delta');
    upsertChannel({ slack_channel_id: 'C004', slack_team_id: 'T004', name: 'finance' });

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

    const euResults = searchDecisionsFts('T004', 'launch market', 10);
    expect(euResults.length).toBeGreaterThanOrEqual(1);
  });

  it('round-trips external refs (Linear/Jira/Notion)', async () => {
    const {
      createAction,
      attachExternalRef,
      listActions,
      upsertTeam,
      upsertChannel,
    } = await import('../src/storage/repo.js');

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