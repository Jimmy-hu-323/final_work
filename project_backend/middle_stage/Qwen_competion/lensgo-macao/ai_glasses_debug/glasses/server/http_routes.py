"""HTTP 媒体上传与静态取回。"""

from __future__ import annotations

import asyncio
import uuid

from aiohttp import web
from websockets.server import ServerConnection

from glasses.common.logging_util import log
from glasses.common.protocol import sc_error
from glasses.qwenpaw import QwenPawChatError, console_upload_bytes, stream_chat_content_sse
from glasses.server import qwenpaw_bridge
from glasses.server.auth import bearer_token_from_auth_header, parse_user_id_from_jwt
from glasses.server.config import ServerConfig
from glasses.server.data_bridge import BridgeEvent
from glasses.server.lensgo_memory import context_message
from glasses.server.media import SAFE_PATH_SEGMENT_RE, safe_path_segment, unique_stored_name
from glasses.server.qwenpaw_auth_refresh import make_on_auth_refresh
from glasses.server.qwenpaw_auth_setup import format_qwenpaw_chat_error
from glasses.server.ws_handler import ws_send


def register_routes(app: web.Application, cfg: ServerConfig) -> None:
    async def handle_media(request: web.Request) -> web.Response:
        uid_raw = request.match_info.get("user_id", "")
        fname = (request.match_info.get("filename") or "").strip()
        uid = safe_path_segment(uid_raw) if uid_raw else None
        if not uid or not fname or not SAFE_PATH_SEGMENT_RE.fullmatch(fname):
            raise web.HTTPNotFound()
        base = cfg.media_dir.resolve()
        target = (base / uid / fname).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            raise web.HTTPNotFound()
        if not target.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path=target)

    async def handle_upload(request: web.Request) -> web.Response:
        token = bearer_token_from_auth_header(request.headers.get("Authorization", ""))
        if not token:
            return web.json_response(
                {"code": "401000", "msg": "Missing Authorization: Bearer <token>", "data": None},
                status=401,
            )

        if not cfg.token_policy.ok(token):
            return web.json_response({"code": "401001", "msg": "Unauthorized token", "data": None}, status=401)

        user_id = parse_user_id_from_jwt(token)
        if not user_id:
            return web.json_response(
                {"code": "401002", "msg": "Invalid token: userId missing", "data": None},
                status=401,
            )

        device_id = (request.headers.get("device_id") or "").strip()
        if not device_id:
            return web.json_response(
                {"code": "400003", "msg": "Missing device_id header", "data": None},
                status=400,
            )

        if request.content_length is not None and request.content_length > cfg.http_max_bytes:
            return web.json_response(
                {"code": "413000", "msg": "Payload too large", "data": {"maxBytes": cfg.http_max_bytes}},
                status=413,
            )

        try:
            reader = await request.multipart()
        except Exception:
            return web.json_response(
                {"code": "400000", "msg": "Invalid multipart/form-data", "data": None},
                status=400,
            )

        part = await reader.next()
        if part is None or part.name != "file":
            return web.json_response(
                {"code": "400001", "msg": "Missing multipart field: file", "data": None},
                status=400,
            )

        filename = (part.filename or "").strip()
        content_type = (part.headers.get("Content-Type") or "").lower()
        if filename and not filename.lower().endswith(".mp4") and content_type != "video/mp4":
            return web.json_response(
                {
                    "code": "400002",
                    "msg": "File must be mp4",
                    "data": {"filename": filename, "contentType": content_type},
                },
                status=400,
            )

        safe_uid = safe_path_segment(user_id)
        if not safe_uid:
            return web.json_response(
                {"code": "500000", "msg": "Cannot derive safe storage path for userId", "data": None},
                status=500,
            )

        user_dir = cfg.media_dir / safe_uid
        user_dir.mkdir(parents=True, exist_ok=True)
        stored_name = unique_stored_name("vid", ".mp4")
        out_path = user_dir / stored_name

        total = 0
        overflow = False
        try:
            with open(out_path, "wb") as f:
                while True:
                    chunk = await part.read_chunk(size=1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
                    if total > cfg.http_max_bytes:
                        overflow = True
                        break
        except OSError as e:
            try:
                out_path.unlink(missing_ok=True)
            except OSError:
                pass
            return web.json_response(
                {"code": "500001", "msg": f"Failed to write file: {e}", "data": None},
                status=500,
            )

        if overflow:
            try:
                out_path.unlink(missing_ok=True)
            except OSError:
                pass
            return web.json_response(
                {"code": "413000", "msg": "Payload too large", "data": {"maxBytes": cfg.http_max_bytes}},
                status=413,
            )

        url = f"/media/{safe_uid}/{stored_name}"
        push_conn: ServerConnection | None = cfg.ws_conns_by_user_device.get((user_id, device_id))
        qwenpaw_chat_id = cfg.qwenpaw_chat_id_by_user_device.setdefault((user_id, device_id), str(uuid.uuid4()))
        qwenpaw_referer = f"{cfg.qwenpaw.base_url.rstrip('/')}/chat/{qwenpaw_chat_id}"
        qwenpaw_origin = cfg.qwenpaw.base_url.rstrip("/")

        if push_conn is not None:

            async def _push_ws() -> None:
                http_log = f"userId={user_id} device_id={device_id} http"
                try:
                    on_refresh = make_on_auth_refresh(cfg)
                    await asyncio.sleep(0.2)
                    if qwenpaw_bridge.is_streaming(cfg, user_id, device_id):
                        await qwenpaw_bridge.stop_stream(
                            cfg,
                            user_id=user_id,
                            device_id=device_id,
                            chat_id=qwenpaw_chat_id,
                            referer=qwenpaw_referer,
                            origin=qwenpaw_origin,
                            log_label=http_log,
                        )
                    raw_vid = out_path.read_bytes()
                    up = await console_upload_bytes(
                        cfg=cfg.qwenpaw,
                        file_bytes=raw_vid,
                        filename=stored_name,
                        content_type="video/mp4",
                        auth_token=cfg.qwenpaw_auth_token,
                        debug_log=log,
                        on_auth_refresh=on_refresh,
                    )
                    qwen_video_url = str(up.get("url", "")).strip()
                    prompt = cfg.qwenpaw_video_prompt
                    if cfg.lensgo_memory is not None:
                        prompt = context_message(
                            cfg.lensgo_memory,
                            request_id=str(uuid.uuid4()),
                            user_id=user_id,
                            device_id=device_id,
                            source="glasses",
                            modality="video",
                            media_ref=f"/api/bridge/media/{safe_uid}/{stored_name}",
                        ) + "\n" + prompt
                    qwen_content = [
                        {
                            "type": "text",
                            "text": prompt,
                            "status": "created",
                        },
                        {"type": "video", "video_url": qwen_video_url, "status": "created"},
                    ]

                    async def _send_locked(payload: str) -> None:
                        await ws_send(push_conn, user_id, payload, cfg=cfg)

                    await qwenpaw_bridge.start_stream(
                        cfg,
                        user_id=user_id,
                        device_id=device_id,
                        chat_id=qwenpaw_chat_id,
                        referer=qwenpaw_referer,
                        origin=qwenpaw_origin,
                        log_label=http_log,
                        ask_type=4,
                        sse_iter=stream_chat_content_sse(
                            cfg=cfg.qwenpaw,
                            content=qwen_content,
                            user_id=user_id,
                            session_id=qwenpaw_chat_id,
                            auth_token=cfg.qwenpaw_auth_token,
                            on_auth_refresh=on_refresh,
                            on_media=qwenpaw_bridge.make_media_callback(
                                cfg,
                                user_id=user_id,
                                device_id=device_id,
                            ),
                            debug_log=log,
                            referer=qwenpaw_referer,
                            origin=qwenpaw_origin,
                        ),
                        send=_send_locked,
                    )
                except QwenPawChatError as e:
                    log(f"[media] {http_log} QwenPaw error: {e}")
                    try:
                        await ws_send(push_conn, user_id, sc_error(format_qwenpaw_chat_error(cfg, e)), cfg=cfg)
                    except Exception:
                        pass
                except Exception as e:
                    log(f"[media] {http_log} push failed: {e}")
                    try:
                        await ws_send(push_conn, user_id, sc_error(format_qwenpaw_chat_error(cfg, e)), cfg=cfg)
                    except Exception:
                        pass

            asyncio.create_task(_push_ws())
        else:
            log(
                f"[media] userId={user_id} device_id={device_id} video uploaded but skipped WS push: "
                f"no online websocket for this device"
            )

        log(
            f"[media] userId={user_id} device_id={device_id} saved_video={out_path.resolve()} "
            f"bytes={total} url={url}"
        )
        if cfg.bridge_enabled:
            cfg.event_bridge.publish(
                BridgeEvent(
                    direction="upstream",
                    event_type="video",
                    user_id=user_id,
                    device_id=device_id,
                    data={
                        "ask_type": 4,
                        "bytes": total,
                        "media_url": url,
                        "bridge_media_url": f"/api/bridge/media/{safe_uid}/{stored_name}",
                    },
                    media_path=out_path,
                )
            )

        return web.json_response(
            {
                "code": "000000",
                "msg": "OK",
                "data": {
                    "askType": 4,
                    "bytes": total,
                    "filename": filename,
                    "url": url,
                },
            }
        )

    app.router.add_get("/media/{user_id}/{filename}", handle_media)
    app.router.add_post("/api/chat/resources/upload", handle_upload)
