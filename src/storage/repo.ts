/**
 * Repository — typed access to Loop's stored data.
 * Keeps SQL out of the rest of the app and gives us a single place
 * to evolve the schema without rippling.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { embed } from './embeddings.js';
import type {
  ActionItem,
  ActionStatus,
  Channel,
  Decision,
  ExternalRef,
  SlackChannelId,
  SlackTeamId,
  SlackTs,
  SlackUserId,
  Topic,
  User,
} from '../core/types.js';

/* ----------------------------- Teams ----------------------------- */

export function upsertTeam(slackTeamId: SlackTeamId, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO teams (id, slack_team_id, name)
       VALUES (?, ?, ?)
       ON CONFLICT(slack_team_id) DO UPDATE SET name = excluded.name`,
    )
    .run(randomUUID(), slackTeamId, name);
}

/* ----------------------------- Users ----------------------------- */

export interface UpsertUserInput {
  slack_user_id: SlackUserId;
  slack_team_id: SlackTeamId;
  display_name: string;
  real_name?: string;
  avatar_url?: string;
}

export function upsertUser(input: UpsertUserInput): User {
  const db = getDb();
  const existing = db
    .prepare<[SlackUserId, SlackTeamId], User>(
      `SELECT id, slack_user_id, slack_team_id, display_name, real_name, avatar_url,
              first_seen_at, last_seen_at
       FROM users WHERE slack_user_id = ? AND slack_team_id = ?`,
    )
    .get(input.slack_user_id, input.slack_team_id);

  if (existing) {
    db.prepare(
      `UPDATE users SET display_name = ?, real_name = ?, avatar_url = ?, last_seen_at = datetime('now')
       WHERE id = ?`,
    ).run(input.display_name, input.real_name ?? null, input.avatar_url ?? null, existing.id);
    return {
      ...existing,
      display_name: input.display_name,
      real_name: input.real_name ?? existing.real_name,
      avatar_url: input.avatar_url ?? existing.avatar_url,
      last_seen_at: new Date().toISOString(),
    };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, slack_user_id, slack_team_id, display_name, real_name, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.slack_user_id,
    input.slack_team_id,
    input.display_name,
    input.real_name ?? null,
    input.avatar_url ?? null,
  );

  return {
    id,
    slack_user_id: input.slack_user_id,
    slack_team_id: input.slack_team_id,
    display_name: input.display_name,
    real_name: input.real_name,
    avatar_url: input.avatar_url,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
}

export function findUserBySlackId(slackUserId: SlackUserId, teamId: SlackTeamId): User | undefined {
  return getDb()
    .prepare<[SlackUserId, SlackTeamId], User>(
      `SELECT id, slack_user_id, slack_team_id, display_name, real_name, avatar_url,
              first_seen_at, last_seen_at
       FROM users WHERE slack_user_id = ? AND slack_team_id = ?`,
    )
    .get(slackUserId, teamId);
}

/* ----------------------------- Channels ----------------------------- */

export interface UpsertChannelInput {
  slack_channel_id: SlackChannelId;
  slack_team_id: SlackTeamId;
  name: string;
  is_private?: boolean;
  is_archived?: boolean;
}

export function upsertChannel(input: UpsertChannelInput): Channel {
  const db = getDb();
  const existing = db
    .prepare<[SlackChannelId, SlackTeamId], Channel>(
      `SELECT id, slack_channel_id, slack_team_id, name,
              is_private, is_archived, watched, joined_at
       FROM channels WHERE slack_channel_id = ? AND slack_team_id = ?`,
    )
    .get(input.slack_channel_id, input.slack_team_id);

  if (existing) {
    db.prepare(
      `UPDATE channels SET name = ?, is_private = COALESCE(?, is_private),
                           is_archived = COALESCE(?, is_archived)
       WHERE id = ?`,
    ).run(input.name, input.is_private != null ? (input.is_private ? 1 : 0) : null,
          input.is_archived != null ? (input.is_archived ? 1 : 0) : null, existing.id);
    return {
      ...existing,
      name: input.name,
      is_private: input.is_private ?? existing.is_private,
      is_archived: input.is_archived ?? existing.is_archived,
    };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO channels (id, slack_channel_id, slack_team_id, name, is_private, is_archived)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.slack_channel_id,
    input.slack_team_id,
    input.name,
    input.is_private ? 1 : 0,
    input.is_archived ? 1 : 0,
  );

  return {
    id,
    slack_channel_id: input.slack_channel_id,
    slack_team_id: input.slack_team_id,
    name: input.name,
    is_private: input.is_private ?? false,
    is_archived: input.is_archived ?? false,
    watched: true,
    joined_at: new Date().toISOString(),
  };
}

/* ----------------------------- Messages ----------------------------- */

export interface IngestMessageInput {
  team_id: SlackTeamId;
  channel_id: SlackChannelId;
  ts: SlackTs;
  thread_ts?: SlackTs;
  user_id: SlackUserId;
  text: string;
  is_edited?: boolean;
}

export function ingestMessage(input: IngestMessageInput): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
        (id, slack_team_id, slack_channel_id, slack_ts, slack_thread_ts, slack_user_id, text, is_edited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.team_id,
      input.channel_id,
      input.ts,
      input.thread_ts ?? null,
      input.user_id,
      input.text,
      input.is_edited ? 1 : 0,
    );
  return res.changes > 0;
}

export interface StoredMessage {
  slack_ts: SlackTs;
  slack_thread_ts: SlackTs | null;
  slack_user_id: SlackUserId;
  text: string;
}

export function getRecentMessages(
  channelId: SlackChannelId,
  limit = 30,
  sinceTs?: SlackTs,
): StoredMessage[] {
  const db = getDb();
  if (sinceTs) {
    return db
      .prepare<[SlackChannelId, SlackTs, number], StoredMessage>(
        `SELECT slack_ts, slack_thread_ts, slack_user_id, text
         FROM messages
         WHERE slack_channel_id = ? AND slack_ts > ?
         ORDER BY slack_ts DESC
         LIMIT ?`,
      )
      .all(channelId, sinceTs, limit)
      .reverse();
  }
  return db
    .prepare<[SlackChannelId, number], StoredMessage>(
      `SELECT slack_ts, slack_thread_ts, slack_user_id, text
       FROM messages
       WHERE slack_channel_id = ?
       ORDER BY slack_ts DESC
       LIMIT ?`,
    )
    .all(channelId, limit)
    .reverse();
}

/* ----------------------------- Decisions ----------------------------- */

export interface CreateDecisionInput {
  team_id: SlackTeamId;
  channel_id: SlackChannelId;
  summary: string;
  rationale?: string;
  source_message_ts?: SlackTs;
  source_thread_ts?: SlackTs;
  participants: string[]; // user.id list
  confidence: 'stated' | 'inferred' | 'tentative';
  supersedes_id?: string;
}

export function createDecision(input: CreateDecisionInput): Decision {
  const db = getDb();
  const id = randomUUID();
  const embedding = embed(`${input.summary}\n${input.rationale ?? ''}`);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO decisions
         (id, team_id, channel_id, source_message_ts, source_thread_ts, summary, rationale,
          participants_json, confidence, supersedes_id, embedding_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.team_id,
      input.channel_id,
      input.source_message_ts ?? null,
      input.source_thread_ts ?? null,
      input.summary,
      input.rationale ?? null,
      JSON.stringify(input.participants),
      input.confidence,
      input.supersedes_id ?? null,
      JSON.stringify(embedding.vec),
    );
    db.prepare(
      `INSERT INTO decisions_fts(rowid, summary, rationale)
       VALUES ((SELECT rowid FROM decisions WHERE id = ?), ?, ?)`,
    ).run(id, input.summary, input.rationale ?? '');
  });

  tx();

  return {
    id,
    team_id: input.team_id,
    channel_id: input.channel_id,
    source_message_ts: input.source_message_ts,
    source_thread_ts: input.source_thread_ts,
    summary: input.summary,
    rationale: input.rationale,
    participants: input.participants,
    confidence: input.confidence,
    supersedes: input.supersedes_id,
    created_at: new Date().toISOString(),
    embedding: embedding.vec,
  };
}

export function listDecisions(teamId: SlackTeamId, limit = 50): Decision[] {
  const rows = getDb()
    .prepare<[SlackTeamId, number], DecisionRow>(
      `SELECT id, team_id, channel_id, source_message_ts, source_thread_ts,
              summary, rationale, participants_json, confidence, supersedes_id, created_at
       FROM decisions
       WHERE team_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(teamId, limit);
  return rows.map(rowToDecision);
}

