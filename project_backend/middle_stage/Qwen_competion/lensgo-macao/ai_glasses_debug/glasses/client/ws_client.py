"""WebSocket 测试客户端：连接、收发、交互 REPL。"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path
from typing import Any, Optional

import websockets

from glasses.client.config import ClientConfig
from glasses.client.http_upload import upload_mp4
from glasses.common.logging_util import format_payload_for_log, json_dumps, log
from glasses.common.protocol import cs_chat_word_image

_DEFAULT_INTENT_NAMES = ("demo.jpg", "demo.png")
_DEMO_ASSET_DIR = "demo"


def _guess_mime(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".gif"):
        return "image/gif"
    return "image/jpeg"


def file_to_data_url(path: str) -> str:
    with open(path, "rb") as f:
        raw = f.read()
    mime = _guess_mime(path)
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


def resolve_intent_image_path(intent_image_file: Optional[str]) -> Optional[str]:
    if intent_image_file:
        p = Path(intent_image_file).expanduser().resolve()
        return str(p) if p.is_file() else None
    root = Path(__file__).resolve().parent.parent.parent
    cwd = Path.cwd()
    bases = [root / _DEMO_ASSET_DIR, root, cwd / _DEMO_ASSET_DIR, cwd]
    for base in bases:
        for name in _DEFAULT_INTENT_NAMES:
            cand = (base / name).resolve()
            if cand.is_file():
                return str(cand)
    return None


def format_send_payload_for_log(payload: str, *, verbose: bool) -> str:
    try:
        obj = json.loads(payload)
        return format_payload_for_log(obj, verbose=verbose)
    except json.JSONDecodeError:
        p = payload.replace("\n", "\\n")
        return p[:400] + ("..." if len(p) > 400 else "")


async def ws_send(ws: Any, payload: str, *, cfg: ClientConfig, hint: Optional[str] = None) -> None:
    suffix = f" ({hint})" if hint else ""
    log(f"[send]{suffix} {format_send_payload_for_log(payload, verbose=cfg.verbose_log)}")
    await ws.send(payload)


async def send_initial(ws: Any, cfg: ClientConfig) -> None:
    if cfg.ask_type is None:
        return

    if cfg.ask_type == 1:
        if not cfg.content:
            raise ValueError("askType=1 需要 --content")
        await ws_send(ws, cs_chat_word_image(1, content=cfg.content), cfg=cfg)
        return

    if cfg.ask_type in (2, 3):
        if not cfg.image_file:
            raise ValueError(f"askType={cfg.ask_type} 需要 --image-file")
        hint = f"image_file={cfg.image_file}"
        await ws_send(
            ws,
            cs_chat_word_image(cfg.ask_type, image=file_to_data_url(cfg.image_file)),
            cfg=cfg,
            hint=hint,
        )
        return

    if cfg.ask_type == 4:
        return

    raise ValueError(f"不支持的 askType: {cfg.ask_type}")


async def interactive_loop(ws: Any, cfg: ClientConfig) -> None:
    log(
        "进入交互模式：\n直接输入文字发送 askType=1；\n输入 /img <path> 发送 askType=2；"
        "\n输入 /video <mp4_path> 上传视频；\n意图识别自动上传意图图；\n/quit 退出。"
    )
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        if line == "/quit":
            return
        if line.startswith("/img "):
            path = line[5:].strip().strip('"')
            await ws_send(
                ws,
                cs_chat_word_image(2, image=file_to_data_url(path)),
                cfg=cfg,
                hint=f"image_file={path}",
            )
            continue
        if line.startswith("/video "):
            path = line[7:].strip().strip('"')
            result = await upload_mp4(
                cfg.http_upload_url,
                cfg.access_token,
                path,
                device_id=cfg.device_id,
            )
            log(f"[http upload] {json_dumps(result)}")
            continue
        await ws_send(ws, cs_chat_word_image(1, content=line), cfg=cfg)


async def recv_loop(ws: Any, cfg: ClientConfig) -> None:
    async for raw in ws:
        if isinstance(raw, bytes):
            log(f"[recv bytes] {len(raw)}")
            continue

        text = raw.strip()
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            log(f"[recv] {text}")
            continue

        mtype = msg.get("type")
        data = msg.get("data")
        log(f"[recv] {format_payload_for_log(msg, verbose=cfg.verbose_log)}")

        if (
            mtype == "SCChat"
            and isinstance(data, dict)
            and data.get("askType") == 4
            and cfg.ask_type == 4
            and not cfg.interactive
        ):
            return

        if mtype == "SCIntentMessage":
            path = resolve_intent_image_path(cfg.intent_image_file)
            if not path:
                log(
                    "收到 SCIntentMessage，但未找到可上传的图片：请使用 --intent-image-file <路径>，"
                    f"或在 demo/ 等目录放置 {_DEFAULT_INTENT_NAMES}。"
                )
                continue
            img = file_to_data_url(path)
            await ws_send(
                ws,
                cs_chat_word_image(3, image=img),
                cfg=cfg,
                hint=f"askType=3 intent_image={path}",
            )

        if mtype == "SCError":
            continue

        if mtype == "SCFinishAIMessage":
            if not cfg.interactive:
                return


async def run_client(cfg: ClientConfig) -> None:
    headers = {"access_token": cfg.access_token, "device_id": cfg.device_id}
    async with websockets.connect(cfg.url, additional_headers=headers) as ws:
        log(f"已连接：{cfg.url}")
        await send_initial(ws, cfg)
        if cfg.ask_type == 4 and cfg.video_file and not cfg.interactive:
            result = await upload_mp4(
                cfg.http_upload_url,
                cfg.access_token,
                cfg.video_file,
                device_id=cfg.device_id,
            )
            log(f"[http upload] {json_dumps(result)}")
        if cfg.interactive:
            recv_task = asyncio.create_task(recv_loop(ws, cfg))
            input_task = asyncio.create_task(interactive_loop(ws, cfg))
            done, pending = await asyncio.wait({recv_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            for t in done:
                await t
        else:
            await recv_loop(ws, cfg)
