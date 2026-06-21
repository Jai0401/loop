/**
 * /loop slash command.
 *
 * Power-user shortcut — the same LLM agent handles /loop just like an @-mention,
 * but with a structured prompt. No command-specific templates or regex.
 *
 *   /loop                           → "summarize everything"
 *   /loop search <query>            → /loop find decisions about <query>
 *   /loop decide <text>             → /loop record this decision: <text>
 *   /loop action <text>             → /loop record this action: <text>
 *   /loop anything else             → forwarded to agent as-is
 */
import type { App } from '@slack/bolt';
import { runAgent, type AgentContext } from '../ai/agent.js';

export function registerSlashCommands(app: App): void {
  app.command('/loop', async ({ command, ack, client, logger, respond }) => {
    logger.info({ command: command.command, text: command.text, user: command.user_id }, 'slack: /loop command');
    await ack();

    const teamId = command.team_id;
    const userId = command.user_id;
    const channelId = command.channel_id;
    const userName = command.user_name;
    const args = (command.text ?? '').trim();

    // Friendly prefix translations — keeps muscle memory from Slack-tradition apps.
    // These are convenience shims only; the agent does the real interpretation.
    let prompt: string;
    if (!args) {
      prompt = 'Give me a quick digest of recent decisions and open action items.';
    } else if (/^search\s+/i.test(args)) {
      prompt = `Find prior decisions about: ${args.replace(/^search\s+/i, '')}`;
    } else if (/^decide\s+/i.test(args)) {
      prompt = `Record this as a team decision (use record_decision tool): ${args.replace(/^decide\s+/i, '')}`;
    } else if (/^action\s+/i.test(args)) {
      prompt = `Record this as an action item (use record_action tool, parse any owner or due date from the text): ${args.replace(/^action\s+/i, '')}`;
    } else if (/^digest$/i.test(args)) {
      prompt = 'Generate a digest of recent decisions and open action items.';
    } else {
      prompt = args;
    }

    const ctx: AgentContext = {
      team_id: teamId,
      channel_id: channelId,
      user_id: userId,
      user_name: userName,
      recent_messages: [],
    };

    try {
      const result = await runAgent(prompt, ctx, { verbose: true });
      await respond(result.response);
    } catch (err) {
      logger.error({ err }, 'slash command: agent failed');
      await respond(`:warning: Something went wrong: ${(err as Error).message ?? 'unknown'}`);
    }
  });
}