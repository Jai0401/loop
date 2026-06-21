/**
 * Loop MCP server — exposes Loop's memory layer to any MCP-aware agent.
 *
 * Resources:
 *   loop://decisions          — recent decisions across team
 *   loop://decisions/{id}     — single decision with full context
 *   loop://actions            — open action items
 *   loop://actions/{id}       — single action item
 *   loop://search?query=...   — semantic + FTS search
 *
 * Tools:
 *   create_linear_ticket      — push an action item to Linear (mock for now)
 *   create_jira_issue         — push an action item to Jira (mock for now)
 *   save_to_notion            — save a decision to Notion (mock for now)
 *   mark_action_done          — close out a tracked action
 *   summarize_team            — generate a digest of recent activity
 *
 * Transport: HTTP (StreamableHTTPServerTransport) on MCP_HTTP_PORT.
 * stdio is also supported for local dev.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import {
  attachExternalRef,
  listActions,
  listDecisions,
  searchDecisionsFts,
  updateActionStatus,
} from '../storage/repo.js';

let _server: McpServer | null = null;

export function buildMcpServer(): McpServer {
  if (_server) return _server;
  const server = new McpServer({
    name: 'loop-memory',
    version: '0.1.0',
  });

  registerResources(server);
  registerTools(server);

  _server = server;
  return server;
}

/* --------------------------- Resources --------------------------- */

function registerResources(server: McpServer): void {
  server.registerResource(
    'decisions_list',
    'loop://decisions',
    {
      description: 'Recent decisions extracted from Slack conversations',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const teamId = uri.searchParams.get('team') ?? 'default';
      const decisions = listDecisions(teamId, 50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(decisions, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'decision_single',
    new ResourceTemplate('loop://decisions/{id}', { list: undefined }),
    {
      description: 'Single decision with full context',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const id = uri.pathname.split('/').pop() ?? '';
      const teamId = uri.searchParams.get('team') ?? 'default';
      const decisions = listDecisions(teamId, 500);
      const decision = decisions.find((d) => d.id === id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(decision ?? { error: 'not_found' }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'actions_list',
    'loop://actions',
    {
      description: 'Open action items',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const teamId = uri.searchParams.get('team') ?? 'default';
      const actions = listActions({
        team_id: teamId,
        status: ['open', 'in_progress', 'overdue'],
        limit: 200,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(actions, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'search',
    'loop://search',
    {
      description: 'Search Loop memory semantically + by keyword',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const teamId = uri.searchParams.get('team') ?? 'default';
      const query = uri.searchParams.get('query') ?? '';
      const decisions = searchDecisionsFts(teamId, query, 50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ query, decisions }, null, 2),
          },
        ],
      };
    },
  );
}

/* --------------------------- Tools --------------------------- */

function registerTools(server: McpServer): void {
  server.registerTool(
    'create_linear_ticket',
    {
      title: 'Create Linear ticket from action item',
      description: 'Pushes a Loop action item to Linear as a ticket. Returns the created ticket URL.',
      inputSchema: {
        action_id: z.string().describe('The Loop action item id to push'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
      },
    },
    async ({ action_id, priority }) => {
      const teamId = 'default';
      const actions = listActions({ team_id: teamId, limit: 500 });
      const action = actions.find((a) => a.id === action_id);
      if (!action) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'action_not_found', action_id }) }],
        };
      }
      // MOCK: real implementation would POST to Linear GraphQL.
      const mockTicketId = `LOOP-${Math.floor(Math.random() * 9000) + 1000}`;
      const mockUrl = `https://linear.app/loop-demo/issue/${mockTicketId}`;
      attachExternalRef(action_id, {
        system: 'linear',
        external_id: mockTicketId,
        url: mockUrl,
        title: action.title,
        created_at: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ok: true, ticket_id: mockTicketId, ticket_url: mockUrl, priority, action_id },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_jira_issue',
    {
      title: 'Create Jira issue from action item',
      description: 'Pushes a Loop action item to Jira. Returns the created issue key.',
      inputSchema: {
        action_id: z.string(),
        project_key: z.string().describe('Jira project key, e.g. "ENG"'),
        issue_type: z.enum(['task', 'story', 'bug']).default('task'),
      },
    },
    async ({ action_id, project_key, issue_type }) => {
      const teamId = 'default';
      const actions = listActions({ team_id: teamId, limit: 500 });
      const action = actions.find((a) => a.id === action_id);
      if (!action) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'action_not_found' }) }],
        };
      }
      const mockKey = `${project_key}-${Math.floor(Math.random() * 9000) + 1000}`;
      const mockUrl = `https://acme.atlassian.net/browse/${mockKey}`;
      attachExternalRef(action_id, {
        system: 'jira',
        external_id: mockKey,
        url: mockUrl,
        title: action.title,
        created_at: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, issue_key: mockKey, issue_url: mockUrl, issue_type, action_id }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'save_to_notion',
    {
      title: 'Save decision to Notion',
      description: 'Persists a Loop decision into a Notion page for long-form archival.',
      inputSchema: {
        decision_id: z.string(),
        database_id: z.string().describe('Target Notion database id'),
      },
    },
    async ({ decision_id, database_id }) => {
      const teamId = 'default';
      const decisions = listDecisions(teamId, 500);
      const decision = decisions.find((d) => d.id === decision_id);
      if (!decision) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'decision_not_found' }) }],
        };
      }
      const mockPageId = `notion-page-${Math.random().toString(36).slice(2, 10)}`;
      const mockUrl = `https://notion.so/loop-demo/${mockPageId}`;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ok: true, page_id: mockPageId, page_url: mockUrl, database_id, decision_id },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'mark_action_done',
    {
      title: 'Mark Loop action item as done',
      description: 'Closes out a tracked action item.',
      inputSchema: {
        action_id: z.string(),
      },
    },
    async ({ action_id }) => {
      updateActionStatus(action_id, 'done');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, action_id, status: 'done' }) }],
      };
    },
  );

  server.registerTool(
    'summarize_team',
    {
      title: 'Generate team memory digest',
      description: 'Returns a structured digest of recent decisions and open actions — perfect for standups or weekly recaps.',
      inputSchema: {
        team_id: z.string().optional(),
        decisions_limit: z.number().int().min(1).max(50).default(10),
        actions_limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ team_id, decisions_limit, actions_limit }) => {
      const teamId = team_id ?? 'default';
      const decisions = listDecisions(teamId, decisions_limit);
      const actions = listActions({
        team_id: teamId,
        status: ['open', 'in_progress', 'overdue'],
        limit: actions_limit,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                generated_at: new Date().toISOString(),
                decisions_count: decisions.length,
                actions_count: actions.length,
                overdue_count: actions.filter((a) => a.status === 'overdue').length,
                decisions,
                actions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/* --------------------------- Transport --------------------------- */

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();

  if (env.MCP_TRANSPORT === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('mcp: stdio transport connected');
    return;
  }

  // HTTP transport via Express — stateless mode: fresh transport per request.
  // For stateful/session-aware deployments, set MCP_HTTP_PATH with sessionIdGenerator enabled.
  const expressApp = createMcpExpressApp();

  expressApp.post(env.MCP_HTTP_PATH, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      transport.close();
    }
  });
  expressApp.get(env.MCP_HTTP_PATH, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      transport.close();
    }
  });
  // tiny health endpoint for deployment
  expressApp.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'loop-mcp' });
  });

  expressApp.listen(env.MCP_HTTP_PORT, () => {
    logger.info({ port: env.MCP_HTTP_PORT, path: env.MCP_HTTP_PATH }, 'mcp: HTTP transport listening (stateless)');
  });
}
