import asyncio
from types import SimpleNamespace

from glasses.server.data_bridge import BridgeEvent, EventBridge
from glasses.server.telegram_bridge import TelegramMirror


def test_scchat_chunks_are_coalesced_once():
    mirror = TelegramMirror(bridge=EventBridge(), bot_token="fake", chat_id="1")
    first = BridgeEvent(
        "downstream",
        "SCChat",
        "u1",
        "d1",
        {"askType": 1, "message": "澳门大三巴", "isEnd": False},
    )
    last = BridgeEvent(
        "downstream",
        "SCChat",
        "u1",
        "d1",
        {"askType": 1, "message": "是著名景点。", "isEnd": True},
    )
    assert mirror._coalesce(first) is None
    combined = mirror._coalesce(last)
    assert combined is not None
    assert combined.data["message"] == "澳门大三巴是著名景点。"


def test_identical_event_is_deduplicated_temporarily():
    mirror = TelegramMirror(bridge=EventBridge(), bot_token="fake", chat_id="1")
    event = BridgeEvent("upstream", "text", "u1", "d1", {"content": "你好"})
    assert mirror._is_duplicate(event) is False
    assert mirror._is_duplicate(event) is True


def test_ambassador_hides_internal_status_but_keeps_conversation():
    mirror = TelegramMirror(bridge=EventBridge(), bot_token="fake", chat_id="1")
    route = BridgeEvent("internal", "agent.route", "u1", "d1", {"agent_id": "director"})
    text = BridgeEvent("upstream", "text", "u1", "d1", {"content": "今天真开心"})
    assert mirror._coalesce(route) is None
    assert mirror._coalesce(text) is text


def test_status_mirror_only_keeps_work_events():
    mirror = TelegramMirror(
        bridge=EventBridge(), bot_token="fake", chat_id="1", mirror_kind="status"
    )
    route = BridgeEvent(
        "internal", "agent.route", "u1", "d1",
        {"agent_id": "lensgo-travel-director", "modality": "image", "request_id": "abcdef123"},
    )
    chat = BridgeEvent("downstream", "SCChat", "u1", "d1", {"message": "很好看"})
    assert mirror._coalesce(route) is route
    assert mirror._coalesce(chat) is None
    assert "Router 已派发" in mirror._caption(route)


def test_telegram_text_routes_to_only_online_device():
    async def run():
        calls = []

        async def agent_handler(user_id, device_id, text):
            calls.append((user_id, device_id, text))

        cfg = SimpleNamespace(ws_conns_by_user_device={("u1", "glasses-001"): object()})
        mirror = TelegramMirror(
            bridge=EventBridge(),
            bot_token="fake",
            chat_id="123",
            cfg=cfg,
            interactive=True,
            agent_handler=agent_handler,
        )

        async def fake_api(method, **kwargs):
            return {"ok": True, "result": True}

        mirror._api = fake_api
        await mirror._handle_update(
            {"message": {"chat": {"id": 123}, "text": "请介绍大三巴"}}
        )
        assert calls == [("u1", "glasses-001", "请介绍大三巴")]

    asyncio.run(run())


def test_messages_from_other_chat_are_ignored():
    async def run():
        calls = []

        async def agent_handler(user_id, device_id, text):
            calls.append((user_id, device_id, text))

        cfg = SimpleNamespace(ws_conns_by_user_device={("u1", "d1"): object()})
        mirror = TelegramMirror(
            bridge=EventBridge(),
            bot_token="fake",
            chat_id="123",
            cfg=cfg,
            interactive=True,
            agent_handler=agent_handler,
        )
        await mirror._handle_update({"message": {"chat": {"id": 999}, "text": "非法输入"}})
        assert calls == []

    asyncio.run(run())


def test_telegram_photo_routes_largest_variant_with_caption():
    async def run():
        calls = []

        async def agent_handler(user_id, device_id, text):
            raise AssertionError("text handler should not be called")

        async def photo_handler(user_id, device_id, data, filename, caption):
            calls.append((user_id, device_id, data, filename, caption))

        cfg = SimpleNamespace(ws_conns_by_user_device={("u1", "d1"): object()})
        mirror = TelegramMirror(
            bridge=EventBridge(), bot_token="fake", chat_id="123", cfg=cfg,
            interactive=True, agent_handler=agent_handler, photo_handler=photo_handler,
        )

        async def fake_api(method, **kwargs):
            if method == "getFile":
                assert kwargs["json"]["file_id"] == "large"
                return {"ok": True, "result": {"file_path": "photos/picture.jpg"}}
            return {"ok": True, "result": True}

        async def fake_download(path):
            assert path == "photos/picture.jpg"
            return b"jpeg-data", "image/jpeg"

        mirror._api = fake_api
        mirror._download_file = fake_download
        await mirror._handle_update({"message": {
            "chat": {"id": 123}, "caption": "这一刻值得记住",
            "photo": [{"file_id": "small"}, {"file_id": "large"}],
        }})
        assert calls == [("u1", "d1", b"jpeg-data", "picture.jpg", "这一刻值得记住")]

    asyncio.run(run())
