/**
 * Slack event handlers — ingestion spine of Loop.
 *
 * Two responsibilities:
 *   1. Passive message ingestion: every message gets stored, and the LLM
 *      extractor pulls out decisions/actions/topics. No regex, no heuristics.
 *   2. Proactive mention routing: when Loop is @-mentioned, we hand the
 *      user's natural-language query to the LLM agent, which decides what
 *      to do and replies conversationally.
 *
 * Reactions provide visual feedback only on @-mentions (passive messages
 * stay quiet to avoid spam).
 */
import type { App } from '@slack/bolt';
import { extractFromBatch } from '../ai/extractor.js';
import { runAgent, type AgentContext } from '../ai/agent.js';
import { logger } from '../core/logger.js';
import {
  createAction,
  createDecision,
  findUserBySlackId,
  ingestMessage,
  recordProactiveEvent,
  upsertChannel,
  upsertTeam,
  upsertUser,
} from '../storage/repo.js';
import { env } from '../config/env.js';
import type { SlackMessage } from '../core/types.js';
import {
  addReaction,
  postSurfaceMessage,
  removeReaction,
} from './messages.js';

const MAX_RECENT_FOR_AGENT = 15;

export function registerHandlers(app: App): void {
  /* ---------------- Passive message ingestion ---------------- */

  app.event('message', async ({ event, client, logger: slog }) => {
    if (event.subtype && event.subtype !== 'thread_broadcast') return;
    if (!('text' in event) || !event.text) return;
    if (!event.user) return; // bot messages have no user

    const teamId = (await client.auth.test()).team_id!;
    const channelId = event.channel;
    const ts = event.ts;
    const threadTs = event.thread_ts;
    const slackUserId = event.user;
    const messageText: string = event.text;

    // Only show reaction feedback when the user explicitly invoked Loop.
    const authInfo = await client.auth.test();
    const botUserId = authInfo.user_id ?? '';
    const isMentioned = botUserId && messageText.includes(`<@${botUserId}>`);
    const isAddressed = /^\s*loop\b/i.test(messageText);
    const wantsFeedback = Boolean(isMentioned || isAddressed);

    if (wantsFeedback) {
      addReaction(client, channelId, ts, 'eyes').catch(() => {});
    }

    try {
      upsertTeam(teamId, 'unknown');

      // Resolve user info (cached)
      const user = await ensureUser(client, slackUserId, teamId);
      if (!user) return; // couldn't resolve user — bail silently

      // Resolve channel info
      try {
        const cinfo = await client.conversations.info({ channel: channelId });
        if (cinfo.ok && cinfo.channel) {
          upsertChannel({
            slack_channel_id: channelId,
            slack_team_id: teamId,
            name: cinfo.channel.name ?? channelId,
            is_private: cinfo.channel.is_private,
            is_archived: cinfo.channel.is_archived,
          });
        }
      } catch (err) {
        slog.warn({ err, channelId }, 'channel info failed');
      }

      // Ingest the message (idempotent on (channel, ts))
      const ingested = ingestMessage({
        team_id: teamId,
        channel_id: channelId,
        ts,
        thread_ts: threadTs,
        user_id: slackUserId,
        text: messageText,
        is_edited: false,
      });
      if (!ingested) {
        slog.debug({ ts }, 'message already ingested');
        return;
      }

      // Build the batch — this message + recent thread siblings for context
      const batchMessages: SlackMessage[] = [
        { ts, thread_ts: threadTs, channel: channelId, user: slackUserId, text: messageText },
      ];

      if (threadTs && threadTs !== ts) {
        try {
          const replies = await client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: 30,
          });
          if (replies.ok && replies.messages) {
            for (const m of replies.messages) {
              if (!('user' in m) || !m.user || !('text' in m) || !m.text || !m.ts) continue;
              if (m.ts === ts) continue;
              batchMessages.push({
                ts: m.ts,
                thread_ts: m.thread_ts ?? threadTs,
                channel: channelId,
                user: m.user,
                text: m.text,
              });
            }
          }
        } catch (err) {
          slog.warn({ err, threadTs }, 'thread fetch failed');
        }
      }

      batchMessages.sort((a, b) => a.ts.localeCompare(b.ts));

      // LLM extraction
      const oldest_ts = batchMessages[0]?.ts ?? ts;
      const latest_ts = batchMessages[batchMessages.length - 1]?.ts ?? ts;

      const extraction = await extractFromBatch(
        { channel: channelId, messages: batchMessages, oldest_ts, latest_ts },
        { verbose: true },
      );

      // Persist decisions
      for (const d of extraction.decisions) {
        const participantIds = d.participant_slack_ids
          .map((sid) => findUserBySlackId(sid, teamId)?.id)
          .filter((id): id is string => Boolean(id));
        createDecision({
          team_id: teamId,
          channel_id: channelId,
          summary: d.summary,
          rationale: d.rationale,
          source_message_ts: d.source_message_ts,
          source_thread_ts: threadTs,
          participants: participantIds,
          confidence: d.confidence,
        });
      }

      // Persist action items
      for (const a of extraction.action_items) {
        const ownerId = a.owner_slack_id
          ? findUserBySlackId(a.owner_slack_id, teamId)?.id
          : undefined;
        createAction({
          team_id: teamId,
          channel_id: channelId,
          title: a.title,
          description: a.description,
          source_message_ts: a.source_message_ts,
          source_thread_ts: threadTs,
          owner_user_id: ownerId,
          due_at: a.due_iso,
          priority: a.priority,
          confidence: a.confidence,
        });
      }

      slog.info(
        {
          decisions: extraction.decisions.length,
          actions: extraction.action_items.length,
          topics: extraction.topics.length,
        },
        'ingestion complete',
      );

      // Visual feedback: only when explicitly invoked
      if (wantsFeedback) {
        const foundCount = extraction.decisions.length + extraction.action_items.length;
        if (foundCount > 0) {
          removeReaction(client, channelId, ts, 'eyes').catch(() => {});
          addReaction(client, channelId, ts, 'white_check_mark').catch(() => {});
        } else if (extraction.topics.length > 0) {
          removeReaction(client, channelId, ts, 'eyes').catch(() => {});
          addReaction(client, channelId, ts, 'memo').catch(() => {});
        } else {
          removeReaction(client, channelId, ts, 'eyes').catch(() => {});
          addReaction(client, channelId, ts, 'large_green_circle').catch(() => {});
        }
      }

      // Proactive surface of related past decisions (only on top-level messages in a thread)
      if (env.LOOP_PROACTIVE_SURFACE && threadTs === ts && extraction.decisions.length > 0) {
        const similar = await findRelatedDecisions(teamId, extraction.decisions[0]!.summary);
        const strongMatches = similar.filter((s) => s.score > 0.45);
        if (strongMatches.length > 0) {
          await postSurfaceMessage(client, channelId, ts, strongMatches);
          for (const m of strongMatches) {
            recordProactiveEvent({
              team_id: teamId,
              kind: 'surface_decision',
              target_channel_id: channelId,
              payload: { decision_id: m.id, score: m.score, source_message_ts: ts },
            });
          }
        }
      }
    } catch (err) {
      logger.error({ err, ts, channelId }, 'message handler failed');
    }
  });

  /* ---------------- @-mention: route to LLM agent ---------------- */

  app.event('app_mention', async ({ event, client, say }) => {
    logger.info({ ts: event.ts, channel: event.channel }, 'slack: app_mention received');
    if (!('text' in event) || !event.text) return;
    if (!event.user) return;

    addReaction(client, event.channel, event.ts, 'eyes').catch(() => {});

    const teamId = (await client.auth.test()).team_id!;
    const query = event.text.replace(/<@[^>]+>/g, '').trim();
    const userId = event.user;

    // Resolve the invoker's display name
    let userName = userId;
    try {
      const info = await client.users.info({ user: userId });
      if (info.ok && info.user) {
        userName = info.user.profile?.display_name || info.user.name || userId;
      }
    } catch {
      // ignore
    }

    // Fetch recent channel context so the agent knows what's being discussed
    const recent = await fetchRecentMessages(client, event.channel, 30, event.thread_ts ?? event.ts);

    const ctx: AgentContext = {
      team_id: teamId,
      channel_id: event.channel,
      user_id: userId,
      user_name: userName,
      recent_messages: recent,
    };

    try {
      const result = await runAgent(query || 'hello', ctx, { verbose: true });
      removeReaction(client, event.channel, event.ts, 'eyes').catch(() => {});
      addReaction(client, event.channel, event.ts, 'white_check_mark').catch(() => {});

      await say({
        thread_ts: event.ts,
        text: result.response,
      });
    } catch (err) {
      logger.error({ err }, 'agent failed');
      removeReaction(client, event.channel, event.ts, 'eyes').catch(() => {});
      addReaction(client, event.channel, event.ts, 'warning').catch(() => {});
      await say({
        thread_ts: event.ts,
        text: `:warning: Something went wrong while I was thinking. ${(err as Error).message ?? ''}`.trim(),
      });
    }
  });
}

