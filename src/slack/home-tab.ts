/**
 * Block Kit Home tab — Loop's "memory dashboard".
 *
 * Two columns: live decisions (left) and open actions (right).
 * Search bar at the top opens a modal for full-text + semantic search.
 */
import type { App } from '@slack/bolt';
import type { View } from '@slack/types';
import { listActions, listDecisions } from '../storage/repo.js';
import type { ActionItem, Decision } from '../core/types.js';

export function registerHomeTabHandlers(app: App): void {
  app.event('app_home_opened', async ({ event, client, logger }) => {
    const teamId = (await client.auth.test()).team_id!;
    const view = buildHomeView(teamId);
    try {
      await client.views.publish({
        user_id: event.user,
        view,
      });
    } catch (err) {
      logger.error({ err }, 'home tab publish failed');
    }
  });

  app.action('loop_refresh_home', async ({ ack, body, client, logger }) => {
    await ack();
    const userId = 'user' in body ? body.user.id : (body as { user_id?: string }).user_id;
    if (!userId) return;
    const teamId = (await client.auth.test()).team_id!;
    try {
      await client.views.publish({ user_id: userId, view: buildHomeView(teamId) });
    } catch (err) {
      logger.error({ err }, 'home tab refresh failed');
    }
  });

  app.action('loop_open_search', async ({ ack, body, client }) => {
    await ack();
    const userId = 'user' in body ? body.user.id : (body as { user_id?: string }).user_id;
    if (!userId) return;
    await client.views.open({
      trigger_id: (body as { trigger_id?: string }).trigger_id ?? '',
      view: buildSearchModal(),
    });
  });

  app.view('loop_search_submit', async ({ ack, body, view, client }) => {
    await ack();
    const block = view.state.values.loop_search_block;
    const query =
      (block?.loop_search_input as { value?: string } | undefined)?.value ?? '';
    const teamId = (await client.auth.test()).team_id!;
    const results = await runSearch(teamId, query);
    await client.views.publish({
      user_id: body.user.id,
      view: buildHomeView(teamId, { query, results }),
    });
  });

  app.action('loop_mark_done', async ({ ack, body, client, logger }) => {
    await ack();
    const actionTs = (body as { actions?: Array<{ value?: string }> }).actions?.[0]?.value;
    if (!actionTs) return;
    // Find action item by source_thread_ts and mark done
    const teamId = (await client.auth.test()).team_id!;
    const { updateActionStatus } = await import('../storage/repo.js');
    const actions = listActions({ team_id: teamId, status: 'open' });
    const target = actions.find((a) => a.source_thread_ts === actionTs);
    if (target) {
      updateActionStatus(target.id, 'done');
      logger.info({ id: target.id }, 'marked action done via Slack');
      const userId = 'user' in body ? body.user.id : '';
      if (userId) {
        await client.views.publish({ user_id: userId, view: buildHomeView(teamId) });
      }
    }
  });
}

export function buildHomeView(
  teamId: string,
  opts: { query?: string; results?: SearchResults } = {},
): View {
  const decisions = listDecisions(teamId, 8);
  const actions = listActions({ team_id: teamId, status: ['open', 'in_progress', 'overdue'], limit: 8 });

  const decisionBlocks = decisions.length
    ? decisions.flatMap((d) => decisionCard(d))
    : [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '_No decisions yet — Loop will extract them as your team chats._' },
        },
      ];

  const actionBlocks = actions.length
    ? actions.flatMap(actionCard)
    : [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '_No open action items._' },
        },
      ];

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Loop — Your team’s memory', emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:sparkles: Decisions extracted from your conversations · :clipboard: Open action items tracked · :mag: Searchable forever`,
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Search memory' },
          action_id: 'loop_open_search',
          emoji: true,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Refresh' },
          action_id: 'loop_refresh_home',
          emoji: true,
        },
      ],
    },
    ...(opts.query
      ? [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:mag: Search results for *"${opts.query}"* — ${opts.results?.decisions.length ?? 0} decisions, ${opts.results?.actions.length ?? 0} actions` },
          },
        ]
      : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Recent decisions*' },
    },
    ...decisionBlocks,
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Open action items*' },
    },
    ...actionBlocks,
  ];

  return {
    type: 'home',
    blocks: blocks as View['blocks'],
  };
}

function decisionCard(d: Decision): unknown[] {
  const link = d.source_message_ts
    ? `(<https://slack.com/archives/${d.channel_id}/p${d.source_message_ts.replace('.', '')}|source>)`
    : '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${d.summary}* ${link}\n_${d.confidence} · ${new Date(d.created_at).toLocaleDateString()}_`,
      },
    },
  ];
}

function actionCard(a: ActionItem): unknown[] {
  const due = a.due_at ? ` · due ${new Date(a.due_at).toLocaleDateString()}` : '';
  const statusEmoji =
    a.status === 'overdue' ? ':warning:' : a.status === 'in_progress' ? ':hourglass_flowing_sand:' : ':clipboard:';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${a.title}* _(${a.priority}${due})_`,
      },
      accessory:
        a.source_thread_ts && a.channel_id
          ? {
              type: 'button',
              text: { type: 'plain_text', text: 'Open' },
              url: `https://slack.com/archives/${a.channel_id}/p${a.source_thread_ts.replace('.', '')}`,
            }
          : undefined,
    },
  ];
}

function buildSearchModal(): View {
  return {
    type: 'modal',
    callback_id: 'loop_search_submit',
    title: { type: 'plain_text', text: 'Search Loop memory' },
    submit: { type: 'plain_text', text: 'Search' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'loop_search_block',
        element: {
          type: 'plain_text_input',
          action_id: 'loop_search_input',
          placeholder: { type: 'plain_text', text: 'What did we decide about auth?' },
        },
        label: { type: 'plain_text', text: 'Query' },
      },
    ],
  };
}

export interface SearchResults {
  decisions: Decision[];
  actions: ActionItem[];
}

async function runSearch(teamId: string, query: string): Promise<SearchResults> {
  const { searchDecisionsFts, listActions } = await import('../storage/repo.js');
  const decisions = query ? searchDecisionsFts(teamId, query, 20) : [];
  const actions = listActions({ team_id: teamId, limit: 50 }).filter((a) =>
    query ? a.title.toLowerCase().includes(query.toLowerCase()) : true,
  );
  return { decisions, actions };
}
