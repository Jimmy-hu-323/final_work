"""服务端配置与命令行参数。"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from websockets.server import ServerConnection

from glasses.common.config_toml import load_toml_config, parse_server_values
from glasses.qwenpaw import QwenPawChatConfig
from glasses.server.auth import TokenPolicy
from glasses.server.data_bridge import EventBridge
from glasses.server.lensgo_memory import LensGoMemory
from glasses.server.media import default_media_dir


@dataclass
class ServerConfig:
    host: str
    port: int
    http_host: str
    http_port: int
    http_max_bytes: int
    media_dir: Path
    intent_demo: bool
    intent_keywords: re.Pattern[str]
    finish_keywords: re.Pattern[str]
    token_policy: TokenPolicy
    verbose_log: bool
    ws_conns_by_user_device: dict[tuple[str, str], ServerConnection] = field(default_factory=dict)
    ws_send_locks_by_user_device: dict[tuple[str, str], asyncio.Lock] = field(default_factory=dict)
    qwenpaw: QwenPawChatConfig = field(default_factory=QwenPawChatConfig)
    qwenpaw_auth_enabled: bool = False
    qwenpaw_auth_token: str | None = None
    qwenpaw_auth_username: str | None = None
    qwenpaw_auth_password: str | None = None
    qwenpaw_auth_expires_in_s: int | None = None
    qwenpaw_video_prompt: str = "请总结这个视频的主要内容，并用简洁中文回答。"
    qwenpaw_image_prompt: str = "分析这张图片，并用简洁中文回答。"
    qwenpaw_chat_id_by_user_device: dict[tuple[str, str], str] = field(default_factory=dict)
    qwenpaw_inflight_tasks: dict[tuple[str, str], object] = field(default_factory=dict)
    qwenpaw_streaming: dict[tuple[str, str], bool] = field(default_factory=dict)
    qwenpaw_auth_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    bridge_enabled: bool = False
    bridge_token: str | None = None
    event_bridge: EventBridge = field(default_factory=EventBridge)
    telegram_enabled: bool = False
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    telegram_interactive: bool = False
    telegram_status_enabled: bool = False
    telegram_status_bot_token: str | None = None
    telegram_status_chat_id: str | None = None
    lensgo_memory: LensGoMemory | None = None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI 眼镜 QwenPaw 联调服务端（WebSocket + HTTP）")
    p.add_argument(
        "--config",
        default=None,
        help="TOML 配置文件路径（默认：./config.toml；存在则读取，不存在则忽略）",
    )
    p.add_argument("--host", default=None, help="WebSocket 监听地址（默认 0.0.0.0）")
    p.add_argument("--port", type=int, default=None, help="WebSocket 端口（默认 8765）")
    p.add_argument("--http-host", default=None, help="HTTP 监听地址（默认 0.0.0.0）")
    p.add_argument("--http-port", type=int, default=None, help="HTTP 端口（默认 8866）")
    p.add_argument("--http-max-mb", type=int, default=None, help="上传 mp4 最大大小（MB，默认 50）")
    p.add_argument(
        "--media-dir",
        default=None,
        help="图片/视频临时存储根目录（默认：项目下 tmp_media/）",
    )
    p.add_argument("--intent-demo", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument(
        "--intent-keywords",
        default=None,
        help="触发意图识别的关键词正则（命中后推送 SCIntentMessage）",
    )
    p.add_argument(
        "--finish-keywords",
        default=None,
        help="命中后推送 SCFinishAIMessage 的退出用语正则",
    )
    p.add_argument("--verbose-log", action="store_true", help="日志输出完整 Base64 图片字段")

    g = p.add_mutually_exclusive_group()
    g.add_argument(
        "--token-allow-any",
        action="store_true",
        default=None,
        help="只要非空 token 就放行（默认）",
    )
    g.add_argument("--token-allowlist", default=None, help="允许的 token 列表，逗号分隔")
    g.add_argument("--token-regex", default=None, help="允许的 token 正则 fullmatch")

    p.add_argument(
        "--qwenpaw-base-url",
        default=None,
        help="QwenPaw 服务地址",
    )
    p.add_argument(
        "--qwenpaw-agent-id",
        default=None,
        help="QwenPaw 的 X-Agent-Id（默认 default）",
    )
    p.add_argument(
        "--qwenpaw-timeout-s",
        type=float,
        default=None,
        help="转发到 QwenPaw 的总超时（秒）",
    )
    p.add_argument(
        "--qwenpaw-auth-token",
        default=None,
        help="QwenPaw Web 登录认证 token（可选，远程访问启用认证时需要）",
    )
    p.add_argument(
        "--qwenpaw-auth-username",
        default=None,
        help="QwenPaw Web 登录认证用户名（可选；未配置 token 时可用用户名/密码启动登录获取 token）",
    )
    p.add_argument(
        "--qwenpaw-auth-password",
        default=None,
        help="QwenPaw Web 登录认证密码（可选；未配置 token 时可用用户名/密码启动登录获取 token）",
    )
    p.add_argument(
        "--qwenpaw-auth-expires-in-s",
        type=int,
        default=None,
        help="自动登录获取 token 的有效期（秒，可选；0 表示使用 QwenPaw 默认值）",
    )
    p.add_argument(
        "--qwenpaw-video-prompt",
        default=None,
        help="视频分析提示词（可选）",
    )
    p.add_argument(
        "--qwenpaw-image-prompt",
        default=None,
        help="图片分析提示词（可选，askType=2/3 共用）",
    )
    return p.parse_args(argv)


def server_config_from_args(args: argparse.Namespace) -> ServerConfig:
    # 1) base defaults
    host = "0.0.0.0"
    port = 8765
    http_host = "0.0.0.0"
    http_port = 8866
    http_max_mb = 50
    media_dir = default_media_dir()
    intent_demo = True
    intent_keywords = "识物|看看|这是啥|这是什么|面前|物体|拍照"
    finish_keywords = "退出|退下吧|退下|再见了|拜拜|没事了|不说了|你先退(?:下)?|结束(?:会话|对话)|算了"
    verbose_log = False

    token_mode = "allow_any"
    token_allowlist_list: list[str] = []
    token_regex_str: str | None = None

    qwenpaw_base_url = "http://127.0.0.1:8088"
    qwenpaw_agent_id = "default"
    qwenpaw_timeout_s = 300.0
    qwenpaw_auth_enabled = False
    qwenpaw_auth_token: str | None = None
    qwenpaw_auth_username: str | None = None
    qwenpaw_auth_password: str | None = None
    qwenpaw_auth_expires_in_s: int | None = None
    qwenpaw_video_prompt = "请总结这个视频的主要内容，并用简洁中文回答。"
    qwenpaw_image_prompt = "分析这张图片，并用简洁中文回答。"
    bridge_enabled = False
    bridge_history_size = 200
    bridge_token_env = "GLASSES_BRIDGE_TOKEN"
    telegram_enabled = False
    telegram_bot_token_env = "TELEGRAM_BOT_TOKEN"
    telegram_chat_id_env = "TELEGRAM_CHAT_ID"
    telegram_interactive = False
    telegram_status_enabled = False
    telegram_status_bot_token_env = "TELEGRAM_STATUS_BOT_TOKEN"
    telegram_status_chat_id_env = "TELEGRAM_STATUS_CHAT_ID"

    # 2) file (./config.toml exists) overrides defaults
    config_path = (getattr(args, "config", None) or "").strip() or "config.toml"
    toml = load_toml_config(config_path, required=False)
    v = parse_server_values(toml)

    host = v.host or host
    port = v.port or port
    http_host = v.http_host or http_host
    http_port = v.http_port or http_port
    http_max_mb = v.http_max_mb or http_max_mb
    media_dir = v.media_dir or media_dir
    intent_demo = v.intent_demo if v.intent_demo is not None else intent_demo
    intent_keywords = v.intent_keywords or intent_keywords
    finish_keywords = v.finish_keywords or finish_keywords
    verbose_log = v.verbose_log if v.verbose_log is not None else verbose_log

    if v.token_mode:
        token_mode = v.token_mode
    if v.token_allowlist is not None:
        token_allowlist_list = v.token_allowlist
    if v.token_regex is not None:
        token_regex_str = v.token_regex or None

    qwenpaw_base_url = v.qwenpaw_base_url or qwenpaw_base_url
    qwenpaw_agent_id = v.qwenpaw_agent_id or qwenpaw_agent_id
    qwenpaw_timeout_s = v.qwenpaw_timeout_s or qwenpaw_timeout_s
    qwenpaw_video_prompt = v.qwenpaw_video_prompt or qwenpaw_video_prompt
    qwenpaw_image_prompt = v.qwenpaw_image_prompt or qwenpaw_image_prompt
    if v.qwenpaw_auth_enabled is not None:
        qwenpaw_auth_enabled = v.qwenpaw_auth_enabled
    qwenpaw_auth_token = v.qwenpaw_auth_token or qwenpaw_auth_token
    qwenpaw_auth_username = v.qwenpaw_auth_username or qwenpaw_auth_username
    qwenpaw_auth_password = v.qwenpaw_auth_password or qwenpaw_auth_password
    if v.qwenpaw_auth_expires_in_s is not None:
        qwenpaw_auth_expires_in_s = v.qwenpaw_auth_expires_in_s
    if v.bridge_enabled is not None:
        bridge_enabled = v.bridge_enabled
    if v.bridge_history_size is not None:
        bridge_history_size = max(1, v.bridge_history_size)
    bridge_token_env = v.bridge_token_env or bridge_token_env
    if v.telegram_enabled is not None:
        telegram_enabled = v.telegram_enabled
    telegram_bot_token_env = v.telegram_bot_token_env or telegram_bot_token_env
    telegram_chat_id_env = v.telegram_chat_id_env or telegram_chat_id_env
    if v.telegram_interactive is not None:
        telegram_interactive = v.telegram_interactive
    if v.telegram_status_enabled is not None:
        telegram_status_enabled = v.telegram_status_enabled
    telegram_status_bot_token_env = v.telegram_status_bot_token_env or telegram_status_bot_token_env
    telegram_status_chat_id_env = v.telegram_status_chat_id_env or telegram_status_chat_id_env

    # 3) CLI overrides config file (only if explicitly provided)
    if getattr(args, "host", None):
        host = str(args.host)
    if getattr(args, "port", None) is not None:
        port = int(args.port)
    if getattr(args, "http_host", None):
        http_host = str(args.http_host)
    if getattr(args, "http_port", None) is not None:
        http_port = int(args.http_port)
    if getattr(args, "http_max_mb", None) is not None:
        http_max_mb = int(args.http_max_mb)
    if getattr(args, "media_dir", None):
        media_dir = Path(args.media_dir).expanduser().resolve()
    if getattr(args, "intent_demo", None) is not None:
        intent_demo = bool(args.intent_demo)
    if getattr(args, "intent_keywords", None):
        intent_keywords = str(args.intent_keywords)
    if getattr(args, "finish_keywords", None):
        finish_keywords = str(args.finish_keywords)
    if bool(getattr(args, "verbose_log", False)):
        verbose_log = True

    if getattr(args, "token_allow_any", None):
        token_mode = "allow_any"
        token_allowlist_list = []
        token_regex_str = None
    if getattr(args, "token_allowlist", None):
        token_mode = "allowlist"
        token_allowlist_list = [t.strip() for t in str(args.token_allowlist).split(",") if t.strip()]
        token_regex_str = None
    if getattr(args, "token_regex", None):
        token_mode = "regex"
        token_regex_str = str(args.token_regex).strip() or None
        token_allowlist_list = []

    if getattr(args, "qwenpaw_base_url", None):
        qwenpaw_base_url = str(args.qwenpaw_base_url)
    if getattr(args, "qwenpaw_agent_id", None):
        qwenpaw_agent_id = str(args.qwenpaw_agent_id)
    if getattr(args, "qwenpaw_timeout_s", None) is not None:
        qwenpaw_timeout_s = float(args.qwenpaw_timeout_s)
    if getattr(args, "qwenpaw_auth_token", None) is not None:
        qwenpaw_auth_token = str(args.qwenpaw_auth_token).strip() or None
    if getattr(args, "qwenpaw_auth_username", None) is not None:
        qwenpaw_auth_username = str(args.qwenpaw_auth_username).strip() or None
    if getattr(args, "qwenpaw_auth_password", None) is not None:
        qwenpaw_auth_password = str(args.qwenpaw_auth_password).strip() or None
    if getattr(args, "qwenpaw_auth_expires_in_s", None) is not None:
        n = int(args.qwenpaw_auth_expires_in_s)
        qwenpaw_auth_expires_in_s = n if n > 0 else None
    if getattr(args, "qwenpaw_video_prompt", None) is not None:
        qwenpaw_video_prompt = str(args.qwenpaw_video_prompt).strip() or qwenpaw_video_prompt
    if getattr(args, "qwenpaw_image_prompt", None) is not None:
        qwenpaw_image_prompt = str(args.qwenpaw_image_prompt).strip() or qwenpaw_image_prompt

    token_allow_any = token_mode == "allow_any"
    token_allowlist = set(token_allowlist_list)
    token_regex = re.compile(token_regex_str) if token_regex_str else None

    return ServerConfig(
        host=host,
        port=port,
        http_host=http_host,
        http_port=http_port,
        http_max_bytes=int(http_max_mb) * 1024 * 1024,
        media_dir=media_dir,
        intent_demo=bool(intent_demo),
        intent_keywords=re.compile(intent_keywords),
        finish_keywords=re.compile(finish_keywords),
        token_policy=TokenPolicy(
            allow_any=token_allow_any,
            allowlist=token_allowlist,
            token_regex=token_regex,
        ),
        verbose_log=bool(verbose_log),
        qwenpaw=QwenPawChatConfig(
            base_url=qwenpaw_base_url,
            agent_id=qwenpaw_agent_id,
            timeout_s=float(qwenpaw_timeout_s),
        ),
        qwenpaw_auth_enabled=bool(qwenpaw_auth_enabled),
        qwenpaw_auth_token=qwenpaw_auth_token,
        qwenpaw_auth_username=qwenpaw_auth_username,
        qwenpaw_auth_password=qwenpaw_auth_password,
        qwenpaw_auth_expires_in_s=qwenpaw_auth_expires_in_s,
        qwenpaw_video_prompt=qwenpaw_video_prompt,
        qwenpaw_image_prompt=qwenpaw_image_prompt,
        bridge_enabled=bool(bridge_enabled),
        bridge_token=os.getenv(bridge_token_env),
        event_bridge=EventBridge(history_size=bridge_history_size),
        telegram_enabled=bool(telegram_enabled),
        telegram_bot_token=os.getenv(telegram_bot_token_env),
        telegram_chat_id=os.getenv(telegram_chat_id_env),
        telegram_interactive=bool(telegram_interactive),
        telegram_status_enabled=bool(telegram_status_enabled),
        telegram_status_bot_token=os.getenv(telegram_status_bot_token_env),
        telegram_status_chat_id=os.getenv(telegram_status_chat_id_env),
        lensgo_memory=LensGoMemory(media_dir.parent / "data" / "lensgo_memory.db"),
    )
