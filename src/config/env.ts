/**
 * Centralized environment configuration with validation.
 * Zod-parsed at startup — fail fast if anything is missing.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().optional().transform(stripEmpty),
  SLACK_SIGNING_SECRET: z.string().optional().transform(stripEmpty),
  SLACK_APP_TOKEN: z.string().optional().transform(stripEmpty),
  SLACK_CLIENT_ID: z.string().optional().transform(stripEmpty),
  SLACK_CLIENT_SECRET: z.string().optional().transform(stripEmpty),
  SLACK_STATE_SECRET: z.string().optional().transform(stripEmpty),

  // Anthropic (Claude)
  ANTHROPIC_API_KEY: z.string().optional().transform(stripEmpty),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  // Database
  DATABASE_PATH: z.string().default('./data/loop.db'),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // MCP server
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('http'),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3001),
  MCP_HTTP_PATH: z.string().default('/mcp'),

  // Feature flags
  LOOP_PROACTIVE_DM: z.coerce.boolean().default(true),
  LOOP_PROACTIVE_SURFACE: z.coerce.boolean().default(true),
});

export type Env = z.infer<typeof EnvSchema>;

function stripEmpty(s: string | undefined): string | undefined {
  return s && s.length > 0 ? s : undefined;
}

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/**
 * Validate that the runtime mode has everything it needs.
 * Called after env parsing but before app start.
 */
export function validateRuntimeMode(opts: { allowInTests?: boolean } = {}): void {
  const useSocketMode = Boolean(env.SLACK_APP_TOKEN);
  const useHttpMode = Boolean(env.SLACK_SIGNING_SECRET && env.SLACK_BOT_TOKEN);

  if (!useSocketMode && !useHttpMode && !opts.allowInTests) {
    throw new Error(
      'Either SLACK_APP_TOKEN (socket mode) or SLACK_SIGNING_SECRET+SLACK_BOT_TOKEN (HTTP) must be set',
    );
  }

  if (!env.ANTHROPIC_API_KEY && !opts.allowInTests) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set — AI extraction will be skipped (dev mode only).');
  }
}
