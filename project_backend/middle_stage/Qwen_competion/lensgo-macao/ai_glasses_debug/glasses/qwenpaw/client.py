"""QwenPaw HTTP API：upload、stop 与 SSE chat 入口。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable
from typing import Any, Callable, Optional

import aiohttp

from glasses.qwenpaw.sse import stream_chat_sse
from glasses.qwenpaw.types import QwenPawChatConfig, QwenPawChatError, QwenPawHttpError


def _norm_base_url(base_url: str) -> str:
    return (base_url or "").strip().rstrip("/")


def _build_chat_url(base_url: str) -> str:
    return f"{_norm_base_url(base_url)}/api/console/chat"


def _build_upload_url(base_url: str) -> str:
    return f"{_norm_base_url(base_url)}/api/console/upload"


def _build_chat_stop_url(base_url: str) -> str:
    return f"{_norm_base_url(base_url)}/api/console/chat/stop"


def _build_auth_login_url(base_url: str) -> str:
    return f"{_norm_base_url(base_url)}/api/auth/login"


async def console_auth_login(
    *,
    cfg: QwenPawChatConfig,
    username: str,
    password: str,
    expires_in_s: int | None = None,
) -> str:
    username = (username or "").strip()
    password = password or ""
    if not username or not password:
        raise QwenPawChatError("username/password required for auth login")

    url = _build_auth_login_url(cfg.base_url)
    payload: dict[str, Any] = {"username": username, "password": password}
    if isinstance(expires_in_s, int) and expires_in_s > 0:
        payload["expires_in"] = int(expires_in_s)

    timeout = aiohttp.ClientTimeout(total=min(cfg.timeout_s, 30.0))
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload) as resp:
            body = await resp.text()
            if resp.status >= 400:
                raise QwenPawHttpError(resp.status, f"HTTP {resp.status}: {body[:800]}")
            try:
                obj = json.loads(body) if body.strip() else {}
            except json.JSONDecodeError as e:
                raise QwenPawChatError(f"Invalid auth login response JSON: {body[:300]}") from e
            if not isinstance(obj, dict) or not isinstance(obj.get("token"), str) or not obj["token"].strip():
                raise QwenPawChatError(f"Unexpected auth login response: {obj!r}")
            return obj["token"].strip()


async def console_chat_stop(
    *,
    cfg: QwenPawChatConfig,
    chat_id: str,
    auth_token: Optional[str] = None,
    on_auth_refresh: Optional[Callable[[], Awaitable[str]]] = None,
    debug_log: Optional[Callable[[str], None]] = None,
    referer: Optional[str] = None,
    origin: Optional[str] = None,
) -> dict[str, Any]:
    chat_id = (chat_id or "").strip()
    if not chat_id:
        raise QwenPawChatError("chat_id is required")

    url = _build_chat_stop_url(cfg.base_url)
    headers: dict[str, str] = {"X-Agent-Id": cfg.agent_id}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    if referer:
        headers["Referer"] = str(referer)
    if origin:
        headers["Origin"] = str(origin)

    if debug_log:
        debug_log(f"[qwenpaw:http] POST {url}?chat_id={chat_id}")

    timeout = aiohttp.ClientTimeout(total=min(cfg.timeout_s, 30.0))
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for attempt in (0, 1):
            async with session.post(url, headers=headers, params={"chat_id": chat_id}) as resp:
                body = await resp.text()
                if debug_log:
                    debug_log(f"[qwenpaw:http] <- {resp.status} {body[:800]}")
                if resp.status in (401, 403) and attempt == 0 and on_auth_refresh:
                    new_token = await on_auth_refresh()
                    headers["Authorization"] = f"Bearer {new_token}"
                    continue
                if resp.status >= 400:
                    raise QwenPawHttpError(resp.status, f"HTTP {resp.status}: {body[:800]}")
                try:
                    obj = json.loads(body) if body.strip() else {}
                except json.JSONDecodeError:
                    return {"raw": body}
                return obj if isinstance(obj, dict) else {"raw": obj}
    raise QwenPawChatError("Unexpected stop request flow")


async def console_upload_bytes(
    *,
    cfg: QwenPawChatConfig,
    file_bytes: bytes,
    filename: str,
    content_type: str,
    auth_token: Optional[str] = None,
    debug_log: Optional[Callable[[str], None]] = None,
    on_auth_refresh: Optional[Callable[[], Awaitable[str]]] = None,
) -> dict[str, Any]:
    url = _build_upload_url(cfg.base_url)
    headers: dict[str, str] = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    if debug_log:
        debug_log(
            f"[qwenpaw:http] POST {url} (upload) filename={filename!r} "
            f"content_type={content_type!r} bytes={len(file_bytes)}"
        )

    form = aiohttp.FormData()
    form.add_field("file", file_bytes, filename=filename, content_type=content_type)

    timeout = aiohttp.ClientTimeout(total=cfg.timeout_s)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for attempt in (0, 1):
            async with session.post(url, data=form, headers=headers) as resp:
                body = await resp.text()
                if debug_log:
                    debug_log(f"[qwenpaw:http] <- {resp.status} {body[:800]}")
                if resp.status in (401, 403) and attempt == 0 and on_auth_refresh:
                    new_token = await on_auth_refresh()
                    headers["Authorization"] = f"Bearer {new_token}"
                    continue
                if resp.status >= 400:
                    raise QwenPawHttpError(resp.status, f"HTTP {resp.status}: {body[:800]}")
                try:
                    obj = json.loads(body)
                except json.JSONDecodeError as e:
                    raise QwenPawChatError(f"Invalid upload response JSON: {body[:300]}") from e
                if not isinstance(obj, dict) or "url" not in obj:
                    raise QwenPawChatError(f"Unexpected upload response: {obj!r}")
                return obj
    raise QwenPawChatError("Unexpected upload request flow")


async def stream_chat_text_sse(
    *,
    cfg: QwenPawChatConfig,
    text: str,
    user_id: str,
    session_id: str,
    auth_token: Optional[str] = None,
    on_auth_refresh: Optional[Callable[[], Awaitable[str]]] = None,
    on_chat_id: Optional[Callable[[str], None]] = None,
    on_media: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
    debug_log: Optional[Callable[[str], None]] = None,
    referer: Optional[str] = None,
    origin: Optional[str] = None,
) -> AsyncIterator[tuple[str, bool]]:
    content = [{"type": "text", "text": text}]
    async for item in stream_chat_sse(
        cfg=cfg,
        content=content,
        user_id=user_id,
        session_id=session_id,
        auth_token=auth_token,
        on_auth_refresh=on_auth_refresh,
        on_chat_id=on_chat_id,
        on_media=on_media,
        debug_log=debug_log,
        referer=referer,
        origin=origin,
    ):
        yield item


async def stream_chat_content_sse(
    *,
    cfg: QwenPawChatConfig,
    content: list[dict[str, Any]],
    user_id: str,
    session_id: str,
    auth_token: Optional[str] = None,
    on_auth_refresh: Optional[Callable[[], Awaitable[str]]] = None,
    on_chat_id: Optional[Callable[[str], None]] = None,
    on_media: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
    debug_log: Optional[Callable[[str], None]] = None,
    referer: Optional[str] = None,
    origin: Optional[str] = None,
) -> AsyncIterator[tuple[str, bool]]:
    async for item in stream_chat_sse(
        cfg=cfg,
        content=content,
        user_id=user_id,
        session_id=session_id,
        auth_token=auth_token,
        on_auth_refresh=on_auth_refresh,
        on_chat_id=on_chat_id,
        on_media=on_media,
        debug_log=debug_log,
        referer=referer,
        origin=origin,
    ):
        yield item


async def chat_text_sse(
    *,
    cfg: QwenPawChatConfig,
    text: str,
    user_id: str,
    session_id: str,
    auth_token: Optional[str] = None,
) -> str:
    async for piece, is_end in stream_chat_text_sse(
        cfg=cfg,
        text=text,
        user_id=user_id,
        session_id=session_id,
        auth_token=auth_token,
    ):
        if is_end:
            return piece
    return ""


async def chat_content_sse(
    *,
    cfg: QwenPawChatConfig,
    content: list[dict[str, Any]],
    user_id: str,
    session_id: str,
    auth_token: Optional[str] = None,
) -> str:
    async for piece, is_end in stream_chat_content_sse(
        cfg=cfg,
        content=content,
        user_id=user_id,
        session_id=session_id,
        auth_token=auth_token,
    ):
        if is_end:
            return piece
    return ""
