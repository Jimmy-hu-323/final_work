"""Small, reliable shared memory used by every LensGo entry point.

QwenPaw keeps each agent's private memory.  This database stores only shared,
user-scoped facts and an audit trail that the router can safely inject.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS travelers (
  traveler_id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL,
  display_name TEXT, preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL,
  traveler_id TEXT NOT NULL, device_id TEXT NOT NULL, source TEXT NOT NULL,
  modality TEXT NOT NULL, content TEXT NOT NULL, media_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, traveler_id TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, importance REAL NOT NULL,
  media_ref TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_traveler
ON observations(traveler_id, created_at DESC);
"""


class LensGoMemory:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def traveler_id(user_id: str) -> str:
        digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]
        return f"traveler_{digest}"

    def record(
        self,
        *,
        request_id: str,
        user_id: str,
        device_id: str,
        source: str,
        modality: str,
        content: str = "",
        media_ref: str | None = None,
    ) -> dict[str, object]:
        now = datetime.now(timezone.utc).isoformat()
        traveler_id = self.traveler_id(user_id)
        with self._connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO travelers"
                "(traveler_id,user_id,created_at,updated_at) VALUES(?,?,?,?)",
                (traveler_id, user_id, now, now),
            )
            db.execute(
                "INSERT OR IGNORE INTO observations"
                "(request_id,traveler_id,device_id,source,modality,content,media_ref,created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (request_id, traveler_id, device_id, source, modality, content[:4000], media_ref, now),
            )
            rows = db.execute(
                "SELECT modality,content,created_at FROM observations "
                "WHERE traveler_id=? ORDER BY id DESC LIMIT 5",
                (traveler_id,),
            ).fetchall()
        recent = [dict(row) for row in reversed(rows)]
        return {"traveler_id": traveler_id, "preferences": {}, "recent": recent}


def context_message(
    memory: LensGoMemory,
    *,
    request_id: str,
    user_id: str,
    device_id: str,
    source: str,
    modality: str,
    content: str = "",
    media_ref: str | None = None,
) -> str:
    state = memory.record(
        request_id=request_id,
        user_id=user_id,
        device_id=device_id,
        source=source,
        modality=modality,
        content=content,
        media_ref=media_ref,
    )
    envelope = {
        "request_id": request_id,
        "traveler_id": state["traveler_id"],
        "source": source,
        "modality": modality,
        "recent_shared_memory": state["recent"],
    }
    return "LensGoContext: " + json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
