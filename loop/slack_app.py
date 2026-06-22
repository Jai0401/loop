"""Slack Bolt app.

Two handlers — both route straight to the Strands agent:
  - `app_mention` : user @mentions Loop → run() → reply in thread
  - `/loop`        : slash command → run() → respond

No passive ingestion, no intent parsing, no command templates. The agent is
the only brain.

The `<@U...>` mention strip on incoming text is purely text-cleaning (so the
agent doesn't see its own name); it's not parsing intent or routing commands.
"""
from __future__ import annotations

import logging
import os
import re

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from loop.agent import run as run_agent

log = logging.getLogger("loop.slack")

_MENTION_RE = re.compile(r"<@[^>]+>")


def _strip_mentions(text: str) -> str:
    return _MENTION_RE.sub("", text).strip()


def _build_app() -> App:
    app = App(token=os.environ["SLACK_BOT_TOKEN"])

    @app.event("app_mention")
    def on_mention(event, say, client, logger):
        text = _strip_mentions(event.get("text", "") or "") or "hello"
        channel = event["channel"]
        thread_ts = event.get("ts")
        _react(client, channel, thread_ts, "eyes")
        try:
            reply = run_agent(text)
            say(text=reply or "_(no response)_", thread_ts=thread_ts)
            _swap(client, channel, thread_ts, "white_check_mark")
        except Exception as err:  # noqa: BLE001
            logger.exception("agent invocation failed")
            _swap(client, channel, thread_ts, "warning")
            say(text=f":warning: Something went wrong: {err}", thread_ts=thread_ts)

    @app.command("/loop")
    def on_loop(ack, respond, command):
        ack()
        text = (command.get("text") or "").strip() or "Give me a digest of recent memory."
        try:
            reply = run_agent(text)
            respond(reply or "_(no response)_")
        except Exception as err:  # noqa: BLE001
            log.exception("slash command failed")
            respond(f":warning: Something went wrong: {err}")

    return app


def _react(client, channel: str, ts: str, name: str) -> None:
    try:
        client.reactions_add(channel=channel, timestamp=ts, name=name)
    except Exception:  # noqa: BLE001
        pass


def _swap(client, channel: str, ts: str, name: str) -> None:
    try:
        client.reactions_remove(channel=channel, timestamp=ts, name="eyes")
    except Exception:  # noqa: BLE001
        pass
    _react(client, channel, ts, name)


def start() -> None:  # pragma: no cover
    handler = SocketModeHandler(_build_app(), os.environ["SLACK_APP_TOKEN"])
    log.info("loop: starting Socket Mode handler")
    handler.start()