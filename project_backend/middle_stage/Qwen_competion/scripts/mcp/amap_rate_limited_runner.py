"""Run the AMap MCP server behind a process-wide and host-wide request queue.

The existing AMap MCP implementation is kept unchanged.  This runner patches
``httpx.AsyncClient.get`` before loading it so every request to AMap is sent one
at a time, with a small gap between requests and bounded retries for infocode
10022.  A file lock coordinates separate MCP processes on the same host.
"""

from __future__ import annotations

import asyncio
import os
import runpy
import tempfile
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows uses the in-process lock.
    fcntl = None  # type: ignore[assignment]


DEFAULT_AMAP_SERVER_PATH = Path("/home/jimmyhu/Desktop/amap-mcp/server.py")
DEFAULT_LOCK_FILE = Path(tempfile.gettempdir()) / "lensgo-amap-request.lock"
AMAP_HOST = "restapi.amap.com"


def _positive_float(value: str, default: float) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return default


def _retry_delays(value: str) -> tuple[float, ...]:
    delays: list[float] = []
    for item in value.split(","):
        item = item.strip()
        if item:
            delays.append(_positive_float(item, 0.0))
    return tuple(delays) or (1.0, 2.0, 4.0)


def _is_amap_request(url: object) -> bool:
    try:
        return httpx.URL(str(url)).host == AMAP_HOST
    except (TypeError, ValueError):
        return False


def _is_infocode_10022(response: httpx.Response) -> bool:
    try:
        payload: Any = response.json()
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    return str(payload.get("infocode") or "") == "10022"


class AmapGetRateLimiter:
    """Serialize AMap GETs and retry the host/key/service QPS error."""

    def __init__(
        self,
        original_get: Callable[..., Awaitable[httpx.Response]],
        *,
        minimum_interval_seconds: float,
        retry_delays: tuple[float, ...],
        lock_file: Path,
    ) -> None:
        self._original_get = original_get
        self._minimum_interval_seconds = max(0.0, minimum_interval_seconds)
        self._retry_delays = retry_delays
        self._lock_file = lock_file
        self._process_lock = asyncio.Lock()
        self._last_completed_monotonic = 0.0

    def _acquire_host_lock(self):
        if fcntl is None:
            return None
        self._lock_file.parent.mkdir(parents=True, exist_ok=True)
        handle = self._lock_file.open("a+", encoding="utf-8")
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        return handle

    @staticmethod
    def _release_host_lock(handle) -> None:
        if handle is None or fcntl is None:
            return
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    async def _wait_for_interval(self, handle) -> None:
        if handle is None:
            elapsed = time.monotonic() - self._last_completed_monotonic
        else:
            handle.seek(0)
            raw_value = handle.read().strip()
            try:
                previous = float(raw_value)
            except ValueError:
                previous = 0.0
            elapsed = time.time() - previous
        remaining = self._minimum_interval_seconds - elapsed
        if remaining > 0:
            await asyncio.sleep(remaining)

    def _record_completion(self, handle) -> None:
        self._last_completed_monotonic = time.monotonic()
        if handle is None:
            return
        handle.seek(0)
        handle.truncate()
        handle.write(str(time.time()))
        handle.flush()

    async def __call__(
        self,
        client: httpx.AsyncClient,
        url: object,
        *args: Any,
        **kwargs: Any,
    ) -> httpx.Response:
        if not _is_amap_request(url):
            return await self._original_get(client, url, *args, **kwargs)

        async with self._process_lock:
            handle = await asyncio.to_thread(self._acquire_host_lock)
            try:
                for attempt in range(len(self._retry_delays) + 1):
                    await self._wait_for_interval(handle)
                    try:
                        response = await self._original_get(
                            client, url, *args, **kwargs
                        )
                    finally:
                        self._record_completion(handle)
                    if not _is_infocode_10022(response):
                        return response
                    if attempt < len(self._retry_delays):
                        await asyncio.sleep(self._retry_delays[attempt])
                return response
            finally:
                await asyncio.to_thread(self._release_host_lock, handle)


def main() -> None:
    server_path = Path(
        os.getenv("AMAP_SERVER_PATH", str(DEFAULT_AMAP_SERVER_PATH))
    ).expanduser()
    if not server_path.is_file():
        raise SystemExit(f"AMap MCP server does not exist: {server_path}")

    original_get = httpx.AsyncClient.get
    limiter = AmapGetRateLimiter(
        original_get,
        minimum_interval_seconds=_positive_float(
            os.getenv("AMAP_MIN_REQUEST_INTERVAL_SECONDS", "0.5"), 0.5
        ),
        retry_delays=_retry_delays(
            os.getenv("AMAP_RATE_LIMIT_RETRY_DELAYS", "1,2,4")
        ),
        lock_file=Path(
            os.getenv("AMAP_REQUEST_LOCK_FILE", str(DEFAULT_LOCK_FILE))
        ).expanduser(),
    )

    async def limited_get(
        client: httpx.AsyncClient,
        url: object,
        *args: Any,
        **kwargs: Any,
    ) -> httpx.Response:
        return await limiter(client, url, *args, **kwargs)

    httpx.AsyncClient.get = limited_get  # type: ignore[method-assign]
    try:
        runpy.run_path(str(server_path), run_name="__main__")
    finally:
        httpx.AsyncClient.get = original_get  # type: ignore[method-assign]


if __name__ == "__main__":
    main()
