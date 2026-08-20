import asyncio
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from glasses.server.data_bridge import (
    BridgeEvent,
    EventBridge,
    bridge_cors_middleware,
    register_bridge_routes,
)


def test_bridge_history_is_public_and_bounded(tmp_path):
    bridge = EventBridge(history_size=2)
    for index in range(3):
        bridge.publish(
            BridgeEvent(
                direction="upstream",
                event_type="image",
                user_id="u1",
                device_id="d1",
                data={"index": index, "media_url": f"/media/u1/{index}.jpg"},
                media_path=tmp_path / f"{index}.jpg",
            )
        )
    history = bridge.history(100)
    assert [item["data"]["index"] for item in history] == [1, 2]
    assert "media_path" not in history[0]


def test_bridge_subscriber_receives_event():
    async def run():
        bridge = EventBridge()
        queue = bridge.subscribe()
        event = BridgeEvent(
            direction="upstream",
            event_type="text",
            user_id="u1",
            device_id="d1",
            data={"content": "hello"},
        )
        bridge.publish(event)
        assert await asyncio.wait_for(queue.get(), timeout=0.1) is event
        bridge.unsubscribe(queue)

    asyncio.run(run())


def test_bridge_http_requires_token_and_returns_history():
    async def run():
        bridge = EventBridge()
        bridge.publish(BridgeEvent("upstream", "text", "u1", "d1", {"content": "hello"}))
        cfg = SimpleNamespace(bridge_enabled=True, bridge_token="secret", event_bridge=bridge)
        app = web.Application()
        register_bridge_routes(app, cfg)
        async with TestClient(TestServer(app)) as client:
            denied = await client.get("/api/bridge/events")
            assert denied.status == 401
            response = await client.get(
                "/api/bridge/events",
                headers={"Authorization": "Bearer secret"},
            )
            assert response.status == 200
            payload = await response.json()
            assert payload["events"][0]["data"]["content"] == "hello"

    asyncio.run(run())


def test_bridge_status_is_authenticated_and_cors_enabled():
    async def run():
        bridge = EventBridge(history_size=12)
        cfg = SimpleNamespace(
            bridge_enabled=True,
            bridge_token="secret",
            event_bridge=bridge,
            qwenpaw=SimpleNamespace(
                base_url="http://127.0.0.1:1",
                agent_id="lensgo-travel-director",
            ),
            telegram_enabled=True,
            telegram_bot_token="bot",
            telegram_chat_id="chat",
            telegram_status_enabled=True,
            telegram_status_bot_token=None,
            telegram_status_chat_id=None,
        )
        app = web.Application(middlewares=[bridge_cors_middleware])
        register_bridge_routes(app, cfg)
        async with TestClient(TestServer(app)) as client:
            response = await client.get(
                "/api/bridge/status",
                headers={
                    "Authorization": "Bearer secret",
                    "Origin": "http://tauri.localhost",
                },
            )
            assert response.status == 200
            assert response.headers["Access-Control-Allow-Origin"] == "*"
            payload = await response.json()
            assert payload["status"] == "ok"
            assert payload["bridge"]["history_size"] == 12
            assert payload["qwenpaw"]["agent_id"] == "lensgo-travel-director"
            assert payload["qwenpaw"]["reachable"] is False
            assert payload["telegram"]["configured"] is True
            assert payload["telegram_status"]["configured"] is False

    asyncio.run(run())
