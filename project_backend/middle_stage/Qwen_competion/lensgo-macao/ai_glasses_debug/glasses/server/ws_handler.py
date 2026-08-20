"""WebSocket /chat 连接处理。"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Optional

from websockets.exceptions import ConnectionClosed
from websockets.server import ServerConnection

from glasses.common.logging_util import format_json_text_for_log, log, trunc
from glasses.common.protocol import (
    parse_cs_chat_word_image,
    sc_chat,
    sc_error,
    sc_finish,
    sc_intent_message,
)
from glasses.qwenpaw import (
    QwenPawChatError,
    console_upload_bytes,
    stream_chat_content_sse,
    stream_chat_text_sse,
)
from glasses.server import qwenpaw_bridge
from glasses.server.auth import parse_user_id_from_jwt
from glasses.server.config import ServerConfig
from glasses.server.data_bridge import BridgeEvent
from glasses.server.lensgo_memory import context_message
from glasses.server.media import (
    decode_data_url_or_b64,
    ext_to_mime,
    safe_path_segment,
    unique_stored_name,
)
from glasses.server.qwenpaw_auth_refresh import make_on_auth_refresh
from glasses.server.qwenpaw_auth_setup import format_qwenpaw_chat_error


class SessionState:
    def __init__(self) -> None:
        self.waiting_for_intent_image: bool = False


def header_get(conn: ServerConnection, key: str) -> Optional[str]:
    try:
        return conn.request.headers.get(key)
    except Exception:
        return None


def conn_log_label(conn: ServerConnection, user_id: Optional[str] = None) -> str:
    rid = getattr(conn, "remote_address", None)
    remote = f"{rid[0]}:{rid[1]}" if isinstance(rid, tuple) and len(rid) >= 2 else "?"
    if user_id:
        return f"userId={user_id} remote={remote}"
    return f"remote={remote}"


def iter_user_ws_conns(cfg: ServerConfig, user_id: str) -> list[ServerConnection]:
    return [c for (uid, _), c in cfg.ws_conns_by_user_device.items() if uid == user_id]


async def ws_send(
    conn: ServerConnection,
    user_id: Optional[str],
    payload: str,
    *,
    cfg: ServerConfig,
) -> None:
    try:
        json.loads(payload)
    except json.JSONDecodeError:
        log(f"[send] {conn_log_label(conn, user_id)} INVALID_JSON {trunc(payload, 800)}")
        return
    log(
        f"[send] {conn_log_label(conn, user_id)} "
        f"{format_json_text_for_log(payload, verbose=cfg.verbose_log)}"
    )
    if cfg.bridge_enabled and user_id:
        device_id = next(
            (did for (uid, did), active in cfg.ws_conns_by_user_device.items() if uid == user_id and active is conn),
            "unknown",
        )
        try:
            decoded = json.loads(payload)
            body = decoded.get("data") if isinstance(decoded, dict) else None
            event_data = body if isinstance(body, dict) else {"payload": decoded}
            event_type = str(decoded.get("type", "message")) if isinstance(decoded, dict) else "message"
            cfg.event_bridge.publish(
                BridgeEvent(
                    direction="downstream",
                    event_type=event_type,
                    user_id=user_id,
                    device_id=device_id,
                    data=event_data,
                )
            )
        except (TypeError, ValueError):
            pass
    await conn.send(payload)


async def handle_connection(conn: ServerConnection, cfg: ServerConfig) -> None:
    if conn.request is None:
        await conn.close(code=1008, reason="missing request context")
        return

    if conn.request.path != "/chat":
        try:
            await ws_send(conn, None, sc_error("仅支持 /chat 路径"), cfg=cfg)
        finally:
            await conn.close(code=1008, reason="invalid path")
        return

    access_token = header_get(conn, "access_token") or ""
    device_id = header_get(conn, "device_id") or ""

    if not access_token or not device_id:
        try:
            await ws_send(conn, None, sc_error("鉴权失败：缺少 access_token 或 device_id"), cfg=cfg)
        finally:
            await conn.close(code=1008, reason="unauthorized")
        return

    if not cfg.token_policy.ok(access_token):
        try:
            await ws_send(conn, None, sc_error("鉴权失败：access_token 不被允许"), cfg=cfg)
        finally:
            await conn.close(code=1008, reason="unauthorized")
        return

    user_id = parse_user_id_from_jwt(access_token)
    if not user_id:
        try:
            await ws_send(conn, None, sc_error("鉴权失败：token 无法解析 userId"), cfg=cfg)
        finally:
            await conn.close(code=1008, reason="unauthorized")
        return

    log(f"[conn] {conn_log_label(conn, user_id)} device_id={device_id} token_len={len(access_token)}")
    state = SessionState()
    cfg.ws_conns_by_user_device[(user_id, device_id)] = conn
    if cfg.bridge_enabled:
        cfg.event_bridge.publish(
            BridgeEvent(
                direction="system",
                event_type="device.online",
                user_id=user_id,
                device_id=device_id,
            )
        )
    online = len(iter_user_ws_conns(cfg, user_id))
    log(f"[conn] {conn_log_label(conn, user_id)} device_id={device_id} online_devices={online}")

    qwenpaw_chat_id = cfg.qwenpaw_chat_id_by_user_device.setdefault((user_id, device_id), str(uuid.uuid4()))
    qwenpaw_session_id = qwenpaw_chat_id
    qwenpaw_referer = f"{cfg.qwenpaw.base_url.rstrip('/')}/chat/{qwenpaw_chat_id}"
    qwenpaw_origin = cfg.qwenpaw.base_url.rstrip("/")
    log_label = conn_log_label(conn, user_id)
    key = (user_id, device_id)
    send_lock = cfg.ws_send_locks_by_user_device.setdefault(key, asyncio.Lock())

    async def _ws_send_locked(payload: str) -> None:
        async with send_lock:
            await ws_send(conn, user_id, payload, cfg=cfg)

    try:
        async for raw in conn:
            if isinstance(raw, bytes):
                log(f"[recv] {conn_log_label(conn, user_id)} <binary len={len(raw)}>")
                await ws_send(conn, user_id, sc_error("仅支持文本消息（JSON）"), cfg=cfg)
                continue

            text = raw.strip()
            log(
                f"[recv] {conn_log_label(conn, user_id)} "
                f"{format_json_text_for_log(text, verbose=cfg.verbose_log)}"
            )
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                await ws_send(conn, user_id, sc_error("消息不是合法 JSON"), cfg=cfg)
                continue

            if not isinstance(msg, dict):
                await ws_send(conn, user_id, sc_error("消息 JSON 顶层必须是对象"), cfg=cfg)
                continue

            parsed, err = parse_cs_chat_word_image(msg)
            if err:
                await ws_send(conn, user_id, sc_error(err), cfg=cfg)
                continue
            assert parsed is not None
            ask_type = parsed.ask_type

            if qwenpaw_bridge.is_streaming(cfg, user_id, device_id):
                await qwenpaw_bridge.stop_stream(
                    cfg,
                    user_id=user_id,
                    device_id=device_id,
                    chat_id=qwenpaw_chat_id,
                    referer=qwenpaw_referer,
                    origin=qwenpaw_origin,
                    log_label=log_label,
                )

            if ask_type == 1:
                content = parsed.content
                if not content or not content.strip():
                    await ws_send(conn, user_id, sc_error("askType=1 时 content 必填且为非空字符串"), cfg=cfg)
                    continue

                if cfg.bridge_enabled:
                    cfg.event_bridge.publish(
                        BridgeEvent(
                            direction="upstream",
                            event_type="text",
                            user_id=user_id,
                            device_id=device_id,
                            data={"ask_type": ask_type, "content": content.strip()},
                        )
                    )

                if cfg.finish_keywords.search(content.strip()):
                    await ws_send(conn, user_id, sc_finish(), cfg=cfg)
                    continue

                if cfg.intent_demo and cfg.intent_keywords.search(content):
                    state.waiting_for_intent_image = True
                    await ws_send(
                        conn,
                        user_id,
                        sc_intent_message(
                            message="已识别到识物意图：请拍照上传图片（askType=3）。",
                            intent_type="IdentifyObjects",
                            state=True,
                        ),
                        cfg=cfg,
                    )
                    continue

                request_id = str(uuid.uuid4())
                routed_text = content.strip()
                if cfg.lensgo_memory is not None:
                    context = context_message(
                        cfg.lensgo_memory,
                        request_id=request_id,
                        user_id=user_id,
                        device_id=device_id,
                        source="glasses",
                        modality="text",
                        content=routed_text,
                    )
                    routed_text = f"{context}\n用户说：{routed_text}"
                    if cfg.bridge_enabled:
                        cfg.event_bridge.publish(BridgeEvent(
                            direction="internal", event_type="agent.route",
                            user_id=user_id, device_id=device_id,
                            data={"request_id": request_id, "agent_id": cfg.qwenpaw.agent_id, "modality": "text"},
                        ))
                        cfg.event_bridge.publish(BridgeEvent(
                            direction="internal", event_type="agent.collaboration",
                            user_id=user_id, device_id=device_id,
                            data={"from_agent": cfg.qwenpaw.agent_id,
                                  "to_agent": "lensgo-memory-keeper",
                                  "purpose": "读取旅程语境与重要时刻候选"},
                        ))

                try:
                    on_refresh = make_on_auth_refresh(cfg)
                    await qwenpaw_bridge.start_stream(
                        cfg,
                        user_id=user_id,
                        device_id=device_id,
                        chat_id=qwenpaw_chat_id,
                        referer=qwenpaw_referer,
                        origin=qwenpaw_origin,
                        log_label=log_label,
                        ask_type=1,
                        sse_iter=stream_chat_text_sse(
                            cfg=cfg.qwenpaw,
                            text=routed_text,
                            user_id=user_id,
                            session_id=qwenpaw_session_id,
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
                        send=_ws_send_locked,
                    )
                except QwenPawChatError as e:
                    await ws_send(conn, user_id, sc_error(format_qwenpaw_chat_error(cfg, e)), cfg=cfg)
                except Exception as e:
                    await ws_send(conn, user_id, sc_error(format_qwenpaw_chat_error(cfg, e)), cfg=cfg)
                continue

            if ask_type in (2, 3):
                image = parsed.image
                if not image or not image.strip():
                    await ws_send(conn, user_id, sc_error(f"askType={ask_type} 时 image 必填且为非空字符串"), cfg=cfg)
                    continue

                if ask_type == 3 and not state.waiting_for_intent_image:
                    await ws_send(conn, user_id, sc_error("未处于意图识别流程：不期望 askType=3"), cfg=cfg)
                    continue

                safe_uid = safe_path_segment(user_id)
                if not safe_uid:
                    await ws_send(conn, user_id, sc_error("无法为 userId 生成安全存储路径"), cfg=cfg)
                    continue
                try:
                    raw_img, ext = decode_data_url_or_b64(image)
                except Exception as e:
                    await ws_send(conn, user_id, sc_error(f"image 解码失败: {e}"), cfg=cfg)
                    continue

                user_dir = cfg.media_dir / safe_uid
                user_dir.mkdir(parents=True, exist_ok=True)
                stored = unique_stored_name("img", ext)
                out_path = user_dir / stored
                try:
                    out_path.write_bytes(raw_img)
                except OSError as e:
                    await ws_send(conn, user_id, sc_error(f"保存图片失败: {e}"), cfg=cfg)
                    continue
                log(
                    f"[media] {conn_log_label(conn, user_id)} saved_image={trunc(str(out_path), 300)} "
                    f"bytes={len(raw_img)}"
                )
                if cfg.bridge_enabled:
                    cfg.event_bridge.publish(
                        BridgeEvent(
                            direction="upstream",
                            event_type="image",
                            user_id=user_id,
                            device_id=device_id,
                            data={
                                "ask_type": ask_type,
                                "bytes": len(raw_img),
                                "media_url": f"/media/{safe_uid}/{stored}",
                                "bridge_media_url": f"/api/bridge/media/{safe_uid}/{stored}",
                            },
                            media_path=out_path,
                        )
                    )

                if ask_type == 3:
                    state.waiting_for_intent_image = False

                request_id = str(uuid.uuid4())
                prompt = cfg.qwenpaw_image_prompt
                if cfg.lensgo_memory is not None:
                    context = context_message(
                        cfg.lensgo_memory,
                        request_id=request_id,
                        user_id=user_id,
                        device_id=device_id,
                        source="glasses",
                        modality="image",
                        media_ref=f"/api/bridge/media/{safe_uid}/{stored}",
                    )
                    prompt = f"{context}\n{prompt}"
                    if cfg.bridge_enabled:
                        cfg.event_bridge.publish(BridgeEvent(
                            direction="internal", event_type="agent.route",
                            user_id=user_id, device_id=device_id,
                            data={"request_id": request_id, "agent_id": cfg.qwenpaw.agent_id, "modality": "image"},
                        ))
                        cfg.event_bridge.publish(BridgeEvent(
                            direction="internal", event_type="agent.collaboration",
                            user_id=user_id, device_id=device_id,
                            data={"from_agent": cfg.qwenpaw.agent_id,
                                  "to_agent": "lensgo-vision-curator",
                                  "purpose": "理解旅行画面与拍照时机"},
                        ))

                try:
                    on_refresh = make_on_auth_refresh(cfg)
                    up = await console_upload_bytes(
                        cfg=cfg.qwenpaw,
                        file_bytes=raw_img,
                        filename=stored,
                        content_type=ext_to_mime(ext),
                        auth_token=cfg.qwenpaw_auth_token,
                        debug_log=log,
                        on_auth_refresh=on_refresh,
                    )
                    qwen_image_url = str(up.get("url", "")).strip()
                    qwen_content = [
                        {"type": "text", "text": prompt, "status": "created"},
                        {"type": "image", "image_url": qwen_image_url, "status": "created"},
                    ]
                    await qwenpaw_bridge.start_stream(
                        cfg,
                        user_id=user_id,
                        device_id=device_id,
                        chat_id=qwenpaw_chat_id,
                        referer=qwenpaw_referer,
                        origin=qwenpaw_origin,
                        log_label=log_label,
                        ask_type=ask_type,
                        sse_iter=stream_chat_content_sse(
                            cfg=cfg.qwenpaw,
                            content=qwen_content,
                            user_id=user_id,
                            session_id=qwenpaw_session_id,
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
                        send=_ws_send_locked,
                    )
                except QwenPawChatError as e:
                    await ws_send(conn, user_id, sc_error(format_qwenpaw_chat_error(cfg, e)), cfg=cfg)
                except Exception as e:
                    await ws_send(conn, user_id, sc_error(format_qwenpaw_chat_error(cfg, e)), cfg=cfg)
                continue

            if ask_type == 4:
                await ws_send(
                    conn,
                    user_id,
                    sc_chat(
                        4,
                        "已收到视频分析请求：请通过 HTTP POST /api/chat/resources/upload 上传 mp4"
                        "（multipart 字段名 file；header 携带 Authorization: Bearer <token> 与 device_id）。"
                        "上传完成后将转发 QwenPaw 分析，并通过本连接流式回推结果。",
                    ),
                    cfg=cfg,
                )
                continue

            await ws_send(conn, user_id, sc_error(f"不支持的 askType: {ask_type}"), cfg=cfg)

    except ConnectionClosed as e:
        log(f"[conn] {conn_log_label(conn, user_id)} websocket closed: {e}")
    finally:
        try:
            await qwenpaw_bridge.stop_stream(
                cfg,
                user_id=user_id,
                device_id=device_id,
                chat_id=qwenpaw_chat_id,
                referer=qwenpaw_referer,
                origin=qwenpaw_origin,
                log_label=log_label,
            )
        except Exception:
            pass
        if cfg.ws_conns_by_user_device.get(key) is conn:
            cfg.ws_conns_by_user_device.pop(key, None)
            if cfg.bridge_enabled:
                cfg.event_bridge.publish(
                    BridgeEvent(
                        direction="system",
                        event_type="device.offline",
                        user_id=user_id,
                        device_id=device_id,
                    )
                )
            log(
                f"[conn] {conn_log_label(conn, user_id)} device_id={device_id} "
                f"unregistered online_devices={len(iter_user_ws_conns(cfg, user_id))}"
            )
        cfg.ws_send_locks_by_user_device.pop(key, None)
