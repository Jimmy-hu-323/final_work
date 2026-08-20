"""联调鉴权：JWT userId 解析与 token 策略（不验签，仅用于本地/demo）。"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Optional


def bearer_token_from_auth_header(auth: str) -> Optional[str]:
    auth = (auth or "").strip()
    if not auth:
        return None
    m = re.match(r"^Bearer\s+(.+)$", auth, flags=re.IGNORECASE)
    if not m:
        return None
    token = m.group(1).strip()
    return token or None


def _b64url_decode_to_bytes(s: str) -> bytes:
    s = (s or "").strip()
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii"))


def parse_user_id_from_jwt(token: str) -> Optional[str]:
    """
    仅解码 JWT payload，不验签、不验 exp。
    生产环境必须由业务网关验签并校验 exp。
    """
    parts = (token or "").split(".")
    if len(parts) < 2:
        return None
    try:
        payload_raw = _b64url_decode_to_bytes(parts[1])
        payload = json.loads(payload_raw.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    user_id = payload.get("userId")
    if isinstance(user_id, (str, int)):
        s = str(user_id).strip()
        return s or None
    return None


@dataclass
class TokenPolicy:
    allow_any: bool
    allowlist: set[str]
    token_regex: Optional[re.Pattern[str]]

    def ok(self, access_token: str) -> bool:
        if self.allow_any:
            return bool(access_token)
        if access_token in self.allowlist:
            return True
        if self.token_regex and self.token_regex.fullmatch(access_token):
            return True
        return False
