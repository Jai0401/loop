/**
 * Scheduled jobs — gentle follow-ups on overdue action items.
 *
 * Runs every 30 minutes. For each open action past its due_at that hasn't
 * been followed up with in the last 24 hours, send a DM to the owner.
 *
 * We use setInterval instead of a full cron library to keep dependencies lean.
 * For multi-process deploys swap to a real scheduler + distributed lock.
 */
import { WebClient } from '@slack/web-api';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { listActions, recordProactiveEvent, updateActionStatus } from '../storage/repo.js';
import { postOverdueDm } from '../slack/messages.js';

const TICK_MS = 30 * 60 * 1000; // 30 min
const FOLLOWUP_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

let _timer: NodeJS.Timeout | null = null;

export function startFollowupScheduler(getClient: () => WebClient): void {
  if (_timer) return;
  if (!env.LOOP_PROACTIVE_DM) {
    logger.info('followup: scheduler disabled by env flag');
    return;
  }
  _timer = setInterval(() => {
    runFollowupTick(getClient()).catch((err) => {
      logger.error({ err }, 'followup: tick failed');
    });
  }, TICK_MS);
  // also run immediately on boot for demo responsiveness
  runFollowupTick(getClient()).catch((err) => logger.error({ err }, 'followup: initial tick failed'));
  logger.info({ tick_ms: TICK_MS }, 'followup: scheduler started');
}

export function stopFollowupScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function runFollowupTick(client: WebClient): Promise<void> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - FOLLOWUP_COOLDOWN_MS).toISOString();

  // We don't have a "last followup at" column on actions in the schema (hackathon
  // speed) — use proactive_events table as the audit trail and dedupe by looking
  // up recent followup events for the same action.
  const overdue = listActions({
    team_id: env.SLACK_BOT_TOKEN ?? 'default', // demo: scope to single team
    status: 'overdue',
    due_before: now,
    limit: 100,
  });

  // Promote newly-overdue open items
  const open = listActions({
    team_id: env.SLACK_BOT_TOKEN ?? 'default',
    status: 'open',
    due_before: now,
    limit: 100,
  });
  for (const a of open) {
    updateActionStatus(a.id, 'overdue');
  }
  const allOverdue = [...overdue, ...open];

  for (const action of allOverdue) {
    if (!action.owner_user_id) continue;
    if (!action.due_at) continue;

    // Look up slack_user_id via JOIN
    const { getDb } = await import('../storage/db.js');
    const owner = getDb()
      .prepare<[string], { slack_user_id: string }>(
        `SELECT slack_user_id FROM users WHERE id = ?`,
      )
      .get(action.owner_user_id);
    if (!owner) continue;

    // Skip if we pinged in the last 24h
    const recent = getDb()
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM proactive_events
         WHERE kind = 'action_followup'
           AND target_user_id = ?
           AND payload_json LIKE ?
           AND created_at > ?`,
      )
      .get(
        action.owner_user_id,
        `%"action_id":"${action.id}"%`,
        cutoff,
      );
    if (recent) continue;

    try {
      await postOverdueDm(client, owner.slack_user_id, {
        title: action.title,
        due_at: action.due_at,
        source_thread_ts: action.source_thread_ts,
        channel_id: action.channel_id,
      });
      recordProactiveEvent({
        team_id: action.team_id,
        kind: 'action_followup',
        target_user_id: action.owner_user_id,
        target_channel_id: action.channel_id,
        payload: { action_id: action.id, due_at: action.due_at },
      });
      logger.info({ action_id: action.id }, 'followup: DM sent');
    } catch (err) {
      logger.error({ err, action_id: action.id }, 'followup: DM failed');
    }
  }
}
