/**
 * Storage layer tests — exercises migrations, CRUD, FTS, embeddings.
 * Run with: npm test
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'loop-test-'));
  process.env.DATABASE_PATH = join(workDir, 'test.db');
  process.env.ANTHROPIC_API_KEY = '';
  // Strip empty for env validator
});

beforeEach(() => {
  rmSync(join(workDir, 'test.db'), { force: true });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function freshRepo() {
  // Reset module cache so each test gets a fresh DB connection
  vi.resetModules();
  return import('../src/storage/repo.js');
}

import { vi } from 'vitest';

describe('storage layer', () => {
  it('runs migrations on first connect', async () => {
    const { getDb } = await import('../src/storage/db.js');
    const db = getDb();
    const tables = db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => r.name);
    expect(tables).toContain('teams');
    expect(tables).toContain('users');
    expect(tables).toContain('channels');
    expect(tables).toContain('messages');
    expect(tables).toContain('decisions');
    expect(tables).toContain('action_items');
    expect(tables).toContain('decisions_fts');
    expect(tables).toContain('actions_fts');
    expect(tables).toContain('action_external_refs');
    expect(tables).toContain('topics');
    expect(tables).toContain('ingestion_runs');
    expect(tables).toContain('proactive_events');
    expect(tables).toContain('settings');
    expect(tables).toContain('_migrations');
  });

  it('upserts teams idempotently', async () => {
    vi.resetModules();
    const { upsertTeam } = await import('../src/storage/repo.js');
    const { getDb } = await import('../src/storage/db.js');
    upsertTeam('T123', 'Acme');
    upsertTeam('T123', 'Acme Inc');
    const row = getDb()
      .prepare<[string], { name: string }>('SELECT name FROM teams WHERE slack_team_id = ?')
      .get('T123');
    expect(row?.name).toBe('Acme Inc');
  });

  it('upserts users and looks them up by slack id', async () => {
    vi.resetModules();
    const { upsertUser, findUserBySlackId, upsertTeam } = await import('../src/storage/repo.js');
    upsertTeam('T123', 'Acme');
    const a = upsertUser({
      slack_user_id: 'U001',
      slack_team_id: 'T123',
      display_name: 'alice',
    });
    const b = upsertUser({
      slack_user_id: 'U001',
      slack_team_id: 'T123',
      display_name: 'alice_updated',
    });
    expect(a.id).toBe(b.id);
    expect(b.display_name).toBe('alice_updated');
    const looked = findUserBySlackId('U001', 'T123');
    expect(looked?.display_name).toBe('alice_updated');
  });

  it('creates decisions with embeddings and finds similar ones', async () => {
    vi.resetModules();
    const { createDecision, findSimilarDecisions, upsertTeam, upsertChannel } = await import(
      '../src/storage/repo.js'
    );
    upsertTeam('T123', 'Acme');
    upsertChannel({
      slack_channel_id: 'C001',
      slack_team_id: 'T123',
      name: 'general',
    });
    createDecision({
      team_id: 'T123',
      channel_id: 'C001',
      summary: 'We will migrate from MongoDB to Postgres by end of Q3',
      rationale: 'Postgres gives us better JOIN semantics for analytics queries',
      participants: [],
      confidence: 'stated',
    });
    createDecision({
      team_id: 'T123',
      channel_id: 'C001',
      summary: 'We will launch dark mode next sprint',
      participants: [],
      confidence: 'stated',
    });

    const similar = findSimilarDecisions(
      'T123',
      'what did we decide about database migration timeline?',
      5,
    );
    expect(similar.length).toBeGreaterThanOrEqual(1);
    expect(similar[0]?.summary.toLowerCase()).toContain('migrate');
  });

  it('creates action items with priorities and statuses', async () => {
    vi.resetModules();
    const { createAction, listActions, updateActionStatus, upsertTeam, upsertChannel } = await import(
      '../src/storage/repo.js'
    );
    upsertTeam('T123', 'Acme');
    upsertChannel({
      slack_channel_id: 'C001',
      slack_team_id: 'T123',
      name: 'general',
    });
    const a = createAction({
      team_id: 'T123',
      channel_id: 'C001',
      title: 'Ship migration script',
      priority: 'high',
      confidence: 0.9,
      due_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(a.status).toBe('open');
    const list = listActions({ team_id: 'T123', status: 'open' });
    expect(list.find((x) => x.id === a.id)).toBeDefined();

    updateActionStatus(a.id, 'done');
    const after = listActions({ team_id: 'T123', status: 'done' });
    expect(after.find((x) => x.id === a.id)).toBeDefined();
  });

  it('attaches external refs (Linear/Jira/Notion)', async () => {
    vi.resetModules();
    const { createAction, attachExternalRef, listActions, upsertTeam, upsertChannel } = await import(
      '../src/storage/repo.js'
    );
    upsertTeam('T123', 'Acme');
    upsertChannel({
      slack_channel_id: 'C001',
      slack_team_id: 'T123',
      name: 'general',
    });
    const a = createAction({
      team_id: 'T123',
      channel_id: 'C001',
      title: 'Refactor billing',
      confidence: 1,
    });
    attachExternalRef(a.id, {
      system: 'linear',
      external_id: 'ENG-1234',
      url: 'https://linear.app/acme/issue/ENG-1234',
      title: 'Refactor billing',
      created_at: new Date().toISOString(),
    });
    const list = listActions({ team_id: 'T123' });
    const reloaded = list.find((x) => x.id === a.id);
    expect(reloaded?.external_refs).toHaveLength(1);
    expect(reloaded?.external_refs[0]?.system).toBe('linear');
  });
});

describe('embeddings', () => {
  it('produces normalized 256-dim vectors', async () => {
    const { embed, cosineSimilarity } = await import('../src/storage/embeddings.js');
    const a = embed('the quick brown fox');
    const b = embed('the quick brown fox');
    expect(a.dim).toBe(256);
    expect(a.vec).toHaveLength(256);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('ranks similar text above unrelated', async () => {
    const { embed, cosineSimilarity } = await import('../src/storage/embeddings.js');
    const auth = embed('authentication authorization login session');
    const cats = embed('cat kitten feline pet animal');
    const billing = embed('payment invoice stripe subscription');
    const a = embed('auth login flow');
    const sAuth = cosineSimilarity(a, auth);
    const sCats = cosineSimilarity(a, cats);
    const sBilling = cosineSimilarity(a, billing);
    expect(sAuth).toBeGreaterThan(sCats);
    expect(sAuth).toBeGreaterThan(sBilling);
  });
});

// suppress the unused import warning
void freshRepo;
