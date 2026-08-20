"""QwenPaw Web 认证 token 刷新（仅 username/password，内存更新）。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from glasses.common.logging_util import log
from glasses.qwenpaw import QwenPawChatError, console_auth_login
from glasses.server.config import ServerConfig


def make_on_auth_refresh(cfg: ServerConfig) -> Callable[[], Awaitable[str]] | None:
    """仅当 enabled=true 且配置了 username+password 时，在 401/403 时自动重新登录一次。"""
    if not cfg.qwenpaw_auth_enabled:
        return None
    if not (cfg.qwenpaw_auth_username and cfg.qwenpaw_auth_password):
        return None

    async def _refresh() -> str:
        async with cfg.qwenpaw_auth_lock:
            try:
                log("[qwenpaw] token expired or rejected; re-login with username/password (once)")
                token = await console_auth_login(
                    cfg=cfg.qwenpaw,
                    username=cfg.qwenpaw_auth_username or "",
                    password=cfg.qwenpaw_auth_password or "",
                    expires_in_s=cfg.qwenpaw_auth_expires_in_s,
                )
            except Exception as e:
                raise QwenPawChatError(f"auth refresh failed: {e}") from e

            cfg.qwenpaw_auth_token = token
            log("[qwenpaw] web auth token refreshed (in memory)")
            return token

    return _refresh
