/**
 * Slack event handlers — the ingestion spine of Loop.
 *
 * Pipeline: new message event → resolve channel + users → ingest message →
 *   fetch thread context (if any) → call AI extractor → write decisions/actions/topics →
 *   optionally surface related past decisions in the thread.
 */
import type { App } from '@slack/bolt';
import { extractFromBatch } from '../ai/extractor.js';
import { logger } from '../core/logger.js';
import {
  createAction,
  createDecision,
  findSimilarDecisions,
  findUserBySlackId,
  ingestMessage,
  recordProactiveEvent,
  upsertChannel,
  upsertUser,
} from '../storage/repo.js';
import { env } from '../config/env.js';
import type { SlackMessage } from '../core/types.js';
import { postSurfaceMessage } from './messages.js';

export function registerHandlers(app: App): void {
  app.event('message', async ({ event, client, logger: slog }) => {
    // Ignore messages from bots, edits, deletes, etc.
    if (event.subtype && event.subtype !== 'thread_broadcast') return;
    if (!('text' in event) || !event.text) return;
    if (!event.user) return; // bot messages have no user

    const teamId = (await client.auth.test()).team_id!;
    const channelId = event.channel;
    const ts = event.ts;
    const threadTs = event.thread_ts;
    const slackUserId = event.user;
    const messageText: string = event.text;

    try {
      // 1. Resolve user info (cached)
      let user = findUserBySlackId(slackUserId, teamId);
      if (!user) {
        const info = await client.users.info({ user: slackUserId });
        if (info.ok && info.user) {
          user = upsertUser({
            slack_user_id: slackUserId,
            slack_team_id: teamId,
            display_name: info.user.profile?.display_name || info.user.name || slackUserId,
            real_name: info.user.profile?.real_name,
            avatar_url: info.user.profile?.image_192,
          });
        }
      } else {
        // refresh name opportunistically (cheap)
        const info = await client.users.info({ user: slackUserId });
        if (info.ok && info.user) {
          upsertUser({
            slack_user_id: slackUserId,
            slack_team_id: teamId,
            display_name: info.user.profile?.display_name || info.user.name || slackUserId,
            real_name: info.user.profile?.real_name,
            avatar_url: info.user.profile?.image_192,
          });
        }
      }

      // 2. Resolve channel info (cached)
      let channelName = channelId;
      try {
        const cinfo = await client.conversations.info({ channel: channelId });
        if (cinfo.ok && cinfo.channel) {
          channelName = cinfo.channel.name ?? channelId;
          upsertChannel({
            slack_channel_id: channelId,
            slack_team_id: teamId,
            name: channelName,
            is_private: cinfo.channel.is_private,
            is_archived: cinfo.channel.is_archived,
          });
        }
      } catch (err) {
        slog.warn({ err, channelId }, 'channel info failed');
      }

      // 3. Ingest the message (idempotent on (channel, ts))
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

      // 4. Build the batch (this message + recent thread siblings for context)
      const batchMessages: SlackMessage[] = [
        {
          ts,
          thread_ts: threadTs,
          channel: channelId,
          user: slackUserId,
          text: event.text,
        },
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
              if (m.ts === ts) continue; // already added above
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

      // 5. AI extract
      const oldest_ts = batchMessages[0]?.ts ?? ts;
      const latest_ts = batchMessages[batchMessages.length - 1]?.ts ?? ts;

      const extraction = await extractFromBatch(
        { channel: channelId, messages: batchMessages, oldest_ts, latest_ts },
        { verbose: true },
      );

      // 6. Persist decisions
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

      // 7. Persist action items
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

      // 8. Surface related past decisions if asked
      if (env.LOOP_PROACTIVE_SURFACE && threadTs === ts) {
        // only on top-level message in a thread
        const similar = findSimilarDecisions(teamId, event.text, 3);
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

  // When Loop is @-mentioned, treat as a query.
  app.event('app_mention', async ({ event, client, say }) => {
    if (!('text' in event) || !event.text) return;
    const query = event.text.replace(/<@[^>]+>/g, '').trim();
    const teamId = (await client.auth.test()).team_id!;

    const similar = findSimilarDecisions(teamId, query, 5);
    if (similar.length === 0) {
      await say({
        thread_ts: event.ts,
        text: `:mag: No prior decisions found matching "${query}". I'll start tracking from this conversation.`,
      });
      return;
    }

    const lines = similar
      .map((d, i) => `${i + 1}. *${d.summary}* — _${d.confidence} confidence_`)
      .join('\n');
    await say({
      thread_ts: event.ts,
      text: `:sparkles: Found ${similar.length} related decision${similar.length === 1 ? '' : 's'}:\n${lines}`,
    });
  });
}
