"""QwenPaw SSE 流解析与统一 chat 流。"""

from __future__ import annotations

import asyncio
import json
import re
from collections import defaultdict
from collections.abc import AsyncIterator
from collections.abc import Awaitable
from typing import Any, Callable, Optional

import aiohttp

from glasses.qwenpaw.types import QwenPawChatConfig, QwenPawChatError, QwenPawHttpError

MediaCallback = Callable[[dict[str, Any]], Awaitable[None]]


def _norm_base_url(base_url: str) -> str:
    return (base_url or "").strip().rstrip("/")


def _build_chat_url(base_url: str) -> str:
    return f"{_norm_base_url(base_url)}/api/console/chat"

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}$"
)


def extract_chat_id(event: dict[str, Any]) -> Optional[str]:
    for k in ("chat_id", "chatId", "conversation_id", "conversationId", "session_id", "sessionId"):
        v = event.get(k)
        if isinstance(v, str) and _UUID_RE.fullmatch(v.strip()):
            return v.strip()

    q: list[tuple[Any, int]] = [(event, 0)]
    while q:
        cur, depth = q.pop(0)
        if depth > 6:
            continue
        if isinstance(cur, dict):
            for vv in cur.values():
                if isinstance(vv, str) and _UUID_RE.fullmatch(vv.strip()):
                    return vv.strip()
                if isinstance(vv, (dict, list)):
                    q.append((vv, depth + 1))
        elif isinstance(cur, list):
            for vv in cur:
                if isinstance(vv, str) and _UUID_RE.fullmatch(vv.strip()):
                    return vv.strip()
                if isinstance(vv, (dict, list)):
                    q.append((vv, depth + 1))
    return None


def extract_uuid_from_text(s: str) -> Optional[str]:
    if not isinstance(s, str):
        return None
    s = s.strip()
    if not s:
        return None
    for token in re.split(r"[^0-9a-fA-F-]+", s):
        if _UUID_RE.fullmatch(token):
            return token
    return None


def summarize_content_blocks(content: Any) -> str:
    if not isinstance(content, list):
        return "content=<non-list>"
    items: list[str] = []
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            txt = b.get("text")
            items.append(f"text(len={len(txt) if isinstance(txt, str) else 'na'})")
        elif t in ("image", "video"):
            url = b.get(f"{t}_url")
            items.append(f"{t}(url={'yes' if isinstance(url, str) and url else 'no'})")
        else:
            items.append(str(t))
    return "content=[" + ",".join(items) + "]"


def _parse_sse_data_line(line: bytes) -> Optional[dict[str, Any]]:
    try:
        text = line.decode("utf-8").strip()
    except UnicodeDecodeError:
        return None
    if not text.startswith("data:"):
        return None
    payload = text[5:].lstrip()
    if not payload:
        return None
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return event if isinstance(event, dict) else None


async def iter_sse_events(content: aiohttp.StreamReader) -> AsyncIterator[dict[str, Any]]:
    buf = b""
    async for chunk in content.iter_chunked(4096):
        if not chunk:
            continue
        buf += chunk
        while True:
            nl = buf.find(b"\n")
            if nl < 0:
                break
            line = buf[:nl]
            buf = buf[nl + 1 :]
            if line.endswith(b"\r"):
                line = line[:-1]
            event = _parse_sse_data_line(line)
            if event is not None:
                yield event
    if buf:
        if buf.endswith(b"\r"):
            buf = buf[:-1]
        event = _parse_sse_data_line(buf)
        if event is not None:
            yield event


