"""QwenPaw Web 认证：按 config.toml [qwenpaw.auth] 解析并初始化 token（仅内存，不写缓存文件）。"""

from __future__ import annotations

from glasses.common.logging_util import log
from glasses.qwenpaw import QwenPawChatError, console_auth_login
from glasses.qwenpaw.types import QwenPawHttpError
from glasses.server.config import ServerConfig


def validate_qwenpaw_auth_config(cfg: ServerConfig) -> None:
    """enabled=true 时校验是否配置了 token 或 username+password。"""
    if not cfg.qwenpaw_auth_enabled:
        return
    if cfg.qwenpaw_auth_token:
        return
    if cfg.qwenpaw_auth_username and cfg.qwenpaw_auth_password:
        return
    raise SystemExit(
        "[qwenpaw.auth] enabled=true 但未配置有效认证信息。"
        "请填写 token，或填写 username+password（token 非空时优先使用 token）。"
    )


def uses_manual_token_only(cfg: ServerConfig) -> bool:
    """enabled=true 且配置了 token，且未同时配置完整的用户名密码（用于 401 提示）。"""
    if not cfg.qwenpaw_auth_enabled or not cfg.qwenpaw_auth_token:
        return False
    return not (cfg.qwenpaw_auth_username and cfg.qwenpaw_auth_password)


def format_qwenpaw_chat_error(cfg: ServerConfig, err: Exception) -> str:
    """将 QwenPaw 异常转为面向参赛者的 SCError 文案。"""
    if isinstance(err, QwenPawHttpError) and err.status in (401, 403):
        if not cfg.qwenpaw_auth_enabled:
            return (
                f"QwenPaw 认证失败（HTTP {err.status}）：请在 config.toml 将 [qwenpaw.auth].enabled 设为 true "
                "并配置 token 或 username+password。"
            )
        if uses_manual_token_only(cfg):
            return (
                f"QwenPaw 认证失败（HTTP {err.status}）：config.toml 中的 token 可能已失效。"
                "请重新登录 QwenPaw 获取 token，更新 [qwenpaw.auth].token 后重启 glasses-server。"
            )
        return (
            f"QwenPaw 认证失败（HTTP {err.status}）：{err}。"
            "若使用 username/password，请检查账号密码是否正确。"
        )
    if isinstance(err, QwenPawChatError):
        return f"QwenPaw 转发失败: {err}"
    return f"QwenPaw 转发异常: {err}"


async def setup_qwenpaw_auth(cfg: ServerConfig) -> None:
    """根据 enabled 与配置项初始化 cfg.qwenpaw_auth_token（仅进程内有效）。"""
    if not cfg.qwenpaw_auth_enabled:
        cfg.qwenpaw_auth_token = None
        log("[qwenpaw] Web auth disabled (qwenpaw.auth.enabled=false); requests will not send Authorization")
        return

    validate_qwenpaw_auth_config(cfg)

    if cfg.qwenpaw_auth_token:
        if cfg.qwenpaw_auth_username or cfg.qwenpaw_auth_password:
            log("[qwenpaw] Web auth enabled: using token from config.toml (username/password ignored)")
        else:
            log("[qwenpaw] Web auth enabled: using token from config.toml")
        return

    log("[qwenpaw] Web auth enabled: logging in with username/password from config.toml")
    token = await console_auth_login(
        cfg=cfg.qwenpaw,
        username=cfg.qwenpaw_auth_username or "",
        password=cfg.qwenpaw_auth_password or "",
        expires_in_s=cfg.qwenpaw_auth_expires_in_s,
    )
    cfg.qwenpaw_auth_token = token
    log("[qwenpaw] Web auth token obtained (in memory; restart will login again)")
