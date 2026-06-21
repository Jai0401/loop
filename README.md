# Loop — Slack AI Memory Layer

> _Your team's memory, searchable forever._

Loop is a Slack-native AI agent that watches your conversations, extracts
decisions and action items as they happen, surfaces past decisions the moment
they become relevant again, and follows up on overdue commitments — so your
team never has to ask "wait, did we already decide this?" again.

**Built for the [Slack Agent Builder Challenge](https://devpost.com) (2026).**

---

## The problem

Teams lose decisions. Important calls get made in DMs and threads, then vanish.
Action items slip through cracks. Six weeks later someone asks "weren't we
doing X?" and nobody remembers. Knowledge workers spend **~20% of their week**
re-finding context that's already been decided.

## The Loop solution

A **memory layer** that lives where work already happens — Slack.

| Capability | How Loop does it |
|---|---|
| Decision extraction | AI reads every message, extracts decisions with rationale + participants |
| Action item tracking | Owner + due date + priority + status, with gentle follow-ups |
| Cross-channel semantic search | "What did we decide about auth?" finds the answer even with different words |
| Proactive surfacing | When a new message references a past decision, Loop replies in-thread with the link |
| Overdue follow-ups | Daily DMs to action item owners asking if they need help or an extension |
| MCP integration | Linear/Jira/Notion tools so other agents (and humans) can sync memory outward |

---

## Architecture

```
              ┌────────────────────────────────────────────────────────────┐
              │                       Slack Workspace                      │
              └──────────────┬─────────────────────────────┬───────────────┘
   message / app_mention       │                             │   app_home_open
                               ▼                             ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                      Slack Bolt App (Node.js + TS)                        │
   │  ┌────────────┐    ┌──────────────────┐    ┌──────────────────────────┐   │
   │  │ Event      │───▶│ Conversation     │───▶│ AI Extractor             │   │
   │  │ Listener   │    │ Batch Builder    │    │ (Anthropic Claude)       │   │
   │  └────────────┘    └──────────────────┘    │  - tool-use, validated   │   │
   │                                            └────────────┬─────────────┘   │
   │  ┌────────────┐    ┌──────────────────┐                  │                 │
   │  │ Slash      │───▶│ Search/Decide/   │◀─────────────────┘                 │
   │  │ Commands   │    │ Action/Digest    │                                    │
   │  └────────────┘    └──────────────────┘                                    │
   │  ┌────────────┐    ┌──────────────────┐    ┌──────────────────────────┐   │
   │  │ Home Tab   │───▶│ Decision &       │───▶│ Follow-up Scheduler       │   │
   │  │ (BlockKit) │    │ Action Repo      │    │ (every 30 min)            │   │
   │  └────────────┘    └────────┬─────────┘    └──────────────────────────┘   │
   └────────────────────────────┼─────────────────────────────────────────────┘
                                ▼
                ┌──────────────────────────────────┐
                │   SQLite + FTS5 + embeddings     │
                └──────────────────────────────────┘
                                ▲
                                │ HTTP (Streamable)
                                │
                ┌──────────────────────────────────┐
                │   MCP Server (Loop memory)       │
                │   Resources: decisions, actions  │
                │   Tools: linear_ticket, jira,    │
                │          notion_save, mark_done  │
                └──────────────────────────────────┘
```

### Three required Slack technologies, all leveraged

1. **Slack AI capabilities** — Anthropic Claude via tool-use for structured
   decision/action extraction. Returns strongly-typed JSON validated by Zod.
2. **MCP server integration** — Loop exposes its memory layer as MCP resources
   and tools, so any other agent (or Claude Desktop) can read past decisions
   and write action items back to Linear/Jira/Notion.
3. **Real-Time event subscription** — Slack Events API delivers every message
   in real-time; Loop batches them with thread context and processes
   asynchronously so it never blocks Slack's 3-second ack window.

### Bonus: Block Kit Home tab

A polished dashboard view showing recent decisions, open action items, search
bar, and one-click "mark done" buttons.

---

## Tech stack

- **Runtime:** Node.js 20+ with TypeScript (strict mode)
- **Slack framework:** `@slack/bolt` (Socket Mode + HTTP mode)
- **AI:** `@anthropic-ai/sdk` with tool-use + heuristic fallback
- **MCP:** `@modelcontextprotocol/sdk` (v2) with streamable HTTP transport
- **Storage:** `better-sqlite3` + FTS5 + lightweight bag-of-bigrams embeddings
- **Validation:** `zod` end-to-end
- **Logging:** `pino` with pretty-print in dev

## Project layout

```
src/
├── ai/extractor.ts          # Anthropic Claude + heuristic fallback
├── config/env.ts            # Zod-validated env config
├── core/
│   ├── logger.ts            # Pino logger
│   └── types.ts             # Domain types (Decision, ActionItem, ...)
├── mcp/server.ts            # MCP server w/ resources + tools + prompts
├── scheduled/follow-ups.ts  # Overdue action DM scheduler
├── slack/
│   ├── app.ts               # Bolt app initialization
│   ├── handlers.ts          # message, app_mention handlers
│   ├── home-tab.ts          # Block Kit Home tab + search modal
│   ├── messages.ts          # Surface + overdue DM builders
│   └── slash-commands.ts    # /loop search|decide|action|digest
├── storage/
│   ├── db.ts                # SQLite + migrations
│   ├── embeddings.ts        # 256-dim bag-of-bigrams with cosine
│   └── repo.ts              # Typed CRUD over decisions/actions/etc
└── index.ts                 # Main entry — wires Slack + MCP + scheduler

tests/
├── ai.test.ts               # Heuristic extractor
└── storage.test.ts          # Migrations + CRUD + FTS + embeddings

src/slack/manifest.json      # Slack app manifest (for `slack create`)
```

## Getting started

```bash
# 1. Install deps
npm install

# 2. Configure env
cp .env.example .env
# Fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN (socket mode),
# SLACK_SIGNING_SECRET (HTTP mode), and ANTHROPIC_API_KEY

# 3. Run tests
npm test

# 4. Type-check
npm run typecheck

# 5. Start
npm run dev
```

### Slack app setup

The manifest is at `src/slack/manifest.json`. With the Slack CLI:

```bash
slack create loop -t ./src/slack/manifest.json
slack install
slack run
```

## MCP integration

Once running, Loop's MCP server is at `http://localhost:3001/mcp`.

Connect it to Claude Desktop by adding to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "loop": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Available tools:
- `create_linear_ticket` — push a Loop action to Linear
- `create_jira_issue` — push a Loop action to Jira
- `save_to_notion` — archive a decision to Notion
- `mark_action_done` — close a tracked action
- `summarize_team` — generate a digest

Available resources:
- `loop://decisions` — recent decisions
- `loop://decisions/{id}` — single decision
- `loop://actions` — open actions
- `loop://search?query=...` — semantic + FTS search

## Demo script (3 minutes)

1. **Open the App Home** — show the dashboard of recent decisions + open actions
2. **Run `/loop decide "We are standardizing on Postgres for analytics"`** — watch a decision appear in the Home tab in real time
3. **Run `/loop action "@alice write the migration script by Friday"`** — watch an action appear with owner + due date
4. **In a channel, type "what's our position on the analytics DB?"** — Loop replies in-thread with the past decision and a link
5. **Wait (or speed up the scheduler tick) — when Friday passes, alice gets a DM** with "Mark done / Extend deadline / Open thread" buttons
6. **Open Claude Desktop, connect to Loop's MCP server, ask "summarize the team"** — get a structured digest
7. **From Claude, call `create_linear_ticket`** on the open migration action — show it lands in Linear

## License

MIT
