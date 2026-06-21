/**
 * Slack message helpers — building Block Kit messages and posting them.
 *
 * Loop posts two kinds of messages proactively:
 *   1. "Surface" reply in a thread when a new top-level message references
 *      a past decision.
 *   2. Direct messages to action item owners when their items go overdue.
 */
import type { WebClient } from '@slack/web-api';
import type { Block, KnownBlock } from '@slack/types';
import type { Decision } from '../core/types.js';

export async function postSurfaceMessage(
  client: WebClient,
  channelId: string,
  threadTs: string,
  matches: Array<Decision & { score: number }>,
): Promise<void> {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:sparkles: *Loop found ${matches.length} related decision${matches.length === 1 ? '' : 's'} from past conversations:*`,
      },
    },
    { type: 'divider' },
  ];

  for (const m of matches.slice(0, 3)) {
    const link = m.source_message_ts
      ? `(<https://slack.com/archives/${channelId}/p${m.source_message_ts.replace('.', '')}|jump to source>)`
      : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `• *${m.summary}* ${link}\n  _${m.confidence} · ${new Date(m.created_at).toLocaleDateString()}_`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '_Surfaced by Loop · open the App Home to see all decisions_',
      },
    ],
  });

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `Loop surfaced ${matches.length} related decisions`,
    blocks,
  });
}

export async function postOverdueDm(
  client: WebClient,
  userId: string,
  action: {
    title: string;
    due_at?: string;
    source_thread_ts?: string;
    channel_id: string;
  },
): Promise<void> {
  const dueText = action.due_at
    ? `Was due ${new Date(action.due_at).toLocaleString()}`
    : 'Needs your attention';
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wave: *Loop checking in*\n\nYou have an open action item that's overdue:\n\n*${action.title}*\n_${dueText}_`,
      },
    },
  ];

  if (action.source_thread_ts) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open thread' },
          url: `https://slack.com/archives/${action.channel_id}/p${action.source_thread_ts.replace('.', '')}`,
          action_id: 'loop_open_thread',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark done' },
          value: action.source_thread_ts,
          action_id: 'loop_mark_done',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Extend deadline' },
          value: action.source_thread_ts,
          action_id: 'loop_extend',
        },
      ],
    });
  }

  await client.chat.postMessage({
    channel: userId,
    text: `Loop: action item "${action.title}" needs your attention`,
    blocks,
  });
}
