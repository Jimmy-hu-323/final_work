"""Forward Telegram text into the selected device's QwenPaw session."""

from __future__ import annotations

import asyncio
import uuid

from glasses.common.logging_util import log
from glasses.qwenpaw import console_upload_bytes, stream_chat_content_sse, stream_chat_text_sse
from glasses.server import qwenpaw_bridge
from glasses.server.data_bridge import BridgeEvent
from glasses.server.lensgo_memory import context_message
from glasses.server.qwenpaw_auth_refresh import make_on_auth_refresh
from glasses.server.ws_handler import ws_send


async def send_telegram_text_to_agent(cfg, user_id: str, device_id: str, text: str) -> None:
    key = (user_id, device_id)
    conn = cfg.ws_conns_by_user_device.get(key)
    if conn is None:
        raise RuntimeError(f"设备 {device_id} 已离线")

    chat_id = cfg.qwenpaw_chat_id_by_user_device[key]
    referer = f"{cfg.qwenpaw.base_url.rstrip('/')}/chat/{chat_id}"
    origin = cfg.qwenpaw.base_url.rstrip("/")
    log_label = f"telegram userId={user_id} device_id={device_id}"

    if qwenpaw_bridge.is_streaming(cfg, user_id, device_id):
        await qwenpaw_bridge.stop_stream(
            cfg,
            user_id=user_id,
            device_id=device_id,
            chat_id=chat_id,
            referer=referer,
            origin=origin,
            log_label=log_label,
        )

    send_lock = cfg.ws_send_locks_by_user_device.setdefault(key, asyncio.Lock())

    async def send_locked(payload: str) -> None:
        async with send_lock:
            await ws_send(conn, user_id, payload, cfg=cfg)

    routed_text = text
    if cfg.lensgo_memory is not None:
        context = context_message(
            cfg.lensgo_memory,
            request_id=str(uuid.uuid4()),
            user_id=user_id,
            device_id=device_id,
            source="telegram",
            modality="text",
            content=text,
        )
        routed_text = f"{context}\n用户从 Telegram 说：{text}"
        if cfg.bridge_enabled:
            cfg.event_bridge.publish(BridgeEvent(
                direction="internal", event_type="agent.route",
                user_id=user_id, device_id=device_id,
                data={"agent_id": cfg.qwenpaw.agent_id, "modality": "text", "request_id": "telegram"},
            ))
    on_refresh = make_on_auth_refresh(cfg)
    await qwenpaw_bridge.start_stream(
        cfg,
        user_id=user_id,
        device_id=device_id,
        chat_id=chat_id,
        referer=referer,
        origin=origin,
        log_label=log_label,
        ask_type=1,
        sse_iter=stream_chat_text_sse(
            cfg=cfg.qwenpaw,
            text=routed_text,
            user_id=user_id,
            session_id=chat_id,
            auth_token=cfg.qwenpaw_auth_token,
            on_auth_refresh=on_refresh,
            on_media=qwenpaw_bridge.make_media_callback(
                cfg,
                user_id=user_id,
                device_id=device_id,
            ),
            debug_log=log,
            referer=referer,
            origin=origin,
        ),
        send=send_locked,
    )


async def send_telegram_photo_to_agent(
    cfg, user_id: str, device_id: str, image_bytes: bytes, filename: str, caption: str = ""
) -> None:
    key = (user_id, device_id)
    conn = cfg.ws_conns_by_user_device.get(key)
    if conn is None:
        raise RuntimeError(f"设备 {device_id} 已离线")
    chat_id = cfg.qwenpaw_chat_id_by_user_device[key]
    referer = f"{cfg.qwenpaw.base_url.rstrip('/')}/chat/{chat_id}"
    origin = cfg.qwenpaw.base_url.rstrip("/")
    log_label = f"telegram-photo userId={user_id} device_id={device_id}"
    if qwenpaw_bridge.is_streaming(cfg, user_id, device_id):
        await qwenpaw_bridge.stop_stream(
            cfg, user_id=user_id, device_id=device_id, chat_id=chat_id,
            referer=referer, origin=origin, log_label=log_label,
        )
    send_lock = cfg.ws_send_locks_by_user_device.setdefault(key, asyncio.Lock())

    async def send_locked(payload: str) -> None:
        async with send_lock:
            await ws_send(conn, user_id, payload, cfg=cfg)

    request_id = str(uuid.uuid4())
    prompt = cfg.qwenpaw_image_prompt
    if caption:
        prompt += f"\n用户随照片说：{caption}"
    if cfg.lensgo_memory is not None:
        context = context_message(
            cfg.lensgo_memory, request_id=request_id, user_id=user_id,
            device_id=device_id, source="telegram", modality="image", content=caption,
        )
        prompt = f"{context}\n{prompt}"
    if cfg.bridge_enabled:
        cfg.event_bridge.publish(BridgeEvent(
            direction="internal", event_type="agent.route", user_id=user_id, device_id=device_id,
            data={"agent_id": cfg.qwenpaw.agent_id, "modality": "image", "request_id": request_id},
        ))
        cfg.event_bridge.publish(BridgeEvent(
            direction="internal", event_type="agent.collaboration", user_id=user_id, device_id=device_id,
            data={"from_agent": cfg.qwenpaw.agent_id, "to_agent": "lensgo-vision-curator",
                  "purpose": "理解 Telegram 旅行照片与拍照时机"},
        ))
    content_type = "image/png" if filename.lower().endswith(".png") else "image/jpeg"
    on_refresh = make_on_auth_refresh(cfg)
    upload = await console_upload_bytes(
        cfg=cfg.qwenpaw, file_bytes=image_bytes, filename=filename or "telegram.jpg",
        content_type=content_type, auth_token=cfg.qwenpaw_auth_token,
        on_auth_refresh=on_refresh, debug_log=log,
    )
    content = [
        {"type": "text", "text": prompt, "status": "created"},
        {"type": "image", "image_url": str(upload.get("url", "")), "status": "created"},
    ]
    await qwenpaw_bridge.start_stream(
        cfg, user_id=user_id, device_id=device_id, chat_id=chat_id,
        referer=referer, origin=origin, log_label=log_label, ask_type=2,
        sse_iter=stream_chat_content_sse(
            cfg=cfg.qwenpaw, content=content, user_id=user_id, session_id=chat_id,
            auth_token=cfg.qwenpaw_auth_token, on_auth_refresh=on_refresh,
            on_media=qwenpaw_bridge.make_media_callback(
                cfg, user_id=user_id, device_id=device_id
            ),
            debug_log=log, referer=referer, origin=origin,
        ),
        send=send_locked,
    )
