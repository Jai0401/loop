"""SQLite-backed MemoryStore.

Implements the Strands `MemoryStore` Protocol so the agent's long-term memory
lives in a local SQLite database. No external services required.

The protocol requires:
  - attributes: name, description, max_search_results, writable, extraction
  - methods:    async search(query, options), async add(content, metadata)

We do a simple substring search across stored entries. Strands auto-injects
matches into the agent's context before each model call, so the agent never
needs a "search_memory" tool that it has to remember to call — relevant
memories are just there.
"""
from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

from strands.memory.types import MemoryEntry, SearchOptions

DEFAULT_DB_PATH = "./data/loop.db"


def _ensure_parent(path: str) -> None:
    Path(path).resolve().parent.mkdir(parents=True, exist_ok=True)


class SqliteMemoryStore:
    """Long-term memory for Loop, backed by a single SQLite table."""

    name = "loop_memory"
    description = "Loop's persistent memory of facts, decisions, and preferences."
    max_search_results = 5
    writable = True
    extraction = False  # the agent decides what to remember via add_memory

    def __init__(self, db_path: str | None = None) -> None:
        self.db_path = db_path or os.environ.get("DATABASE_PATH", DEFAULT_DB_PATH)
        _ensure_parent(self.db_path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_entries (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                content    TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
            """
        )
        self._conn.commit()

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
        limit = (options or {}).get("max_search_results") or self.max_search_results
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT content FROM memory_entries
                WHERE content LIKE ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (f"%{query}%", int(limit)),
            ).fetchall()
        return [
            MemoryEntry(content=row[0], store_name=self.name)
            for row in rows
        ]

    async def add(self, content: str, metadata: Any = None) -> int:
        # `metadata` is accepted for Protocol conformance but currently unstored —
        # we have no consumer for it and the agent doesn't surface it back.
        del metadata
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO memory_entries (content) VALUES (?)",
                (content,),
            )
            self._conn.commit()
            return int(cur.lastrowid or 0)