export function findSimilarDecisions(
  teamId: SlackTeamId,
  query: string,
  limit = 5,
): Array<Decision & { score: number }> {
  const qEmb = embed(query);
  const rows = getDb()
    .prepare<[SlackTeamId], DecisionRow>(
      `SELECT id, team_id, channel_id, source_message_ts, source_thread_ts,
              summary, rationale, participants_json, confidence, supersedes_id, created_at, embedding_json
       FROM decisions
       WHERE team_id = ? AND embedding_json IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 500`,
    )
    .all(teamId);

  const scored = rows
    .map((r) => {
      const d = rowToDecision(r);
      const score = r.embedding_json
        ? cosineFromJson(qEmb, r.embedding_json)
        : 0;
      return { ...d, score };
    })
    .filter((r) => r.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

export function searchDecisionsFts(teamId: SlackTeamId, query: string, limit = 10): Decision[] {
  const rows = getDb()
    .prepare<[string, string, number], DecisionRow>(
      `SELECT d.id, d.team_id, d.channel_id, d.source_message_ts, d.source_thread_ts,
              d.summary, d.rationale, d.participants_json, d.confidence, d.supersedes_id, d.created_at
       FROM decisions d
       JOIN decisions_fts f ON f.rowid = (
         SELECT rowid FROM decisions WHERE id = d.id
       )
       WHERE d.team_id = ? AND decisions_fts MATCH ?
       LIMIT ?`,
    )
    .all(teamId, query, limit);
  return rows.map(rowToDecision);
}

/* ----------------------------- Actions ----------------------------- */

export interface CreateActionInput {
  team_id: SlackTeamId;
  channel_id: SlackChannelId;
  title: string;
  description?: string;
  owner_user_id?: string;
  due_at?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  confidence: number;
  source_message_ts?: SlackTs;
  source_thread_ts?: SlackTs;
}

export function createAction(input: CreateActionInput): ActionItem {
  const db = getDb();
  const id = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO action_items
         (id, team_id, channel_id, source_message_ts, source_thread_ts, title, description,
          owner_user_id, due_at, priority, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.team_id,
      input.channel_id,
      input.source_message_ts ?? null,
      input.source_thread_ts ?? null,
      input.title,
      input.description ?? null,
      input.owner_user_id ?? null,
      input.due_at ?? null,
      input.priority ?? 'medium',
      input.confidence,
    );
    db.prepare(
      `INSERT INTO actions_fts(rowid, title, description)
       VALUES ((SELECT rowid FROM action_items WHERE id = ?), ?, ?)`,
    ).run(id, input.title, input.description ?? '');
  });

  tx();

  return {
    id,
    team_id: input.team_id,
    channel_id: input.channel_id,
    source_message_ts: input.source_message_ts,
    source_thread_ts: input.source_thread_ts,
    title: input.title,
    description: input.description,
    owner_user_id: input.owner_user_id,
    due_at: input.due_at,
    status: 'open',
    priority: input.priority ?? 'medium',
    confidence: input.confidence,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    external_refs: [],
  };
}

