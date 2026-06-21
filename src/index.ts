/**
 * Loop — Slack AI Memory Layer
 *
 * Entry point. Wires up:
 *   - Slack Bolt app (socket or HTTP mode)
 *   - MCP server (HTTP or stdio)
 *   - Follow-up scheduler
 *   - Graceful shutdown
 */
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { closeDb, getDb } from './storage/db.js';
import { getSlackApp, startSlackApp } from './slack/app.js';
import { startMcpServer } from './mcp/server.js';
import { startFollowupScheduler } from './scheduled/follow-ups.js';

async function main(): Promise<void> {
  logger.info(
    {
      env: env.NODE_ENV,
      log_level: env.LOG_LEVEL,
      db: env.DATABASE_PATH,
      socket_mode: Boolean(env.SLACK_APP_TOKEN),
    },
    'loop: starting',
  );

  // Force DB initialization (runs migrations).
  getDb();

  // Start Slack app.
  await startSlackApp();

  // Start MCP server.
  await startMcpServer();

  // Start scheduled follow-ups.
  const slackApp = getSlackApp();
  startFollowupScheduler(() => slackApp.client as unknown as import('@slack/web-api').WebClient);

  logger.info('loop: all systems up');
}

main().catch((err) => {
  logger.fatal({ err }, 'loop: startup failed');
  process.exit(1);
});

/* --------------------------- Graceful shutdown --------------------------- */

function shutdown(signal: string): void {
  logger.info({ signal }, 'loop: shutting down');
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
