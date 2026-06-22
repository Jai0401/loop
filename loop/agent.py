"""Loop's Strands Agent.

Built per the official Strands Agents README (sdk-python):

    from strands import Agent
    from strands.models.anthropic import AnthropicModel
    from strands_tools import slack, slack_send_message, calculator, think
    from strands.tools.mcp import MCPClient
    from mcp import stdio_client, StdioServerParameters

    with MCPClient(lambda: stdio_client(StdioServerParameters(command=..., args=[...]))) as mcp:
        agent = Agent(model=..., tools=[...], memory_manager=...)
        response = agent("...")

We follow the documented pattern: the MCPClient owns its stdio connection's
lifetime, so we enter its context before the agent runs and exit after. The
agent itself is built lazily on first use (cheap — just config wiring).
"""
from __future__ import annotations

import logging
import os
from typing import Any

from mcp import StdioServerParameters, stdio_client
from strands import Agent
from strands.memory import MemoryManager
from strands.models.anthropic import AnthropicModel
from strands.tools.mcp import MCPClient
from strands_tools import calculator, slack, think
from strands_tools.slack import slack_send_message

from loop.storage import SqliteMemoryStore

log = logging.getLogger("loop.agent")

_agent: Agent | None = None


def _build_model() -> AnthropicModel:
    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN must be set")

    client_args: dict[str, Any] = {"api_key": api_key}
    if base_url := os.environ.get("ANTHROPIC_BASE_URL"):
        client_args["base_url"] = base_url

    return AnthropicModel(
        client_args=client_args,
        model_id=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        max_tokens=2048,
    )


SYSTEM_PROMPT = """You are Loop — a Slack-native AI agent for teams.

Personality:
- Concise but warm
- Honest — if you don't know or can't find something, say so
- Proactive — surface relevant memory when it adds context

Tools you have:
- slack + slack_send_message — talk to Slack (any Web API method)
- search_memory / add_memory — long-term memory (auto-injected before each reply)
- calculator — math
- think — structured reasoning for hard problems

When the user asks a question:
- "tag @alice" → use slack to look up the user, then post a message
- "what did we decide about X" → long-term memory (auto-injected) usually has it
- "summarize this channel" → use slack with conversations_history / conversations_replies
- "remember this" / "save this decision" → call add_memory
- greetings, thanks, small talk → reply conversationally, no tools

Respond in Slack mrkdwn (*bold*, _italic_, `code`, • bullets, > quotes). Keep replies under 1500 chars when possible. Don't announce tool calls — use them and respond naturally."""


def _mcp_client() -> MCPClient | None:
    """Build one MCPClient from a single env var: LOOP_MCP_SERVERS='uvx strands-agents-mcp-server'.

    Returns None if not set. For more servers, add multiple invocations here.
    """
    spec = os.environ.get("LOOP_MCP_SERVERS")
    if not spec:
        return None

    parts = spec.split()
    command, args = parts[0], parts[1:]
    log.info("loop: MCP client registered (command=%s, args=%s)", command, args)
    return MCPClient(lambda: stdio_client(StdioServerParameters(command=command, args=args)))


def _build_agent() -> Agent:
    """Build the agent. Caller is responsible for holding any MCP context."""
    tools: list[Any] = [slack, slack_send_message, calculator, think]

    memory_manager = MemoryManager(
        stores=[SqliteMemoryStore()],
        search_tool_config=True,
        add_tool_config=True,
    )

    return Agent(
        model=_build_model(),
        system_prompt=SYSTEM_PROMPT,
        tools=tools,
        memory_manager=memory_manager,
    )


def get_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
        log.info("loop agent initialised")
    return _agent


def run(prompt: str) -> str:
    """Invoke the agent and return the final assistant text.

    If an MCP client is registered, we enter its context manager so the
    stdio connection is alive for the duration of the call (the documented
    pattern from the Strands README). MCP-provided tools are added to the
    agent's tool list inside that scope.
    """
    client = _mcp_client()
    if client is None:
        return _invoke(prompt)

    with client:
        tools = list(get_agent().tool_registry.registry.values())
        tools.extend(client.list_tools_sync())
        agent = _build_agent()
        agent.tool_registry.process_tools(tools)
        return _extract_text(agent(prompt))


def _invoke(prompt: str) -> str:
    return _extract_text(get_agent()(prompt))


def _extract_text(result: Any) -> str:
    msg = getattr(result, "message", None)
    if msg is None:
        return ""
    parts: list[str] = []
    for block in getattr(msg, "content", []) or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts).strip()