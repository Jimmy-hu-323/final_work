import asyncio
import json

import websockets


async def main() -> None:
    uri = "ws://127.0.0.1:8000/ws/v1/glasses/glasses-001"
    async with websockets.connect(uri) as socket:
        print(await socket.recv())
        await socket.send(json.dumps({
            "type": "frame.metadata",
            "content_type": "image/jpeg",
            "language": "zh-Hant",
            "location": {"latitude": 22.1932, "longitude": 113.5380},
        }))
        print(await socket.recv())
        await socket.send(b"LensGo safe WebSocket test frame")
        print(await socket.recv())


if __name__ == "__main__":
    asyncio.run(main())
