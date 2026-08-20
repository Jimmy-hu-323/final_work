"""Telegram mirror and interactive Agent bridge."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import time
from contextlib import suppress
from typing import Awaitable, Callable

import aiohttp

from glasses.common.logging_util import log
from glasses.server.data_bridge import BridgeEvent, EventBridge

AgentHandler = Callable[[str, str, str], Awaitable[None]]
PhotoHandler = Callable[[str, str, bytes, str, str], Awaitable[None]]


class TelegramMirror:
    def __init__(
        self,
        *,
        bridge: EventBridge,
        bot_token: str,
        chat_id: str,
        cfg=None,
        interactive: bool = False,
        agent_handler: AgentHandler | None = None,
        mirror_kind: str = "ambassador",
        photo_handler: PhotoHandler | None = None,
    ) -> None:
        self.bridge = bridge
        self.bot_token = bot_token
        self.chat_id = chat_id
        self._task: asyncio.Task[None] | None = None
        self._session: aiohttp.ClientSession | None = None
        self._downstream_buffers: dict[tuple[str, str, int], list[str]] = {}
        self._recent_signatures: dict[str, float] = {}
        self.cfg = cfg
        self.interactive = bool(interactive and cfg is not None and agent_handler is not None)
        self.agent_handler = agent_handler
        self.mirror_kind = mirror_kind
        self.photo_handler = photo_handler
        self._poll_task: asyncio.Task[None] | None = None
        self._update_offset: int | None = None
        self._selected_device: tuple[str, str] | None = None

    async def start(self) -> None:
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60))
        try:
            await self._api("getMe")
            await self._api("getChat", json={"chat_id": self.chat_id})
        except Exception:
            await self._session.close()
            self._session = None
            raise
        self._task = asyncio.create_task(self._run(), name="telegram-glasses-mirror")
        if self.interactive:
            await self._discard_old_updates()
            self._poll_task = asyncio.create_task(self._poll_updates(), name="telegram-agent-input")
        mode = "interactive" if self.interactive else "read-only"
        log(f"[telegram:{self.mirror_kind}] {mode} mirror started chat_id={self.chat_id}")

    async def stop(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._poll_task
        if self._task:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
        if self._session:
            await self._session.close()

    async def _api(self, method: str, **kwargs: object) -> dict[str, object]:
        assert self._session is not None
        url = f"https://api.telegram.org/bot{self.bot_token}/{method}"
        async with self._session.post(url, **kwargs) as response:
            if response.status >= 400:
                body = await response.text()
                raise RuntimeError(f"Telegram {method} failed: HTTP {response.status} {body[:300]}")
            payload = await response.json()
            if not payload.get("ok"):
                raise RuntimeError(f"Telegram {method} failed: {payload.get('description', 'unknown error')}")
            return payload

    def _caption(self, event: BridgeEvent) -> str:
        if self.mirror_kind == "status":
            if event.event_type == "agent.route":
                modality = event.data.get("modality", "unknown")
                agent_id = event.data.get("agent_id", "unknown")
                request_id = str(event.data.get("request_id", ""))[:8]
                return f"🧭 Router 已派发\n主 Agent: {agent_id}\n输入: {modality}\n任务: {request_id}"
            if event.event_type == "agent.collaboration":
                source = event.data.get("from_agent", "lensgo-travel-director")
                target = event.data.get("to_agent", "unknown")
                purpose = event.data.get("purpose", "协作处理")
                return f"🤝 Agent 协作\n{source}\n→ {target}\n任务: {purpose}"
            icon = "✅" if event.event_type in {"device.online", "connected"} else "⚙️"
            return f"{icon} LensGo 工作状态\n设备: {event.device_id}\n事件: {event.event_type}"
        arrow = "⬆️ APP→服务端" if event.direction == "upstream" else "⬇️ 服务端→APP"
        content = event.data.get("content") or event.data.get("message") or ""
        header = f"{arrow}\n设备: {event.device_id}\n事件: {event.event_type}"
        if content:
            return f"{header}\n\n{str(content)[:3500]}"
        return header

    async def _send(self, event: BridgeEvent) -> None:
        caption = self._caption(event)
        path = event.media_path
        if path and path.is_file() and event.event_type in {"image", "video"}:
            form = aiohttp.FormData()
            form.add_field("chat_id", self.chat_id)
            form.add_field("caption", caption[:1024])
            field = "photo" if event.event_type == "image" else "video"
            content_type = mimetypes.guess_type(path.name)[0] or ("image/jpeg" if field == "photo" else "video/mp4")
            with path.open("rb") as media:
                form.add_field(field, media, filename=path.name, content_type=content_type)
                await self._api("sendPhoto" if field == "photo" else "sendVideo", data=form)
            return
        await self._api("sendMessage", json={"chat_id": self.chat_id, "text": caption})

    async def _send_text(self, text: str) -> None:
        await self._api("sendMessage", json={"chat_id": self.chat_id, "text": text[:4096]})

    async def _download_file(self, file_path: str) -> tuple[bytes, str]:
        assert self._session is not None
        url = f"https://api.telegram.org/file/bot{self.bot_token}/{file_path}"
        async with self._session.get(url) as response:
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "image/jpeg").split(";", 1)[0]
            return await response.read(), content_type

    def _online_devices(self) -> list[tuple[str, str]]:
        if self.cfg is None:
            return []
        return list(self.cfg.ws_conns_by_user_device)

    def _resolve_device(self) -> tuple[str, str] | None:
        online = self._online_devices()
        if self._selected_device in online:
            return self._selected_device
        if len(online) == 1:
            self._selected_device = online[0]
            return online[0]
        return None

    async def _discard_old_updates(self) -> None:
        payload = await self._api(
            "getUpdates",
            json={"offset": -1, "timeout": 0, "allowed_updates": ["message"]},
        )
        updates = payload.get("result")
        if isinstance(updates, list) and updates:
            last = updates[-1]
            if isinstance(last, dict) and isinstance(last.get("update_id"), int):
                self._update_offset = last["update_id"] + 1

    async def _handle_command(self, text: str) -> bool:
        command, _, argument = text.strip().partition(" ")
        command = command.split("@", 1)[0].lower()
        if command in {"/start", "/help"}:
            await self._send_text(
                "LensGo Telegram Agent\n\n"
                "直接发送文字：交给当前眼镜设备的 Agent，并把回答回传 APP。\n"
                "直接发送照片：由 LensGo 大使理解画面，并把回答回传 APP。\n"
                "/devices：查看在线设备\n"
                "/use <device_id>：选择设备\n"
                "/status：查看当前设备"
            )
            return True
        if command == "/devices":
            online = self._online_devices()
            if not online:
                await self._send_text("当前没有在线的眼镜 APP。")
            else:
                lines = ["在线设备："]
                for user_id, device_id in online:
                    selected = " ✅" if (user_id, device_id) == self._selected_device else ""
                    lines.append(f"• {device_id}（userId={user_id}）{selected}")
                await self._send_text("\n".join(lines))
            return True
        if command == "/use":
            wanted = argument.strip()
            matches = [item for item in self._online_devices() if item[1] == wanted]
            if len(matches) == 1:
                self._selected_device = matches[0]
                await self._send_text(f"已选择设备：{wanted}")
            elif not matches:
                await self._send_text(f"设备不在线或不存在：{wanted}\n使用 /devices 查看在线设备。")
            else:
                await self._send_text("存在同名设备，请联系管理员使用唯一 device_id。")
            return True
        if command == "/status":
            selected = self._resolve_device()
            if selected:
                await self._send_text(f"当前设备：{selected[1]}（userId={selected[0]}）")
            else:
                await self._send_text("尚未选择设备。使用 /devices 和 /use <device_id>。")
            return True
        return command.startswith("/")

    async def _handle_update(self, update: dict[str, object]) -> None:
        message = update.get("message")
        if not isinstance(message, dict):
            return
        chat = message.get("chat")
        if not isinstance(chat, dict) or str(chat.get("id")) != self.chat_id:
            return
        text = message.get("text")
        photos = message.get("photo")
        caption = message.get("caption")
        if isinstance(text, str) and text.strip() and await self._handle_command(text):
            return
        selected = self._resolve_device()
        if selected is None:
            await self._send_text("无法确定目标设备。使用 /devices 查看，再用 /use <device_id> 选择。")
            return
        assert self.agent_handler is not None
        try:
            if isinstance(photos, list) and photos and self.photo_handler is not None:
                largest = photos[-1]
                if not isinstance(largest, dict) or not isinstance(largest.get("file_id"), str):
                    raise RuntimeError("Telegram 照片缺少 file_id")
                await self._api("sendChatAction", json={"chat_id": self.chat_id, "action": "typing"})
                file_info = await self._api("getFile", json={"file_id": largest["file_id"]})
                result = file_info.get("result")
                if not isinstance(result, dict) or not isinstance(result.get("file_path"), str):
                    raise RuntimeError("Telegram 未返回照片路径")
                file_path = result["file_path"]
                image_bytes, content_type = await self._download_file(file_path)
                if len(image_bytes) > 20 * 1024 * 1024:
                    raise RuntimeError("照片超过 20MB")
                await self.photo_handler(
                    selected[0], selected[1], image_bytes,
                    file_path.rsplit("/", 1)[-1],
                    caption.strip() if isinstance(caption, str) else "",
                )
            elif isinstance(text, str) and text.strip():
                await self._api("sendChatAction", json={"chat_id": self.chat_id, "action": "typing"})
                await self.agent_handler(selected[0], selected[1], text.strip())
            else:
                await self._send_text("请发送文字或照片。")
        except Exception as exc:
            log(f"[telegram] agent input failed: {exc}")
            await self._send_text(f"发送给 Agent 失败：{exc}")

    async def _poll_updates(self) -> None:
        while True:
            try:
                payload = await self._api(
                    "getUpdates",
                    json={
                        "offset": self._update_offset,
                        "timeout": 25,
                        "allowed_updates": ["message"],
                    },
                )
                updates = payload.get("result")
                if not isinstance(updates, list):
                    continue
                for update in updates:
                    if not isinstance(update, dict):
                        continue
                    update_id = update.get("update_id")
                    if isinstance(update_id, int):
                        self._update_offset = update_id + 1
                    await self._handle_update(update)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log(f"[telegram] polling failed: {exc}")
                await asyncio.sleep(3)

    def _coalesce(self, event: BridgeEvent) -> BridgeEvent | None:
        if self.mirror_kind == "status":
            allowed = event.direction == "internal" or event.event_type in {
                "device.online", "device.offline", "error", "SCError", "SCFinishAI"
            }
            return event if allowed else None
        # The ambassador only shows lived conversation and media, never
        # implementation details or device bookkeeping.
        if event.direction == "internal" or event.event_type in {
            "device.online", "device.offline", "error", "SCError", "SCFinishAI"
        }:
            return None
        if event.direction != "downstream" or event.event_type != "SCChat":
            return event
        ask_type = int(event.data.get("askType", 1))
        key = (event.user_id, event.device_id, ask_type)
        message = str(event.data.get("message", ""))
        self._downstream_buffers.setdefault(key, []).append(message)
        if not bool(event.data.get("isEnd", True)):
            return None
        combined = "".join(self._downstream_buffers.pop(key, [])).strip()
        return BridgeEvent(
            direction=event.direction,
            event_type=event.event_type,
            user_id=event.user_id,
            device_id=event.device_id,
            data={**event.data, "message": combined, "isEnd": True},
        )

    def _is_duplicate(self, event: BridgeEvent) -> bool:
        now = time.monotonic()
        signature = json.dumps(
            [event.direction, event.event_type, event.user_id, event.device_id, event.data],
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        previous = self._recent_signatures.get(signature)
        self._recent_signatures[signature] = now
        self._recent_signatures = {key: seen for key, seen in self._recent_signatures.items() if now - seen < 10}
        return previous is not None and now - previous < 3

    async def _run(self) -> None:
        queue = self.bridge.subscribe()
        try:
            while True:
                event = await queue.get()
                try:
                    event = self._coalesce(event)
                    if event is not None and not self._is_duplicate(event):
                        await self._send(event)
                except Exception as exc:
                    log(f"[telegram] mirror failed: {exc}")
        finally:
            self.bridge.unsubscribe(queue)
