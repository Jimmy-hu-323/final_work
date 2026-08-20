from __future__ import annotations

import asyncio
import base64
import json
from types import SimpleNamespace

from glasses.qwenpaw.sse import _process_sse_response
from glasses.server.data_bridge import EventBridge
from glasses.server.qwenpaw_bridge import handle_generated_media


PNG = b"\x89PNG\r\n\x1a\nminimal-pose-reference"


def test_generated_image_is_saved_and_published(tmp_path) -> None:
    bridge = EventBridge()
    cfg = SimpleNamespace(media_dir=tmp_path, event_bridge=bridge)
    image_url = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")

    asyncio.run(
        handle_generated_media(
            cfg,
            user_id="traveler-1",
            device_id="glasses-1",
            event={"type": "image", "image_url": image_url},
        )
    )

    event = list(bridge._history)[0]
    assert event.direction == "downstream"
    assert event.event_type == "image"
    assert event.data["kind"] == "pose_reference"
    assert event.data["bridge_media_url"].startswith(
        "/api/bridge/media/traveler-1/"
    )
    assert event.media_path is not None
    assert event.media_path.read_bytes() == PNG


def test_remote_or_non_image_content_is_ignored(tmp_path) -> None:
    bridge = EventBridge()
    cfg = SimpleNamespace(media_dir=tmp_path, event_bridge=bridge)

    asyncio.run(
        handle_generated_media(
            cfg,
            user_id="traveler-1",
            device_id="glasses-1",
            event={"type": "image", "image_url": "https://example.invalid/image.png"},
        )
    )
    assert list(bridge._history) == []


def test_workspace_local_image_is_supported(tmp_path, monkeypatch) -> None:
    source = tmp_path / "generated" / "pose.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(PNG)
    monkeypatch.setenv("QWENPAW_WORKING_DIR", str(tmp_path))
    bridge = EventBridge()
    output = tmp_path / "lensgo-media"
    cfg = SimpleNamespace(media_dir=output, event_bridge=bridge)

    asyncio.run(
        handle_generated_media(
            cfg,
            user_id="traveler-1",
            device_id="glasses-1",
            event={"type": "image", "image_url": str(source)},
        )
    )

    event = list(bridge._history)[0]
    assert event.media_path is not None
    assert event.media_path.read_bytes() == PNG


class _FakeContent:
    def __init__(self, events: list[dict[str, object]]) -> None:
        self._payload = b"".join(
            b"data: " + json.dumps(event).encode("utf-8") + b"\n"
            for event in events
        )

    async def iter_chunked(self, _size: int):
        yield self._payload


def test_sse_media_callback_is_deduplicated() -> None:
    image_url = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")
    content_event = {
        "object": "content",
        "type": "image",
        "image_url": image_url,
    }
    response = SimpleNamespace(
        headers={},
        content=_FakeContent(
            [
                content_event,
                content_event,
                {"object": "response", "status": "completed", "output": []},
            ]
        ),
    )
    seen: list[dict[str, object]] = []

    async def consume() -> None:
        async def on_media(event: dict[str, object]) -> None:
            seen.append(event)

        async for _ in _process_sse_response(response, on_media=on_media):
            pass

    asyncio.run(consume())
    assert len(seen) == 1