export interface ListActionsFilter {
  team_id: SlackTeamId;
  status?: ActionStatus | ActionStatus[];
  owner_user_id?: string;
  due_before?: string;
  limit?: number;
}

export function listActions(filter: ListActionsFilter): ActionItem[] {
  const where: string[] = ['team_id = ?'];
  const params: unknown[] = [filter.team_id];

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filter.owner_user_id) {
    where.push('owner_user_id = ?');
    params.push(filter.owner_user_id);
  }
  if (filter.due_before) {
    where.push('due_at IS NOT NULL AND due_at < ?');
    params.push(filter.due_before);
  }

  const limit = filter.limit ?? 100;
  params.push(limit);

  const rows = getDb()
    .prepare<unknown[], ActionItemRow>(
      `SELECT id, team_id, channel_id, source_message_ts, source_thread_ts, title, description,
              owner_user_id, due_at, status, priority, confidence,
              created_at, updated_at, completed_at, cancelled_at
       FROM action_items
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         COALESCE(due_at, '9999') ASC,
         created_at DESC
       LIMIT ?`,
    )
    .all(...params);

  return rows.map(rowToAction);
}

export function updateActionStatus(
  id: string,
  status: ActionStatus,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (status === 'done') {
    db.prepare(`UPDATE action_items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, now, id);
  } else if (status === 'cancelled') {
    db.prepare(`UPDATE action_items SET status = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, now, id);
  } else {
    db.prepare(`UPDATE action_items SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, id);
  }
}

export function attachExternalRef(actionId: string, ref: ExternalRef): void {
  getDb()
    .prepare(
      `INSERT INTO action_external_refs (id, action_id, system, external_id, url, title)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(system, external_id) DO UPDATE SET url = excluded.url, title = excluded.title`,
    )
    .run(randomUUID(), actionId, ref.system, ref.external_id, ref.url, ref.title ?? null);
}

/* ----------------------------- Topics ----------------------------- */

export function bumpTopic(teamId: SlackTeamId, label: string, mentionCount = 1): void {
  getDb()
    .prepare(
      `INSERT INTO topics (id, team_id, label, mention_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, label) DO UPDATE SET
         mention_count = mention_count + ?,
         last_seen_at = datetime('now')`,
    )
    .run(randomUUID(), teamId, label, mentionCount, mentionCount);
}

export function listTopics(teamId: SlackTeamId, limit = 20): Topic[] {
  return getDb()
    .prepare<[SlackTeamId, number], Topic>(
      `SELECT id, label, description, last_seen_at, mention_count
       FROM topics WHERE team_id = ?
       ORDER BY last_seen_at DESC LIMIT ?`,
    )
    .all(teamId, limit);
}

/* ----------------------------- Proactive ----------------------------- */

export function recordProactiveEvent(event: {
  team_id: SlackTeamId;
  kind: 'surface_decision' | 'action_followup' | 'action_overdue' | 'decision_update';
  target_user_id?: string;
  target_channel_id?: string;
  payload: unknown;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO proactive_events (id, team_id, kind, target_user_id, target_channel_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, event.team_id, event.kind, event.target_user_id ?? null,
         event.target_channel_id ?? null, JSON.stringify(event.payload));
  return id;
}

/* ----------------------------- Helpers ----------------------------- */

interface ActionItemRow {
  id: string;
  team_id: string;
  channel_id: string;
  source_message_ts: string | null;
  source_thread_ts: string | null;
  title: string;
  description: string | null;
  owner_user_id: string | null;
  due_at: string | null;
  status: ActionStatus;
  priority: ActionItem['priority'];
  confidence: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

function rowToAction(r: ActionItemRow): ActionItem {
  const refs = getDb()
    .prepare<[string], { system: ExternalRef['system']; external_id: string; url: string; title: string | null; created_at: string }>(
      `SELECT system, external_id, url, title, created_at
       FROM action_external_refs WHERE action_id = ?`,
    )
    .all(r.id)
    .map((x) => ({ system: x.system, external_id: x.external_id, url: x.url, title: x.title ?? undefined, created_at: x.created_at }));
  return {
    id: r.id,
    team_id: r.team_id,
    channel_id: r.channel_id,
    source_message_ts: r.source_message_ts ?? undefined,
    source_thread_ts: r.source_thread_ts ?? undefined,
    title: r.title,
    description: r.description ?? undefined,
    owner_user_id: r.owner_user_id ?? undefined,
    due_at: r.due_at ?? undefined,
    status: r.status,
    priority: r.priority,
    confidence: r.confidence,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at ?? undefined,
    cancelled_at: r.cancelled_at ?? undefined,
    external_refs: refs,
  };
}

interface DecisionRow {
  id: string;
  team_id: string;
  channel_id: string;
  source_message_ts: string | null;
  source_thread_ts: string | null;
  summary: string;
  rationale: string | null;
  participants_json: string;
  confidence: string;
  supersedes_id: string | null;
  created_at: string;
  embedding_json?: string | null;
}

function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    team_id: r.team_id,
    channel_id: r.channel_id,
    source_message_ts: r.source_message_ts ?? undefined,
    source_thread_ts: r.source_thread_ts ?? undefined,
    summary: r.summary,
    rationale: r.rationale ?? undefined,
    participants: JSON.parse(r.participants_json) as string[],
    confidence: (r.confidence === 'stated' || r.confidence === 'inferred' || r.confidence === 'tentative')
      ? r.confidence
      : 'inferred',
    supersedes: r.supersedes_id ?? undefined,
    created_at: r.created_at,
    embedding: r.embedding_json ? (JSON.parse(r.embedding_json) as number[]) : undefined,
  };
}

function cosineFromJson(qEmb: { vec: number[]; dim: number }, jsonStr: string): number {
  let other: number[];
  try {
    other = JSON.parse(jsonStr) as number[];
  } catch {
    return 0;
  }
  if (other.length !== qEmb.dim) return 0;
  let dot = 0;
  for (let i = 0; i < qEmb.dim; i++) dot += qEmb.vec[i]! * other[i]!;
  return dot;
}
