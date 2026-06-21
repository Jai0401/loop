/**
 * Slack Bolt app — entrypoint for the Slack side of Loop.
 *
 * Socket Mode preferred for dev (no public URL needed).
 * HTTP mode for prod. The runtime mode is auto-detected from env.
 */
import { App, LogLevel, SocketModeReceiver, type AppOptions } from '@slack/bolt';
import { env, validateRuntimeMode } from '../config/env.js';
import { logger } from '../core/logger.js';
import { registerHandlers } from './handlers.js';
import { registerHomeTabHandlers } from './home-tab.js';
import { registerSlashCommands } from './slash-commands.js';

let _app: App | null = null;

export function getSlackApp(): App {
  if (_app) return _app;
  validateRuntimeMode();

  const logLevel = env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO;

  const opts: AppOptions = {
    logLevel,
    customRoutes: [],
    // When using socket mode, Bolt handles OAuth internally;
    // when using HTTP, you must expose a /slack/events endpoint.
    ...(env.SLACK_APP_TOKEN
      ? {
          socketMode: true,
          appToken: env.SLACK_APP_TOKEN,
          ...(env.SLACK_BOT_TOKEN ? { token: env.SLACK_BOT_TOKEN } : {}),
        }
      : {
          token: env.SLACK_BOT_TOKEN!,
          signingSecret: env.SLACK_SIGNING_SECRET!,
        }),
  };

  const app = new App(opts);

  registerHandlers(app);
  registerHomeTabHandlers(app);
  registerSlashCommands(app);

  app.error(async (err) => {
    logger.error({ err }, 'slack: unhandled error');
  });

  _app = app;
  logger.info(
    { socketMode: Boolean(env.SLACK_APP_TOKEN) },
    'slack: Bolt app constructed',
  );
  return app;
}

export async function startSlackApp(): Promise<void> {
  const app = getSlackApp();
  if (env.SLACK_APP_TOKEN) {
    await app.start();
    logger.info('slack: running in socket mode');
  } else {
    await app.start(env.PORT);
    logger.info({ port: env.PORT }, 'slack: running in HTTP mode');
  }
}
