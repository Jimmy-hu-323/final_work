"""媒体落盘、data URL 解码与路径安全。"""

from __future__ import annotations

import base64
import re
import secrets
import time
from pathlib import Path
from typing import Tuple

SAFE_PATH_SEGMENT_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
DEFAULT_MEDIA_SUBDIR = "tmp_media"


def default_media_dir() -> Path:
    """项目根目录下的 tmp_media/。"""
    return Path(__file__).resolve().parents[2] / DEFAULT_MEDIA_SUBDIR


def safe_path_segment(s: str) -> str | None:
    t = (s or "").strip()
    if not t or "__" in t or not SAFE_PATH_SEGMENT_RE.fullmatch(t):
        return None
    return t


def unique_stored_name(prefix: str, ext: str) -> str:
    e = ext if ext.startswith(".") else f".{ext}"
    return f"{prefix}_{int(time.time() * 1000)}_{secrets.token_hex(4)}{e}"


def mime_to_ext(mime_header: str) -> str:
    mime = (mime_header or "").split(";")[0].strip().lower()
    mapping = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    return mapping.get(mime, ".bin")


def ext_to_mime(ext: str) -> str:
    e = (ext or "").lower()
    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp4": "video/mp4",
    }
    return mapping.get(e, "application/octet-stream")


def guess_image_ext_from_magic(b: bytes) -> str:
    if b.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if len(b) >= 8 and b[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if len(b) >= 12 and b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return ".webp"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    return ".jpg"


def decode_data_url_or_b64(image: str) -> Tuple[bytes, str]:
    s = (image or "").strip()
    if not s:
        raise ValueError("empty image")
    if s.startswith("data:"):
        comma = s.find(",")
        if comma == -1:
            raise ValueError("invalid data URL")
        meta = s[5:comma]
        payload = s[comma + 1 :]
        if "base64" not in meta.lower():
            raise ValueError("only base64 data URLs supported")
        ext = mime_to_ext(meta)
        raw = base64.b64decode(payload, validate=False)
        if not raw:
            raise ValueError("empty decoded image")
        if ext == ".bin":
            ext = guess_image_ext_from_magic(raw)
        return raw, ext
    pad = "=" * (-len(s) % 4)
    raw = base64.b64decode(s + pad, validate=False)
    if not raw:
        raise ValueError("empty decoded image")
    return raw, guess_image_ext_from_magic(raw)
