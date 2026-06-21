# Loop — Architecture

## System diagram

See [`docs/architecture.svg`](./architecture.svg) for the visual diagram and [`docs/architecture.txt`](./architecture.txt) for the ASCII version.

## Layered flow

### ① Slack Workspace
Inbound events from the user-facing surface:
- `message.channels` / `message.groups` — every team conversation
- `app_mention` — when Loop is @-mentioned (becomes a query)
- `app_home_opened` — when a user opens the App Home
- Slash commands (`/loop search|decide|action|digest`)
- Interactive payloads (button clicks)

### ② Bolt App (Node.js + TypeScript)
The orchestration layer, in `src/slack/`:
- **Event Listener** (`handlers.ts`) — acks within Slack's 3-second window, then enqueues
- **Thread Context Builder** — batches the new message with up to 30 sibling replies
- **Slash Commands** (`slash-commands.ts`) — search/record/recap
- **Block Kit Publisher** (`home-tab.ts`) — dashboard + search modal
- **Proactive Messages** (`messages.ts`) — surface reply in threads, DM follow-ups

### ③ AI Extraction Pipeline (`src/ai/extractor.ts`)
Two-tiered:
- **Claude tool-use** — `messages.create()` with a `record_extraction` tool whose input is a Zod schema. The model is forced to return strongly-typed JSON, validated before storage.
- **Heuristic fallback** — regex patterns + date parsing + word-pair topic detection. Used when `ANTHROPIC_API_KEY` is absent (tests, demos, edge cases).

Outputs:
- Decisions — `summary`, `rationale`, `participants`, `confidence` (stated | inferred | tentative)
- Action items — `title`, `owner`, `due`, `priority`, `confidence`
- Topics — 1-3 word noun phrases

### ④ Storage (`src/storage/`)
SQLite with WAL mode, FTS5 virtual tables, JSON-embedded vectors:
- `decisions` (+ `decisions_fts`) — full-text searchable
- `action_items` (+ `actions_fts`, `action_external_refs`) — searchable + Linear/Jira/Notion links
- `messages`, `users`, `channels`, `topics`, `proactive_events`
- `embeddings` — 256-dim bag-of-bigrams with cosine similarity (deterministic, no API key needed)
- `repo.ts` — typed CRUD, all SQL isolated

### ⑤ MCP Server (`src/mcp/server.ts`)
Streamable HTTP transport, stateless mode:
- 3 fixed resources + 1 template (`loop://decisions/{id}`)
- 5 tools: `create_linear_ticket`, `create_jira_issue`, `save_to_notion`, `mark_action_done`, `summarize_team`
- Exposed at `http://<host>:<MCP_HTTP_PORT>/mcp`
- `/healthz` for deployment liveness

Consumed by:
- Claude Desktop (via `claude_desktop_config.json`)
- Cursor and any MCP-aware IDE
- Other internal agents that need team memory

### ⑥ Surfaces
- **Block Kit Home Tab** — dashboard with decisions + actions + search modal
- **Proactive Loop**:
  - **In-thread surface** — when a new message's embedding has cosine ≥ 0.45 with a past decision, post a reply in-thread with the link
  - **DM follow-up** — every 30 minutes, find overdue actions, DM the owner (with 24h cooldown)
  - **Auto-overdue** — promote `open` actions past their `due_at` to `overdue` status

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) |
| Slack | `@slack/bolt` 4.x (Socket Mode + HTTP) |
| AI | `@anthropic-ai/sdk` Claude Sonnet 4.6 |
| MCP | `@modelcontextprotocol/sdk` 1.x (Streamable HTTP, stateless) |
| DB | `better-sqlite3` 11.x with FTS5 + WAL |
| Validation | `zod` 3.23 |
| Logging | `pino` 9 with pretty-print in dev |
| Testing | `vitest` 2.x (18 tests) |

## Performance characteristics

| Op | P50 | Notes |
|---|---|---|
| Message ingestion | <50ms | SQLite insert is idempotent on (channel, ts) |
| AI extraction | 1-2s | Claude tool-use, single round-trip |
| FTS5 search | <5ms | 500 decisions |
| Cosine similarity | <10ms | 500 decisions, 256-dim |
| MCP request | <20ms | local, fresh transport per request |

## Required Slack technologies (hackathon compliance)

- [x] **Slack AI capabilities** — Anthropic Claude tool-use for structured decision/action extraction
- [x] **MCP server integration** — full memory layer exposed as MCP resources and tools
- [x] **Real-Time event subscription** — Slack Events API delivers every message in real-time (functionally the same surface as the new "Real-Time Search" product)