/* ----------------------------- Helpers ----------------------------- */

async function ensureUser(
  client: import('@slack/web-api').WebClient,
  slackUserId: string,
  teamId: string,
): Promise<{ id: string; display_name: string } | null> {
  const existing = findUserBySlackId(slackUserId, teamId);
  try {
    const info = await client.users.info({ user: slackUserId });
    if (!info.ok || !info.user) return existing ? { id: existing.id, display_name: existing.display_name } : null;
    const display_name = info.user.profile?.display_name || info.user.name || slackUserId;
    return upsertUser({
      slack_user_id: slackUserId,
      slack_team_id: teamId,
      display_name,
      real_name: info.user.profile?.real_name,
      avatar_url: info.user.profile?.image_192,
    });
  } catch {
    return existing ? { id: existing.id, display_name: existing.display_name } : null;
  }
}

async function fetchRecentMessages(
  client: import('@slack/web-api').WebClient,
  channelId: string,
  limit: number,
  upToTs?: string,
): Promise<Array<{ ts: string; user: string; text: string }>> {
  try {
    const res = await client.conversations.history({
      channel: channelId,
      limit,
      ...(upToTs ? { latest: upToTs } : {}),
    });
    if (!res.ok || !res.messages) return [];
    return res.messages
      .filter((m): m is { ts: string; user?: string; text?: string } => Boolean(m.ts && m.text))
      .map((m) => ({ ts: m.ts, user: m.user ?? 'unknown', text: m.text ?? '' }))
      .reverse(); // oldest first
  } catch {
    return [];
  }
}

async function findRelatedDecisions(teamId: string, query: string) {
  const { findSimilarDecisions } = await import('../storage/repo.js');
  return findSimilarDecisions(teamId, query, 3);
}