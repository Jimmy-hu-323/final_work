"""WebSocket 协议消息构造与解析。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from glasses.common.logging_util import json_dumps


def cs_chat_word_image(
    ask_type: int,
    content: Optional[str] = None,
    image: Optional[str] = None,
) -> str:
    data: dict[str, Any] = {"askType": ask_type}
    if content is not None:
        data["content"] = content
    if image is not None:
        data["image"] = image
    return json_dumps({"type": "CSChatWordImage", "data": data})


def sc_error(message: str) -> str:
    return json_dumps(
        {
            "type": "SCError",
            "data": {"type": "error", "message": message},
        }
    )


def sc_chat(ask_type: int, message: str, *, is_end: bool = True) -> str:
    return json_dumps(
        {
            "type": "SCChat",
            "data": {
                "askType": ask_type,
                "type": "response",
                "isEnd": is_end,
                "message": message,
            },
        }
    )


def sc_intent_message(
    message: str,
    intent_type: str = "IdentifyObjects",
    state: bool = True,
) -> str:
    return json_dumps(
        {
            "type": "SCIntentMessage",
            "data": {"state": state, "message": message, "type": intent_type},
        }
    )


def sc_finish() -> str:
    return json_dumps({"type": "SCFinishAIMessage", "data": None})


@dataclass
class ParsedCSChatWordImage:
    ask_type: int
    content: Optional[str]
    image: Optional[str]


def parse_cs_chat_word_image(msg: dict[str, Any]) -> tuple[Optional[ParsedCSChatWordImage], Optional[str]]:
    """解析并校验 CSChatWordImage；失败时返回错误文案。"""
    if msg.get("type") != "CSChatWordImage":
        return None, f"不支持的消息类型: {msg.get('type')!r}"

    data = msg.get("data")
    if not isinstance(data, dict):
        return None, "CSChatWordImage.data 必须是对象"

    ask_type = data.get("askType")
    if not isinstance(ask_type, int):
        return None, "CSChatWordImage.data.askType 必须是整数"

    content = data.get("content")
    if content is not None and not isinstance(content, str):
        return None, "CSChatWordImage.data.content 必须是字符串"

    image = data.get("image")
    if image is not None and not isinstance(image, str):
        return None, "CSChatWordImage.data.image 必须是字符串"

    return ParsedCSChatWordImage(ask_type=ask_type, content=content, image=image), None
