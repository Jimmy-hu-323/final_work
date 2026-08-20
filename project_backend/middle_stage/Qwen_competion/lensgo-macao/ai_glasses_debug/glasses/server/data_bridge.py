"""Read-only event mirror for glasses traffic."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import ClientError, ClientSession, ClientTimeout, web

from glasses.server.media import SAFE_PATH_SEGMENT_RE, safe_path_segment


@dataclass(frozen=True)
class BridgeEvent:
    direction: str
    event_type: str
    user_id: str
    device_id: str
    data: dict[str, Any] = field(default_factory=dict)
    media_path: Path | None = None
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: float = field(default_factory=time.time)

    def public_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "timestamp": self.timestamp,
            "direction": self.direction,
            "event_type": self.event_type,
            "user_id": self.user_id,
            "device_id": self.device_id,
            "data": self.data,
        }


class EventBridge:
    def __init__(self, history_size: int = 200) -> None:
        self._history: deque[BridgeEvent] = deque(maxlen=max(1, history_size))
        self._subscribers: set[asyncio.Queue[BridgeEvent]] = set()

    def publish(self, event: BridgeEvent) -> None:
        self._history.append(event)
        for queue in tuple(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        size = max(1, min(limit, 500))
        return [event.public_dict() for event in list(self._history)[-size:]]

    @property
    def count(self) -> int:
        return len(self._history)

    @property
    def capacity(self) -> int:
        return int(self._history.maxlen or 0)

    def subscribe(self, maxsize: int = 200) -> asyncio.Queue[BridgeEvent]:
        queue: asyncio.Queue[BridgeEvent] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[BridgeEvent]) -> None:
        self._subscribers.discard(queue)


def _authorized(request: web.Request, expected_token: str | None) -> bool:
    if not expected_token:
        return False
    supplied = request.headers.get("Authorization", "")
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:].strip()
    else:
        supplied = request.query.get("token", "").strip()
    return bool(supplied) and supplied == expected_token


@web.middleware
async def bridge_cors_middleware(
    request: web.Request,
    handler: Any,
) -> web.StreamResponse:
    """Allow the token-protected Bridge API to be used by Web/Tauri clients."""
    origin = request.headers.get("Origin", "")
    configured = os.getenv("LENSGO_CORS_ORIGINS", "*")
    allowed = {item.strip() for item in configured.split(",") if item.strip()}
    allow_origin = "*" if "*" in allowed else (origin if origin in allowed else "")
    if request.method == "OPTIONS":
        response: web.StreamResponse = web.Response(status=204)
    else:
        try:
            response = await handler(request)
        except web.HTTPException as exc:
            response = exc
    if allow_origin:
        response.headers["Access-Control-Allow-Origin"] = allow_origin
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Max-Age"] = "600"
        if allow_origin != "*":
            response.headers["Vary"] = "Origin"
    return response


def register_bridge_routes(app: web.Application, cfg: Any) -> None:
    async def status(request: web.Request) -> web.Response:
        if not cfg.bridge_enabled:
            raise web.HTTPNotFound()
        if not _authorized(request, cfg.bridge_token):
            raise web.HTTPUnauthorized(text="Bridge token required")
        qwenpaw_reachable = False
        try:
            timeout = ClientTimeout(total=1.5)
            async with ClientSession(timeout=timeout) as session:
                async with session.get(f"{cfg.qwenpaw.base_url.rstrip('/')}/") as response:
                    qwenpaw_reachable = response.status < 500
        except (ClientError, OSError, TimeoutError):
            pass
        return web.json_response(
            {
                "status": "ok",
                "bridge": {
                    "enabled": True,
                    "history_size": cfg.event_bridge.capacity,
                    "event_count": cfg.event_bridge.count,
                },
                "qwenpaw": {
                    "base_url": cfg.qwenpaw.base_url,
                    "agent_id": cfg.qwenpaw.agent_id,
                    "reachable": qwenpaw_reachable,
                },
                "telegram": {
                    "enabled": bool(cfg.telegram_enabled),
                    "configured": bool(cfg.telegram_bot_token and cfg.telegram_chat_id),
                },
                "telegram_status": {
                    "enabled": bool(cfg.telegram_status_enabled),
                    "configured": bool(
                        cfg.telegram_status_bot_token and cfg.telegram_status_chat_id
                    ),
                },
            }
        )

    async def media(request: web.Request) -> web.StreamResponse:
        if not cfg.bridge_enabled:
            raise web.HTTPNotFound()
        if not _authorized(request, cfg.bridge_token):
            raise web.HTTPUnauthorized(text="Bridge token required")
        uid = safe_path_segment(request.match_info.get("user_id", ""))
        filename = request.match_info.get("filename", "").strip()
        if not uid or not filename or not SAFE_PATH_SEGMENT_RE.fullmatch(filename):
            raise web.HTTPNotFound()
        base = cfg.media_dir.resolve()
        target = (base / uid / filename).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            raise web.HTTPNotFound()
        if not target.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(target)

    async def events(request: web.Request) -> web.Response:
        if not cfg.bridge_enabled:
            raise web.HTTPNotFound()
        if not _authorized(request, cfg.bridge_token):
            raise web.HTTPUnauthorized(text="Bridge token required")
        try:
            limit = int(request.query.get("limit", "100"))
        except ValueError:
            limit = 100
        return web.json_response({"events": cfg.event_bridge.history(limit)})

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        if not cfg.bridge_enabled:
            raise web.HTTPNotFound()
        if not _authorized(request, cfg.bridge_token):
            raise web.HTTPUnauthorized(text="Bridge token required")
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        queue = cfg.event_bridge.subscribe()
        try:
            await ws.send_json({"type": "bridge.connected"})
            for item in cfg.event_bridge.history(50):
                await ws.send_str(json.dumps(item, ensure_ascii=False))
            while not ws.closed:
                event = await queue.get()
                await ws.send_str(json.dumps(event.public_dict(), ensure_ascii=False))
        finally:
            cfg.event_bridge.unsubscribe(queue)
        return ws

    app.router.add_get("/api/bridge/status", status)
    app.router.add_get("/api/bridge/events", events)
    app.router.add_get("/api/bridge/ws", websocket)
    app.router.add_get("/api/bridge/media/{user_id}/{filename}", media)
