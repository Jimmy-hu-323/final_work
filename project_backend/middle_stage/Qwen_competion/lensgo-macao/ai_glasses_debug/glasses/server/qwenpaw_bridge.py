"""QwenPaw SSE 转发生命周期（start/stop/inflight）。"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from glasses.common.logging_util import log
from glasses.common.protocol import sc_error
from glasses.qwenpaw import QwenPawChatError, console_chat_stop
from glasses.server.config import ServerConfig
from glasses.server.data_bridge import BridgeEvent
from glasses.server.media import decode_data_url_or_b64, safe_path_segment, unique_stored_name
from glasses.server.qwenpaw_auth_refresh import make_on_auth_refresh
from glasses.server.qwenpaw_auth_setup import format_qwenpaw_chat_error
from glasses.server.tts_chunker import forward_sse_as_tts_chunks

MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024
ALLOWED_GENERATED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def _read_generated_image(value: str) -> tuple[bytes, str] | None:
    if value.startswith("data:image/"):
        return decode_data_url_or_b64(value)

    parsed = urlparse(value)
    if re.match(r"^[A-Za-z]:[\\/]", value):
        candidate = Path(value)
    elif parsed.scheme == "file":
        raw_path = unquote(parsed.path)
        if os.name == "nt" and re.match(r"^/[A-Za-z]:/", raw_path):
            raw_path = raw_path[1:]
        candidate = Path(raw_path)
    elif not parsed.scheme:
        candidate = Path(value)
    else:
        return None

    workspace_value = os.getenv("QWENPAW_WORKING_DIR", "").strip()
    if not workspace_value:
        return None
    workspace = Path(workspace_value).expanduser().resolve()
    candidate = candidate.expanduser().resolve()
    try:
        candidate.relative_to(workspace)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate.read_bytes(), candidate.suffix.lower()


async def handle_generated_media(
    cfg: ServerConfig,
    *,
    user_id: str,
    device_id: str,
    event: dict[str, Any],
) -> None:
    """Persist a QwenPaw image content block and publish it to bridge consumers.

    QwenPaw's own Console already renders the content block. Publishing a
    downstream BridgeEvent lets the existing Telegram mirror deliver the same
    local file without introducing a second Telegram implementation.
    """
    try:
        if event.get("type") != "image":
            return
        image_url = event.get("image_url")
        if not isinstance(image_url, str):
            return
        image = _read_generated_image(image_url)
        if image is None:
            return
        raw, ext = image
        ext = ext.lower()
        if ext not in ALLOWED_GENERATED_IMAGE_EXTENSIONS:
            log(f"[qwenpaw:media] ignored unsupported generated image format: {ext}")
            return
        if len(raw) > MAX_GENERATED_IMAGE_BYTES:
            log(f"[qwenpaw:media] ignored generated image larger than 20MB")
            return
        safe_user = safe_path_segment(user_id) or "anonymous"
        target_dir = cfg.media_dir / safe_user
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / unique_stored_name("pose_reference", ext)
        target.write_bytes(raw)
        cfg.event_bridge.publish(
            BridgeEvent(
                direction="downstream",
                event_type="image",
                user_id=user_id,
                device_id=device_id,
                data={
                    "kind": "pose_reference",
                    "content": "LensGo 姿势参考图",
                    "bytes": len(raw),
                    "filename": target.name,
                    "bridge_media_url": (
                        f"/api/bridge/media/{safe_user}/{target.name}"
                    ),
                },
                media_path=target,
            )
        )
        log(f"[qwenpaw:media] mirrored pose reference image: {target}")
    except Exception as exc:
        # Image delivery is optional. Keep the original text/TTS stream alive.
        log(f"[qwenpaw:media] generated image mirror skipped: {exc}")


def make_media_callback(
    cfg: ServerConfig,
    *,
    user_id: str,
    device_id: str,
):
    async def _on_media(event: dict[str, Any]) -> None:
        await handle_generated_media(
            cfg,
            user_id=user_id,
            device_id=device_id,
            event=event,
        )

    return _on_media


def device_key(user_id: str, device_id: str) -> tuple[str, str]:
    return (user_id, device_id)


def is_streaming(cfg: ServerConfig, user_id: str, device_id: str) -> bool:
    key = device_key(user_id, device_id)
    if cfg.qwenpaw_streaming.get(key, False):
        return True
    t = cfg.qwenpaw_inflight_tasks.get(key)
    return isinstance(t, asyncio.Task) and not t.done()


async def stop_stream(
    cfg: ServerConfig,
    *,
    user_id: str,
    device_id: str,
    chat_id: str,
    referer: str,
    origin: str,
    log_label: str,
) -> None:
    key = device_key(user_id, device_id)
    t = cfg.qwenpaw_inflight_tasks.get(key)
    streaming = cfg.qwenpaw_streaming.get(key, False)

    if not streaming and (not isinstance(t, asyncio.Task) or t.done()):
        if isinstance(t, asyncio.Task) and t.done():
            cfg.qwenpaw_inflight_tasks.pop(key, None)
        log(f"[qwenpaw] {log_label} stop skipped (no active stream) userId={user_id} device_id={device_id}")
        return

    try:
        on_refresh = make_on_auth_refresh(cfg)
        await console_chat_stop(
            cfg=cfg.qwenpaw,
            chat_id=chat_id,
            auth_token=cfg.qwenpaw_auth_token,
            on_auth_refresh=on_refresh,
            debug_log=log,
            referer=referer,
            origin=origin,
        )
        log(f"[qwenpaw] {log_label} stop chat_id={chat_id}")
    except Exception as e:
        log(f"[qwenpaw] {log_label} stop failed chat_id={chat_id}: {e}")

    if isinstance(t, asyncio.Task) and not t.done():
        try:
            t.cancel()
            await t
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    cfg.qwenpaw_streaming[key] = False
    if cfg.qwenpaw_inflight_tasks.get(key) is t:
        cfg.qwenpaw_inflight_tasks.pop(key, None)


async def start_stream(
    cfg: ServerConfig,
    *,
    user_id: str,
    device_id: str,
    chat_id: str,
    referer: str,
    origin: str,
    log_label: str,
    ask_type: int,
    sse_iter: Any,
    send: Any,
) -> None:
    key = device_key(user_id, device_id)
    cfg.qwenpaw_streaming[key] = True

    async def _runner() -> None:
        try:
            log(f"[qwenpaw] {log_label} stream start askType={ask_type}")
            await forward_sse_as_tts_chunks(
                ask_type=ask_type,
                sse_iter=sse_iter,
                send=send,
            )
        except asyncio.CancelledError:
            raise
        except QwenPawChatError as e:
            await send(sc_error(format_qwenpaw_chat_error(cfg, e)))
        except Exception as e:
            await send(sc_error(format_qwenpaw_chat_error(cfg, e)))
        finally:
            cfg.qwenpaw_streaming[key] = False
            cur = cfg.qwenpaw_inflight_tasks.get(key)
            if cur is asyncio.current_task():
                cfg.qwenpaw_inflight_tasks.pop(key, None)
            try:
                aclose = getattr(sse_iter, "aclose", None)
                if callable(aclose):
                    await aclose()
            except Exception:
                pass

    task = asyncio.create_task(_runner())
    cfg.qwenpaw_inflight_tasks[key] = task
