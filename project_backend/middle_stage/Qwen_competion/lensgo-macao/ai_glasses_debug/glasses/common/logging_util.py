"""统一控制台日志与 JSON 序列化。"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def log(message: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    print(f"{ts} {message}", flush=True)


def trunc(s: str, max_len: int = 400) -> str:
    s = s.replace("\n", "\\n")
    if len(s) <= max_len:
        return s
    return s[:max_len] + f"...(truncated, total_chars={len(s)})"


def redact_image_in_obj(obj: Any, *, max_image_log_chars: int = 0) -> Any:
    """对 data.image 等大字段脱敏，便于默认日志不刷屏。"""
    if not isinstance(obj, dict):
        return obj
    out = dict(obj)
    data = out.get("data")
    if isinstance(data, dict) and isinstance(data.get("image"), str):
        img = data["image"]
        if max_image_log_chars <= 0:
            data = {**data, "image": f"<base64 len={len(img)}>"}
        else:
            data = {**data, "image": img[:max_image_log_chars] + f"...(len={len(img)})"}
        out["data"] = data
    return out


def format_payload_for_log(
    obj: Any,
    *,
    max_image_log_chars: int = 0,
    verbose: bool = False,
) -> str:
    if verbose:
        return json_dumps(obj)
    return json_dumps(redact_image_in_obj(obj, max_image_log_chars=max_image_log_chars))


def format_json_text_for_log(
    text: str,
    *,
    max_image_log_chars: int = 0,
    verbose: bool = False,
) -> str:
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return trunc(text)
    if not isinstance(obj, dict):
        return trunc(text)
    if verbose:
        return json_dumps(obj)
    return format_payload_for_log(obj, max_image_log_chars=max_image_log_chars)
