from __future__ import annotations

import pytest

from glasses.server.config import parse_args, server_config_from_args
from glasses.server.qwenpaw_auth_setup import validate_qwenpaw_auth_config


def _cfg(extra: list[str]):
    args = parse_args(extra)
    return server_config_from_args(args)


def test_enabled_false_ignores_token_in_config(tmp_path, monkeypatch) -> None:
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text(
        '\n'.join(
            [
                "[qwenpaw.auth]",
                "enabled = false",
                'token = "should_not_be_used"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    cfg = _cfg(["--config", str(cfg_file)])
    assert cfg.qwenpaw_auth_enabled is False
    assert cfg.qwenpaw_auth_token == "should_not_be_used"  # parsed but setup clears it


@pytest.mark.asyncio
async def test_setup_clears_token_when_disabled(tmp_path) -> None:
    from glasses.server.qwenpaw_auth_setup import setup_qwenpaw_auth

    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text(
        '\n'.join(
            [
                "[qwenpaw.auth]",
                "enabled = false",
                'token = "t"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    cfg = _cfg(["--config", str(cfg_file)])
    await setup_qwenpaw_auth(cfg)
    assert cfg.qwenpaw_auth_token is None


def test_enabled_true_without_credentials_exits() -> None:
    cfg = _cfg([])
    cfg.qwenpaw_auth_enabled = True
    cfg.qwenpaw_auth_token = None
    cfg.qwenpaw_auth_username = None
    cfg.qwenpaw_auth_password = None
    with pytest.raises(SystemExit):
        validate_qwenpaw_auth_config(cfg)


def test_enabled_true_with_token_ok() -> None:
    cfg = _cfg([])
    cfg.qwenpaw_auth_enabled = True
    cfg.qwenpaw_auth_token = "tok"
    validate_qwenpaw_auth_config(cfg)


def test_format_manual_token_401_hint() -> None:
    from glasses.qwenpaw.types import QwenPawHttpError
    from glasses.server.qwenpaw_auth_setup import format_qwenpaw_chat_error

    cfg = _cfg([])
    cfg.qwenpaw_auth_enabled = True
    cfg.qwenpaw_auth_token = "old"
    msg = format_qwenpaw_chat_error(cfg, QwenPawHttpError(401, "HTTP 401"))
    assert "config.toml" in msg
    assert "重启" in msg
