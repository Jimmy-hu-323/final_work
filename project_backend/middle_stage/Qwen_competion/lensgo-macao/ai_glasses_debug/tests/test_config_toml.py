from __future__ import annotations

from pathlib import Path

from glasses.common.config_toml import load_toml_config, parse_client_values, parse_server_values
from glasses.server.config import parse_args as parse_server_args
from glasses.server.config import server_config_from_args


def test_load_optional_missing_file_returns_empty(tmp_path: Path) -> None:
    p = tmp_path / "missing.toml"
    cfg = load_toml_config(p, required=False)
    assert cfg.data == {}


def test_server_values_resolve_media_dir_relative_to_config_file(tmp_path: Path) -> None:
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text(
        '\n'.join(
            [
                "[server]",
                'media_dir = "./tmp_media"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    cfg = load_toml_config(cfg_file, required=True)
    v = parse_server_values(cfg)
    assert v.media_dir is not None
    assert v.media_dir == (tmp_path / "tmp_media").resolve()


def test_client_values_from_toml_and_cli_override(tmp_path: Path) -> None:
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text(
        '\n'.join(
            [
                "[client]",
                'ws_url = "ws://1.2.3.4:1111/chat"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    # server side: ensure --port overrides toml
    cfg_file.write_text(
        cfg_file.read_text(encoding="utf-8")
        + "\n".join(
            [
                "[server]",
                "port = 9000",
                "",
            ]
        ),
        encoding="utf-8",
    )
    args = parse_server_args(["--config", str(cfg_file), "--port", "9001"])
    cfg = server_config_from_args(args)
    assert cfg.port == 9001

    # client table parse sanity
    toml = load_toml_config(cfg_file, required=True)
    cv = parse_client_values(toml)
    assert cv.ws_url == "ws://1.2.3.4:1111/chat"


def test_status_telegram_config_is_parsed(tmp_path: Path) -> None:
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text(
        "[telegram.status]\n"
        "enabled = true\n"
        'bot_token_env = "MY_STATUS_TOKEN"\n'
        'chat_id_env = "MY_STATUS_CHAT"\n',
        encoding="utf-8",
    )
    values = parse_server_values(load_toml_config(cfg_file, required=True))
    assert values.telegram_status_enabled is True
    assert values.telegram_status_bot_token_env == "MY_STATUS_TOKEN"
    assert values.telegram_status_chat_id_env == "MY_STATUS_CHAT"
