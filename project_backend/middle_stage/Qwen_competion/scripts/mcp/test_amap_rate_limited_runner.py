from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path

import httpx


MODULE_PATH = Path(__file__).with_name("amap_rate_limited_runner.py")
SPEC = importlib.util.spec_from_file_location("amap_rate_limited_runner", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def response(payload: dict[str, str]) -> httpx.Response:
    return httpx.Response(200, json=payload)


class AmapGetRateLimiterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.lock_file = MODULE_PATH.with_name(".test-amap-rate-limit.lock")
        self.lock_file.unlink(missing_ok=True)
        self.addCleanup(self.lock_file.unlink, missing_ok=True)

    async def test_retries_10022_with_configured_backoff(self) -> None:
        replies = [
            response({"status": "0", "infocode": "10022"}),
            response({"status": "0", "infocode": "10022"}),
            response({"status": "1", "infocode": "10000"}),
        ]
        calls = 0

        async def original_get(client, url, *args, **kwargs):
            nonlocal calls
            calls += 1
            return replies.pop(0)

        limiter = MODULE.AmapGetRateLimiter(
            original_get,
            minimum_interval_seconds=0,
            retry_delays=(0, 0, 0),
            lock_file=self.lock_file,
        )
        result = await limiter(None, "https://restapi.amap.com/v3/place/text")

        self.assertEqual(calls, 3)
        self.assertEqual(result.json()["infocode"], "10000")

    async def test_serializes_concurrent_amap_requests(self) -> None:
        active = 0
        maximum_active = 0

        async def original_get(client, url, *args, **kwargs):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            return response({"status": "1", "infocode": "10000"})

        limiter = MODULE.AmapGetRateLimiter(
            original_get,
            minimum_interval_seconds=0,
            retry_delays=(0,),
            lock_file=self.lock_file,
        )
        await asyncio.gather(
            limiter(None, "https://restapi.amap.com/v3/place/text"),
            limiter(None, "https://restapi.amap.com/v3/direction/walking"),
        )

        self.assertEqual(maximum_active, 1)

    async def test_does_not_queue_non_amap_requests(self) -> None:
        calls = 0

        async def original_get(client, url, *args, **kwargs):
            nonlocal calls
            calls += 1
            return response({"ok": "true"})

        limiter = MODULE.AmapGetRateLimiter(
            original_get,
            minimum_interval_seconds=10,
            retry_delays=(1,),
            lock_file=self.lock_file,
        )
        result = await limiter(None, "https://example.com/health")

        self.assertEqual(calls, 1)
        self.assertEqual(result.json()["ok"], "true")


if __name__ == "__main__":
    unittest.main()
