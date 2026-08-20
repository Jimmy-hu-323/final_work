from __future__ import annotations

from pathlib import Path

from glasses.server.config import parse_args, server_config_from_args


def _cfg(argv: list[str]):
    args = parse_args(argv)
    return server_config_from_args(args)


def test_manual_token_has_priority_over_username_password() -> None:
    cfg = _cfg(
        [
            "--qwenpaw-auth-token",
            "manual_token",
            "--qwenpaw-auth-username",
            "admin",
            "--qwenpaw-auth-password",
            "secret",
        ]
    )
    assert cfg.qwenpaw_auth_token == "manual_token"
    assert cfg.qwenpaw_auth_username == "admin"
    assert cfg.qwenpaw_auth_password == "secret"


def test_prompts_default_when_empty_string_provided(tmp_path: Path) -> None:
    cfg = _cfg(
        [
            "--config",
            str(tmp_path / "missing.toml"),
            "--qwenpaw-video-prompt",
            "",
            "--qwenpaw-image-prompt",
            "",
        ]
    )
    assert cfg.qwenpaw_video_prompt
    assert cfg.qwenpaw_image_prompt
    assert cfg.qwenpaw_video_prompt == "请总结这个视频的主要内容，并用简洁中文回答。"
    assert cfg.qwenpaw_image_prompt == "分析这张图片，并用简洁中文回答。"


def test_expires_in_zero_is_treated_as_none() -> None:
    cfg = _cfg(["--qwenpaw-auth-expires-in-s", "0"])
    assert cfg.qwenpaw_auth_expires_in_s is None
