"""测试客户端配置与命令行。"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

from glasses.common.config_toml import load_toml_config, parse_client_values

_DEFAULT_DEMO_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJleHAiOjE3NzgzMTg5NTMsImlhdCI6MTc3ODIzMjU1MywidXNlcklkIjo5OTA4OTAxOTc2OH0."
    "gQ9QouICGRDkxAV2j9OY_O_4YrOECnLzPAW7mYOZObw"
)


@dataclass
class ClientConfig:
    url: str
    access_token: str
    device_id: str
    ask_type: int | None
    content: str | None
    image_file: str | None
    intent_image_file: str | None
    video_file: str | None
    http_upload_url: str
    interactive: bool
    verbose_log: bool


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI 眼镜协议联调客户端")
    p.add_argument(
        "--config",
        default=None,
        help="TOML 配置文件路径（默认：./config.toml；存在则读取，不存在则忽略）",
    )
    p.add_argument("--url", default=None, help="WebSocket 地址（默认 ws://127.0.0.1:8765/chat）")
    p.add_argument(
        "--http-upload-url",
        default=None,
        help="HTTP 上传地址（默认 http://127.0.0.1:8866/api/chat/resources/upload）",
    )
    p.add_argument(
        "--access-token",
        default=None,
        help="JWT，payload 需含 userId；也可用环境变量 GLASSES_ACCESS_TOKEN",
    )
    p.add_argument(
        "--device-id",
        default=None,
    )
    p.add_argument(
        "--ask-type",
        type=int,
        default=None,
        help="1=文字，2=图片识物，3=意图识别上传图片，4=视频上传（WS+HTTP）",
    )
    p.add_argument("--content", default=None)
    p.add_argument("--image-file", default=None, help="发送图片的本地路径（askType=2/3）")
    p.add_argument("--video-file", default=None, help="要上传的 mp4 路径（askType=4 时可用）")
    p.add_argument(
        "--intent-image-file",
        default=None,
        help="收到 SCIntentMessage 后要发送的图片路径（askType=3）",
    )
    p.add_argument("--interactive", action=argparse.BooleanOptionalAction, default=False)
    p.add_argument("--verbose-log", action="store_true", help="日志输出完整 Base64 图片字段")
    return p.parse_args(argv)


def client_config_from_args(args: argparse.Namespace) -> ClientConfig:
    ws_url = "ws://127.0.0.1:8765/chat"
    http_upload_url = "http://127.0.0.1:8866/api/chat/resources/upload"
    access_token = _DEFAULT_DEMO_JWT
    device_id = "2C:BE:EB:54:45:41"
    verbose_log = False

    config_path = (getattr(args, "config", None) or "").strip() or "config.toml"
    toml = load_toml_config(config_path, required=False)
    v = parse_client_values(toml)
    ws_url = v.ws_url or ws_url
    http_upload_url = v.http_upload_url or http_upload_url
    access_token = v.access_token or access_token
    device_id = v.device_id or device_id
    verbose_log = v.verbose_log if v.verbose_log is not None else verbose_log

    if getattr(args, "url", None):
        ws_url = str(args.url)
    if getattr(args, "http_upload_url", None):
        http_upload_url = str(args.http_upload_url)
    if getattr(args, "access_token", None) is not None:
        access_token = str(args.access_token).strip() or access_token
    if getattr(args, "device_id", None) is not None:
        device_id = str(args.device_id).strip() or device_id
    if bool(getattr(args, "verbose_log", False)):
        verbose_log = True

    return ClientConfig(
        url=ws_url,
        access_token=access_token,
        device_id=device_id,
        ask_type=args.ask_type,
        content=args.content,
        image_file=args.image_file,
        intent_image_file=args.intent_image_file,
        video_file=args.video_file,
        http_upload_url=http_upload_url,
        interactive=bool(args.interactive),
        verbose_log=bool(verbose_log),
    )
