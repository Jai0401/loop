/**
 * Smoke test for the MCP server.
 *
 * Boots just the MCP transport (no Slack), hits /healthz, and sends
 * MCP initialize + tools/list + resources/list to confirm the protocol responds.
 *
 * Usage:  npx tsx scripts/smoke-mcp.ts
 *         PORT=3399 npx tsx scripts/smoke-mcp.ts
 */
// NOTE: process.env must be set BEFORE the static imports below — ESM hoists
// imports, so set them in a tiny wrapper if you need custom values.
// Inline default for quick boot.
process.env.MCP_HTTP_PORT ??= '3001';
process.env.MCP_TRANSPORT ??= 'http';
process.env.DATABASE_PATH ??= '/tmp/loop-smoke.db';
process.env.LOG_LEVEL ??= 'error';
process.env.NODE_ENV ??= 'test';

// Dynamic imports — the `import()` calls below run AFTER the env assignments above.
async function main() {
  const { env } = await import('../src/config/env.js');
  const { startMcpServer } = await import('../src/mcp/server.js');
  const { closeDb } = await import('../src/storage/db.js');

  await startMcpServer();
  await new Promise((r) => setTimeout(r, 400));

  const port = env.MCP_HTTP_PORT;
  const base = `http://127.0.0.1:${port}`;

  // 1. healthz
  const health = await fetch(`${base}/healthz`);
  const healthBody = await health.json();
  console.log(`healthz: ${health.status} ${JSON.stringify(healthBody)}`);
  if (!health.ok) throw new Error('healthz failed');

  // 2. MCP initialize
  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'loop-smoke', version: '1.0.0' },
      },
    }),
  });
  console.log(`initialize: ${init.status}`);
  const initText = await init.text();
  const initParsed = parseSseOrJson(initText);
  console.log(`initialize body: ${JSON.stringify(initParsed).slice(0, 500)}`);

  // 3. tools/list
  const toolsList = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });
  const toolsText = await toolsList.text();
  const toolsParsed = parseSseOrJson(toolsText);
  const tools =
    (toolsParsed as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  console.log(`tools/list: ${toolsList.status}, ${tools.length} tools exposed`);
  for (const t of tools) console.log(`  - ${t.name}`);
  if (tools.length < 5) throw new Error('expected at least 5 MCP tools');

  // 4. resources/list (fixed resources — templates show up under resources/templates/list)
  const resList = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
      params: {},
    }),
  });
  const resText = await resList.text();
  const resParsed = parseSseOrJson(resText);
  const resources =
    (resParsed as { result?: { resources?: Array<{ name: string; uri: string }> } }).result?.resources ?? [];
  console.log(`resources/list: ${resList.status}, ${resources.length} fixed resources exposed`);
  for (const r of resources) console.log(`  - ${r.name} (${r.uri})`);
  if (resources.length < 3) throw new Error('expected at least 3 fixed MCP resources');

  // 4b. resources/templates/list (templates)
  const tplList = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/templates/list',
      params: {},
    }),
  });
  const tplText = await tplList.text();
  const tplParsed = parseSseOrJson(tplText);
  const templates =
    (tplParsed as { result?: { resourceTemplates?: Array<{ name: string; uriTemplate: string }> } })
      .result?.resourceTemplates ?? [];
  console.log(`resources/templates/list: ${tplList.status}, ${templates.length} templates exposed`);
  for (const t of templates) console.log(`  - ${t.name} (${t.uriTemplate})`);

  // 5. Try a tool call — summarize_team with empty DB
  const toolCall = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'summarize_team', arguments: { team_id: 'smoke-team' } },
    }),
  });
  const toolText = await toolCall.text();
  const toolParsed = parseSseOrJson(toolText);
  const content = (toolParsed as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;
  console.log(`summarize_team call: ${toolCall.status}`);
  if (content) {
    const parsed = JSON.parse(content) as { decisions_count: number; actions_count: number };
    console.log(`  decisions: ${parsed.decisions_count}, actions: ${parsed.actions_count}`);
  } else {
    console.log(`  body: ${JSON.stringify(toolParsed).slice(0, 300)}`);
  }

  console.log('\n✅ MCP smoke test passed');
  closeDb();
  process.exit(0);
}

function parseSseOrJson(text: string): unknown {
  if (text.startsWith('{')) return JSON.parse(text);
  const events = text.split('\n\n').filter(Boolean);
  const dataLines = events
    .flatMap((e) => e.split('\n'))
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice('data: '.length));
  if (dataLines.length === 0) return { raw: text };
  return JSON.parse(dataLines.join('\n'));
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});