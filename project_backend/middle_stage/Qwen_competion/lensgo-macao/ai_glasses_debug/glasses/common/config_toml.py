"""TOML 配置读取工具（供 glasses-server / glasses-client 共用）。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


def _toml_loads(text: str) -> dict[str, Any]:
    """兼容 Python 3.10/3.11 的 TOML 解析。"""
    try:
        import tomllib  # type: ignore[attr-defined]

        return tomllib.loads(text)
    except ModuleNotFoundError:  # pragma: no cover (py<3.11)
        import tomli  # type: ignore[import-not-found]

        return tomli.loads(text)


@dataclass(frozen=True)
class TomlConfig:
    path: Path
    data: dict[str, Any]


def load_toml_config(path: str | Path, *, required: bool = False) -> TomlConfig:
    """读取 TOML 配置文件。

    - required=False：文件不存在则返回空配置（data={}）
    - required=True：文件不存在则抛出 FileNotFoundError
    """
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    else:
        p = p.resolve()

    if not p.exists():
        if required:
            raise FileNotFoundError(str(p))
        return TomlConfig(path=p, data={})

    text = p.read_text(encoding="utf-8")
    data = _toml_loads(text) if text.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("TOML 顶层必须是 table/object")
    return TomlConfig(path=p, data=data)


def get_table(root: Mapping[str, Any], dotted: str) -> Mapping[str, Any]:
    cur: Any = root
    for part in dotted.split("."):
        if not isinstance(cur, Mapping):
            return {}
        cur = cur.get(part)
        if cur is None:
            return {}
    return cur if isinstance(cur, Mapping) else {}


def resolve_path(base_file: Path, raw: str | None) -> Path | None:
    if not raw:
        return None
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p.resolve()
    return (base_file.parent / p).resolve()


def _as_str(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return None


def _as_bool(v: Any) -> bool | None:
    if isinstance(v, bool):
        return v
    return None


def _as_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    return None


def _as_float(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _as_list_str(v: Any) -> list[str] | None:
    if not isinstance(v, list):
        return None
    out: list[str] = []
    for item in v:
        if not isinstance(item, str):
            return None
        s = item.strip()
        if s:
            out.append(s)
    return out


@dataclass(frozen=True)
class ServerTomlValues:
    host: str | None = None
    port: int | None = None
    http_host: str | None = None
    http_port: int | None = None
    http_max_mb: int | None = None
    media_dir: Path | None = None
    intent_demo: bool | None = None
    intent_keywords: str | None = None
    finish_keywords: str | None = None
    verbose_log: bool | None = None

    token_mode: str | None = None  # allow_any | allowlist | regex
    token_allowlist: list[str] | None = None
    token_regex: str | None = None

    qwenpaw_base_url: str | None = None
    qwenpaw_agent_id: str | None = None
    qwenpaw_timeout_s: float | None = None
    qwenpaw_auth_enabled: bool | None = None
    qwenpaw_auth_token: str | None = None
    qwenpaw_auth_username: str | None = None
    qwenpaw_auth_password: str | None = None
    qwenpaw_auth_expires_in_s: int | None = None
    qwenpaw_video_prompt: str | None = None
    qwenpaw_image_prompt: str | None = None
    bridge_enabled: bool | None = None
    bridge_history_size: int | None = None
    bridge_token_env: str | None = None
    telegram_enabled: bool | None = None
    telegram_bot_token_env: str | None = None
    telegram_chat_id_env: str | None = None
    telegram_interactive: bool | None = None
    telegram_status_enabled: bool | None = None
    telegram_status_bot_token_env: str | None = None
    telegram_status_chat_id_env: str | None = None


def parse_server_values(cfg: TomlConfig) -> ServerTomlValues:
    root = cfg.data
    s = get_table(root, "server")
    intent = get_table(root, "server.intent")
    token = get_table(root, "server.token")
    q = get_table(root, "qwenpaw")
    qa = get_table(root, "qwenpaw.auth")
    bridge = get_table(root, "bridge")
    telegram = get_table(root, "telegram")
    telegram_status = get_table(root, "telegram.status")

    media_dir_raw = _as_str(s.get("media_dir"))
    return ServerTomlValues(
        host=_as_str(s.get("host")),
        port=_as_int(s.get("port")),
        http_host=_as_str(s.get("http_host")),
        http_port=_as_int(s.get("http_port")),
        http_max_mb=_as_int(s.get("http_max_mb")),
        media_dir=resolve_path(cfg.path, media_dir_raw) if media_dir_raw else None,
        intent_demo=_as_bool(intent.get("demo")),
        intent_keywords=_as_str(intent.get("intent_keywords")),
        finish_keywords=_as_str(intent.get("finish_keywords")),
        verbose_log=_as_bool(s.get("verbose_log")),
        token_mode=_as_str(token.get("mode")),
        token_allowlist=_as_list_str(token.get("allowlist")),
        token_regex=_as_str(token.get("regex")),
        qwenpaw_base_url=_as_str(q.get("base_url")),
        qwenpaw_agent_id=_as_str(q.get("agent_id")),
        qwenpaw_timeout_s=_as_float(q.get("timeout_s")),
        qwenpaw_video_prompt=_as_str(q.get("video_prompt")),
        qwenpaw_image_prompt=_as_str(q.get("image_prompt")),
        qwenpaw_auth_enabled=_as_bool(qa.get("enabled")),
        qwenpaw_auth_token=_as_str(qa.get("token")),
        qwenpaw_auth_username=_as_str(qa.get("username")),
        qwenpaw_auth_password=_as_str(qa.get("password")),
        qwenpaw_auth_expires_in_s=_as_int(qa.get("expires_in_s")),
        bridge_enabled=_as_bool(bridge.get("enabled")),
        bridge_history_size=_as_int(bridge.get("history_size")),
        bridge_token_env=_as_str(bridge.get("token_env")),
        telegram_enabled=_as_bool(telegram.get("enabled")),
        telegram_bot_token_env=_as_str(telegram.get("bot_token_env")),
        telegram_chat_id_env=_as_str(telegram.get("chat_id_env")),
        telegram_interactive=_as_bool(telegram.get("interactive")),
        telegram_status_enabled=_as_bool(telegram_status.get("enabled")),
        telegram_status_bot_token_env=_as_str(telegram_status.get("bot_token_env")),
        telegram_status_chat_id_env=_as_str(telegram_status.get("chat_id_env")),
    )


@dataclass(frozen=True)
class ClientTomlValues:
    ws_url: str | None = None
    http_upload_url: str | None = None
    access_token: str | None = None
    device_id: str | None = None
    verbose_log: bool | None = None


def parse_client_values(cfg: TomlConfig) -> ClientTomlValues:
    c = get_table(cfg.data, "client")
    return ClientTomlValues(
        ws_url=_as_str(c.get("ws_url")),
        http_upload_url=_as_str(c.get("http_upload_url")),
        access_token=_as_str(c.get("access_token")),
        device_id=_as_str(c.get("device_id")),
        verbose_log=_as_bool(c.get("verbose_log")),
    )
