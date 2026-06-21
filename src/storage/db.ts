/**
 * Storage layer — better-sqlite3 with WAL mode.
 *
 * Loop's data is small per-team (thousands of decisions/actions, not millions),
 * and SQLite gives us:
 *   - zero infra to demo
 *   - transactional writes (atomic decision + action creation)
 *   - FTS5 for keyword search; vectors stored as JSON for now, swap to sqlite-vec later
 *
 * Schema is migrated on boot via `runMigrations`. Migrations are append-only.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const path = isAbsolute(env.DATABASE_PATH)
    ? env.DATABASE_PATH
    : resolve(process.cwd(), env.DATABASE_PATH);

  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  runMigrations(db);
  _db = db;
  logger.info({ path }, 'storage: opened SQLite database');
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/* ----------------------------- Migrations ----------------------------- */

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE teams (
        id              TEXT PRIMARY KEY,
        slack_team_id   TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE users (
        id                TEXT PRIMARY KEY,
        slack_user_id     TEXT NOT NULL,
        slack_team_id     TEXT NOT NULL,
        display_name      TEXT NOT NULL,
        real_name         TEXT,
        avatar_url        TEXT,
        first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (slack_user_id, slack_team_id),
        FOREIGN KEY (slack_team_id) REFERENCES teams(slack_team_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_users_team ON users(slack_team_id);

      CREATE TABLE channels (
        id                TEXT PRIMARY KEY,
        slack_channel_id  TEXT NOT NULL UNIQUE,
        slack_team_id     TEXT NOT NULL,
        name              TEXT NOT NULL,
        is_private        INTEGER NOT NULL DEFAULT 0,
        is_archived       INTEGER NOT NULL DEFAULT 0,
        watched           INTEGER NOT NULL DEFAULT 1,
        joined_at         TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (slack_team_id) REFERENCES teams(slack_team_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_channels_team ON channels(slack_team_id);

      CREATE TABLE messages (
        id                TEXT PRIMARY KEY,
        slack_team_id     TEXT NOT NULL,
        slack_channel_id  TEXT NOT NULL,
        slack_ts          TEXT NOT NULL,
        slack_thread_ts   TEXT,
        slack_user_id     TEXT NOT NULL,
        text              TEXT NOT NULL,
        is_edited         INTEGER NOT NULL DEFAULT 0,
        ingested_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (slack_channel_id, slack_ts),
        FOREIGN KEY (slack_team_id) REFERENCES teams(slack_team_id) ON DELETE CASCADE,
        FOREIGN KEY (slack_channel_id) REFERENCES channels(slack_channel_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_messages_channel_ts ON messages(slack_channel_id, slack_ts DESC);
      CREATE INDEX idx_messages_thread ON messages(slack_thread_ts);

      CREATE TABLE decisions (
        id                TEXT PRIMARY KEY,
        team_id           TEXT NOT NULL,
        channel_id        TEXT NOT NULL,
        source_message_ts TEXT,
        source_thread_ts  TEXT,
        summary           TEXT NOT NULL,
        rationale         TEXT,
        participants_json TEXT NOT NULL DEFAULT '[]',
        confidence        TEXT NOT NULL CHECK (confidence IN ('stated','inferred','tentative')),
        supersedes_id     TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        embedding_json    TEXT,
        FOREIGN KEY (team_id)    REFERENCES teams(slack_team_id)    ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(slack_channel_id) ON DELETE CASCADE,
        FOREIGN KEY (supersedes_id) REFERENCES decisions(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_decisions_team_created ON decisions(team_id, created_at DESC);
      CREATE INDEX idx_decisions_channel ON decisions(channel_id);

      CREATE VIRTUAL TABLE decisions_fts USING fts5(
        summary, rationale, content='decisions', content_rowid='rowid'
      );

      CREATE TABLE action_items (
        id                TEXT PRIMARY KEY,
        team_id           TEXT NOT NULL,
        channel_id        TEXT NOT NULL,
        source_message_ts TEXT,
        source_thread_ts  TEXT,
        title             TEXT NOT NULL,
        description       TEXT,
        owner_user_id     TEXT,
        due_at            TEXT,
        status            TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_progress','done','cancelled','overdue')),
        priority          TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('low','medium','high','urgent')),
        confidence        REAL NOT NULL DEFAULT 0.5,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at      TEXT,
        cancelled_at      TEXT,
        FOREIGN KEY (team_id)    REFERENCES teams(slack_team_id)    ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES channels(slack_channel_id) ON DELETE CASCADE,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_actions_team_status ON action_items(team_id, status);
      CREATE INDEX idx_actions_owner ON action_items(owner_user_id, status);
      CREATE INDEX idx_actions_due ON action_items(due_at) WHERE status IN ('open','in_progress');

      CREATE VIRTUAL TABLE actions_fts USING fts5(
        title, description, content='action_items', content_rowid='rowid'
      );

      CREATE TABLE action_external_refs (
        id                TEXT PRIMARY KEY,
        action_id         TEXT NOT NULL,
        system            TEXT NOT NULL
                          CHECK (system IN ('linear','jira','notion','github','google_docs','slack_canvas')),
        external_id       TEXT NOT NULL,
        url               TEXT NOT NULL,
        title             TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (system, external_id),
        FOREIGN KEY (action_id) REFERENCES action_items(id) ON DELETE CASCADE
      );

      CREATE TABLE topics (
        id                TEXT PRIMARY KEY,
        team_id           TEXT NOT NULL,
        label             TEXT NOT NULL,
        description       TEXT,
        last_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
        mention_count     INTEGER NOT NULL DEFAULT 1,
        UNIQUE (team_id, label),
        FOREIGN KEY (team_id) REFERENCES teams(slack_team_id) ON DELETE CASCADE
      );

      CREATE TABLE ingestion_runs (
        id                TEXT PRIMARY KEY,
        team_id           TEXT NOT NULL,
        started_at        TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at       TEXT,
        messages_ingested INTEGER NOT NULL DEFAULT 0,
        decisions_created INTEGER NOT NULL DEFAULT 0,
        actions_created   INTEGER NOT NULL DEFAULT 0,
        error             TEXT
      );

      CREATE TABLE proactive_events (
        id                TEXT PRIMARY KEY,
        team_id           TEXT NOT NULL,
        kind              TEXT NOT NULL
                          CHECK (kind IN ('surface_decision','action_followup','action_overdue','decision_update')),
        target_user_id    TEXT,
        target_channel_id TEXT,
        payload_json      TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at      TEXT,
        FOREIGN KEY (team_id) REFERENCES teams(slack_team_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_proactive_pending ON proactive_events(delivered_at, created_at);

      CREATE TABLE settings (
        team_id  TEXT NOT NULL,
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (team_id, key)
      );
    `,
  },
];

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare<[], { version: number }>('SELECT version FROM _migrations').all().map((r) => r.version),
  );

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)',
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    logger.info({ version: m.version, name: m.name }, 'storage: applying migration');
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      insertMigration.run(m.version, m.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      logger.error({ err, migration: m.name }, 'storage: migration failed');
      throw err;
    }
  }
}