def _text_blocks_from_content_list(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "text":
            continue
        t = block.get("text")
        if isinstance(t, str) and t:
            parts.append(t)
    return parts


def _text_from_output(event: dict[str, Any]) -> Optional[str]:
    output = event.get("output")
    if not isinstance(output, list):
        return None
    for item in reversed(output):
        if not isinstance(item, dict):
            continue
        if item.get("role") != "assistant":
            continue
        if item.get("type") == "reasoning":
            continue
        if item.get("type") not in (None, "message"):
            continue
        parts = _text_blocks_from_content_list(item.get("content"))
        if parts:
            return "".join(parts)
    return None


def _error_message(event: dict[str, Any]) -> Optional[str]:
    err = event.get("error")
    if not err:
        return None
    if isinstance(err, dict):
        msg = err.get("message")
        if isinstance(msg, str) and msg.strip():
            return msg.strip()
    return str(err)


class StreamState:
    def __init__(self) -> None:
        self.assistant_message_ids: set[str] = set()
        self.reasoning_message_ids: set[str] = set()
        self.pending_delta: dict[str, list[str]] = defaultdict(list)
        self.parts_by_msg_id: dict[str, list[str]] = defaultdict(list)
        self.assistant_message_order: list[str] = []

    def on_message(self, event: dict[str, Any]) -> list[tuple[str, str]]:
        msg_id = event.get("id")
        if event.get("role") != "assistant" or not isinstance(msg_id, str):
            return []
        msg_type = event.get("type")
        if msg_type == "reasoning":
            self.reasoning_message_ids.add(msg_id)
            self.pending_delta.pop(msg_id, None)
            return []
        if msg_type == "message":
            self.assistant_message_ids.add(msg_id)
            if msg_id not in self.assistant_message_order:
                self.assistant_message_order.append(msg_id)
            return [(msg_id, t) for t in self.pending_delta.pop(msg_id, [])]
        return []

    def is_assistant_msg(self, msg_id: str) -> bool:
        return msg_id in self.assistant_message_ids and msg_id not in self.reasoning_message_ids

    def buffer_delta(self, msg_id: str, text: str) -> None:
        if msg_id in self.reasoning_message_ids or msg_id in self.assistant_message_ids:
            return
        self.pending_delta[msg_id].append(text)

    def record_assistant_delta(self, msg_id: str, text: str) -> None:
        self.parts_by_msg_id[msg_id].append(text)

    def last_assistant_text(self) -> str:
        for msg_id in reversed(self.assistant_message_order):
            if not self.is_assistant_msg(msg_id):
                continue
            text = "".join(self.parts_by_msg_id.get(msg_id, [])).strip()
            if text:
                return text
        return ""


async def _process_sse_response(
    resp: aiohttp.ClientResponse,
    *,
    on_chat_id: Optional[Callable[[str], None]] = None,
    on_media: Optional[MediaCallback] = None,
) -> AsyncIterator[tuple[str, bool]]:
    state = StreamState()
    saw_content = False
    streamed_to_client = False
    last_output_text = ""
    chat_id_sent = False
    seen_media: set[str] = set()

    if not chat_id_sent and on_chat_id:
        for v in resp.headers.values():
            cid = extract_uuid_from_text(v)
            if cid:
                chat_id_sent = True
                try:
                    on_chat_id(cid)
                except Exception:
                    pass
                break

    async for event in iter_sse_events(resp.content):
        if not chat_id_sent and on_chat_id:
            cid = extract_chat_id(event)
            if isinstance(cid, str) and cid.strip():
                chat_id_sent = True
                try:
                    on_chat_id(cid.strip())
                except Exception:
                    pass

        err_msg = _error_message(event)
        if err_msg:
            raise QwenPawChatError(err_msg)

        obj = event.get("object")
        status = event.get("status")

        if status == "failed":
            raise QwenPawChatError(_error_message(event) or "QwenPaw failed")

        if obj == "content" and event.get("type") in ("image", "file") and on_media:
            media_url = event.get("image_url") or event.get("file_url")
            if isinstance(media_url, str) and media_url:
                signature = f"{event.get('type')}:{media_url}"
                if signature not in seen_media:
                    seen_media.add(signature)
                    try:
                        await on_media(dict(event))
                    except Exception:
                        # Media mirroring is best-effort and must never interrupt
                        # the glasses text/TTS response.
                        pass

        if obj == "message":
            for msg_id, buffered in state.on_message(event):
                state.record_assistant_delta(msg_id, buffered)
                streamed_to_client = True
                yield (buffered, False)

        if obj == "content" and event.get("type") == "text":
            saw_content = True
            msg_id = event.get("msg_id")
            chunk = event.get("text")
            if not isinstance(msg_id, str) or not isinstance(chunk, str) or not chunk:
                continue
            if event.get("delta") is True:
                if state.is_assistant_msg(msg_id):
                    state.record_assistant_delta(msg_id, chunk)
                    streamed_to_client = True
                    yield (chunk, False)
                else:
                    state.buffer_delta(msg_id, chunk)
            elif event.get("status") == "completed" and state.is_assistant_msg(msg_id):
                state.parts_by_msg_id[msg_id] = [chunk]

        output_text = _text_from_output(event) if obj == "response" else None
        if output_text is not None and output_text != last_output_text:
            last_output_text = output_text

        if obj == "response" and status == "in_progress" and output_text and not saw_content:
            streamed_to_client = True
            yield (output_text, False)

        if obj == "response" and status == "completed":
            if streamed_to_client:
                yield ("", True)
            else:
                yield (output_text or state.last_assistant_text() or "", True)
            return

    if not streamed_to_client:
        final = state.last_assistant_text()
        if final:
            yield (final, True)


async def stream_chat_sse(
    *,
    cfg: QwenPawChatConfig,
    content: list[dict[str, Any]],
    user_id: str,
    session_id: str,
    auth_token: Optional[str] = None,
    on_auth_refresh: Optional[Callable[[], Awaitable[str]]] = None,
    on_chat_id: Optional[Callable[[str], None]] = None,
    on_media: Optional[MediaCallback] = None,
    debug_log: Optional[Callable[[str], None]] = None,
    referer: Optional[str] = None,
    origin: Optional[str] = None,
) -> AsyncIterator[tuple[str, bool]]:
    url = _build_chat_url(cfg.base_url)
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "X-Agent-Id": cfg.agent_id,
    }
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    if referer:
        headers["Referer"] = str(referer)
    if origin:
        headers["Origin"] = str(origin)

    payload = {
        "input": [{"role": "user", "content": content}],
        "session_id": session_id,
        "chat_id": session_id,
        "user_id": user_id,
        "channel": cfg.channel,
    }

    timeout = aiohttp.ClientTimeout(total=cfg.timeout_s)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        try:
            for attempt in (0, 1):
                if debug_log:
                    debug_log(
                        f"[qwenpaw:http] POST {url} X-Agent-Id={cfg.agent_id!r} user_id={user_id!r} "
                        f"session_id={session_id!r} chat_id={session_id!r} "
                        f"{summarize_content_blocks(content)}"
                    )
                async with session.post(url, headers=headers, json=payload) as resp:
                    if resp.status in (401, 403) and attempt == 0 and on_auth_refresh:
                        body = await resp.text()
                        if debug_log:
                            debug_log(f"[qwenpaw:http] <- {resp.status} {body[:800]} (will refresh token once)")
                        new_token = await on_auth_refresh()
                        headers["Authorization"] = f"Bearer {new_token}"
                        continue

                    if resp.status >= 400:
                        body = await resp.text()
                        if debug_log:
                            debug_log(f"[qwenpaw:http] <- {resp.status} {body[:800]}")
                        raise QwenPawHttpError(resp.status, f"HTTP {resp.status}: {body[:800]}")

                    if debug_log:
                        interesting = {
                            k: v
                            for k, v in resp.headers.items()
                            if k.lower()
                            in ("content-type", "x-request-id", "x-trace-id", "x-chat-id", "location")
                        }
                        debug_log(f"[qwenpaw:http] <- headers {interesting}")

                    async for item in _process_sse_response(
                        resp,
                        on_chat_id=on_chat_id,
                        on_media=on_media,
                    ):
                        yield item
                    return

        except asyncio.TimeoutError as e:
            raise QwenPawChatError(f"Timeout after {cfg.timeout_s}s") from e
        except aiohttp.ClientError as e:
            raise QwenPawChatError(f"Network error: {e}") from e
