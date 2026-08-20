"""联调服务端启动入口（WebSocket + HTTP）。"""

from __future__ import annotations

import asyncio
import signal

import websockets
from aiohttp import web

from glasses.common.logging_util import log
from glasses.server.config import ServerConfig, parse_args, server_config_from_args
from glasses.server.data_bridge import bridge_cors_middleware, register_bridge_routes
from glasses.server.http_routes import register_routes
from glasses.server.qwenpaw_auth_setup import setup_qwenpaw_auth
from glasses.server.telegram_agent import send_telegram_photo_to_agent, send_telegram_text_to_agent
from glasses.server.telegram_bridge import TelegramMirror
from glasses.server.ws_handler import handle_connection


async def run_server(cfg: ServerConfig) -> None:
    stop = asyncio.Future()

    def _on_stop() -> None:
        if not stop.done():
            stop.set_result(None)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _on_stop)
        except NotImplementedError:
            pass

    cfg.media_dir.mkdir(parents=True, exist_ok=True)
    log(f"Media directory: {cfg.media_dir.resolve()}")

    app = web.Application(
        client_max_size=cfg.http_max_bytes,
        middlewares=[bridge_cors_middleware],
    )
    register_routes(app, cfg)
    register_bridge_routes(app, cfg)
    runner = web.AppRunner(app)
    await runner.setup()
    http_site = web.TCPSite(runner, cfg.http_host, cfg.http_port)
    await http_site.start()
    if cfg.bridge_enabled:
        if cfg.bridge_token:
            log("[bridge] read-only event API enabled: GET /api/bridge/events, WS /api/bridge/ws")
        else:
            log("[bridge] enabled but GLASSES_BRIDGE_TOKEN is missing; API will reject all requests")
    http_path = "/api/chat/resources/upload"
    log(
        f"HTTP listening on {cfg.http_host}:{cfg.http_port}{http_path} "
        f"(GET /media/{{user_id}}/{{filename}})"
    )

    telegram: TelegramMirror | None = None
    telegram_status: TelegramMirror | None = None
    if cfg.telegram_enabled:
        if cfg.telegram_bot_token and cfg.telegram_chat_id:
            telegram = TelegramMirror(
                bridge=cfg.event_bridge,
                bot_token=cfg.telegram_bot_token,
                chat_id=cfg.telegram_chat_id,
                cfg=cfg,
                interactive=cfg.telegram_interactive,
                agent_handler=lambda user_id, device_id, text: send_telegram_text_to_agent(
                    cfg, user_id, device_id, text
                ),
                mirror_kind="ambassador",
                photo_handler=lambda user_id, device_id, data, filename, caption: send_telegram_photo_to_agent(
                    cfg, user_id, device_id, data, filename, caption
                ),
            )
            try:
                await telegram.start()
            except Exception as exc:
                telegram = None
                log(f"[telegram] mirror disabled: {exc}")
        else:
            log("[telegram] enabled but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID is missing; mirror disabled")

    if cfg.telegram_status_enabled:
        if cfg.telegram_status_bot_token and cfg.telegram_status_chat_id:
            telegram_status = TelegramMirror(
                bridge=cfg.event_bridge,
                bot_token=cfg.telegram_status_bot_token,
                chat_id=cfg.telegram_status_chat_id,
                cfg=cfg,
                interactive=False,
                mirror_kind="status",
            )
            try:
                await telegram_status.start()
            except Exception as exc:
                telegram_status = None
                log(f"[telegram:status] mirror disabled: {exc}")
        else:
            log("[telegram:status] enabled but status bot token/chat ID is missing; mirror disabled")

    async with websockets.serve(lambda c: handle_connection(c, cfg), cfg.host, cfg.port) as server:
        actual_port = cfg.port
        try:
            if actual_port == 0 and getattr(server, "sockets", None):
                actual_port = server.sockets[0].getsockname()[1]
        except Exception:
            pass
        log(f"WebSocket listening on {cfg.host}:{actual_port}/chat")
        try:
            await stop
        finally:
            if telegram is not None:
                await telegram.stop()
            if telegram_status is not None:
                await telegram_status.stop()
            await runner.cleanup()


def main() -> None:
    args = parse_args()
    cfg = server_config_from_args(args)

    async def _main() -> None:
        await setup_qwenpaw_auth(cfg)
        await run_server(cfg)

    asyncio.run(_main())


if __name__ == "__main__":
    main()
