/**
 * Slash commands for power users.
 *
 *   /loop search <query>   — semantic + FTS search
 *   /loop decide <text>    — manually record a decision
 *   /loop action <text>    — manually record an action item
 *   /loop digest           — top 5 recent decisions + open actions
 */
import type { App } from '@slack/bolt';

export function registerSlashCommands(app: App): void {
  app.command('/loop', async ({ command, ack, client, logger, respond }) => {
    await ack();
    const args = (command.text ?? '').trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase();

    const teamId = command.team_id;
    const userId = command.user_id;
    const channelId = command.channel_id;

    try {
      switch (subcommand) {
        case 'search': {
          const query = args.slice(1).join(' ');
          if (!query) {
            await respond('Usage: `/loop search <query>`');
            return;
          }
          const { searchDecisionsFts, listActions } = await import('../storage/repo.js');
          const decisions = searchDecisionsFts(teamId, query, 10);
          const actions = listActions({ team_id: teamId, limit: 50 }).filter((a) =>
            a.title.toLowerCase().includes(query.toLowerCase()),
          );
          const lines = [
            `:mag: *${decisions.length} decision${decisions.length === 1 ? '' : 's'}* matching "${query}":`,
            ...decisions.map((d, i) => `  ${i + 1}. ${d.summary}`),
            ``,
            `:clipboard: *${actions.length} action${actions.length === 1 ? '' : 's'}*:`,
            ...actions.map((a) => `  • ${a.title}`),
          ];
          await respond(lines.join('\n'));
          break;
        }
        case 'decide': {
          const text = args.slice(1).join(' ');
          if (!text) {
            await respond('Usage: `/loop decide <what was decided>`');
            return;
          }
          const { createDecision, upsertChannel, upsertUser } = await import('../storage/repo.js');
          upsertUser({
            slack_user_id: userId,
            slack_team_id: teamId,
            display_name: command.user_name,
          });
          upsertChannel({
            slack_channel_id: channelId,
            slack_team_id: teamId,
            name: command.channel_name,
          });
          createDecision({
            team_id: teamId,
            channel_id: channelId,
            summary: text,
            participants: [],
            confidence: 'stated',
            source_message_ts: command.ts,
          });
          await respond(`:white_check_mark: Decision recorded: *"${text}"*`);
          break;
        }
        case 'action': {
          const text = args.slice(1).join(' ');
          if (!text) {
            await respond('Usage: `/loop action <what needs doing>`');
            return;
          }
          const { createAction, upsertChannel, upsertUser } = await import('../storage/repo.js');
          const owner = findUserFromText(text);
          if (owner) {
            upsertUser({
              slack_user_id: owner,
              slack_team_id: teamId,
              display_name: owner,
            });
          }
          upsertChannel({
            slack_channel_id: channelId,
            slack_team_id: teamId,
            name: command.channel_name,
          });
          createAction({
            team_id: teamId,
            channel_id: channelId,
            title: text,
            owner_user_id: owner ?? undefined,
            confidence: 1.0,
            source_message_ts: command.ts,
          });
          await respond(`:clipboard: Action item recorded: *"${text}"*`);
          break;
        }
        case 'digest': {
          const { listDecisions, listActions } = await import('../storage/repo.js');
          const decisions = listDecisions(teamId, 5);
          const actions = listActions({
            team_id: teamId,
            status: ['open', 'in_progress', 'overdue'],
            limit: 10,
          });
          const lines = [
            `:sparkles: *Top 5 recent decisions*`,
            ...(decisions.length
              ? decisions.map((d, i) => `  ${i + 1}. ${d.summary}`)
              : [`  _none yet_`]),
            ``,
            `:clipboard: *${actions.length} open action item${actions.length === 1 ? '' : 's'}*`,
            ...(actions.length
              ? actions.map((a) => `  • ${a.title}${a.due_at ? ` (due ${new Date(a.due_at).toLocaleDateString()})` : ''}`)
              : [`  _none — inbox zero!_`]),
          ];
          await respond(lines.join('\n'));
          break;
        }
        default:
          await respond(
            ':sparkles: *Loop commands*\n• `/loop search <query>` — search past decisions\n• `/loop decide <text>` — record a decision\n• `/loop action <text>` — record an action item\n• `/loop digest` — recent decisions + open actions',
          );
      }
    } catch (err) {
      logger.error({ err, subcommand }, 'slash command failed');
      await respond(':warning: Something went wrong. Try again or check the logs.');
    }
  });
}

function findUserFromText(text: string): string | undefined {
  const m = text.match(/<@(U[A-Z0-9]+)>/);
  if (m) return m[1];
  // also support "for @name"
  const m2 = text.match(/(?:for|by|to)\s+@(\w+)/);
  return m2?.[1];
}
