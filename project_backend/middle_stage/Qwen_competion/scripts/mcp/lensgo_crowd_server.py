#!/usr/bin/env python3
"""Read-only MCP adapter for the LensGo crowd data publisher."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP


DEFAULT_BASE_URL = "http://127.0.0.1:18099"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024

mcp = FastMCP("LensGo Crowd")


def _base_url() -> str:
    return os.environ.get("LENSGO_CROWD_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")


def _timeout() -> float:
    raw = os.environ.get("LENSGO_CROWD_TIMEOUT_SECONDS", "8").strip()
    try:
        return min(max(float(raw), 1.0), 30.0)
    except ValueError:
        return 8.0


def _stale_minutes() -> float:
    raw = os.environ.get("LENSGO_CROWD_STALE_MINUTES", "30").strip()
    try:
        return min(max(float(raw), 1.0), 1440.0)
    except ValueError:
        return 30.0


def _get_json(path: str, query: dict[str, str]) -> dict[str, Any]:
    url = f"{_base_url()}{path}?{urlencode(query)}"
    headers = {"Accept": "application/json"}
    # New deployments issue a scoped API key per machine.  Keep the old
    # variable as an explicit migration fallback so existing local installs do
    # not break before their key has been rotated.
    token = (
        os.environ.get("LENSGO_CROWD_API_KEY", "").strip()
        or os.environ.get("LENSGO_CROWD_READ_TOKEN", "").strip()
    )
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=_timeout()) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise RuntimeError(f"人流服务返回 HTTP {error.code}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError("暂时无法连接 LensGo 人流服务") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("人流服务响应过大")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("人流服务返回了无效 JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("人流服务响应格式错误")
    return payload


def _items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items = payload.get("items", [])
    if not isinstance(raw_items, list):
        return []
    return [item for item in raw_items if isinstance(item, dict)]


def _annotate_item(item: dict[str, Any]) -> dict[str, Any]:
    result = dict(item)
    reading = item.get("reading")
    if not isinstance(reading, dict):
        result["data_status"] = "no_reading"
        return result
    reading_copy = dict(reading)
    observed_at = str(reading_copy.get("observed_at") or "").strip()
    try:
        observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        if observed.tzinfo is None:
            observed = observed.replace(tzinfo=timezone.utc)
        age_minutes = max(
            0.0,
            (datetime.now(timezone.utc) - observed.astimezone(timezone.utc)).total_seconds() / 60,
        )
        reading_copy["age_minutes"] = round(age_minutes, 1)
        reading_copy["is_stale"] = age_minutes > _stale_minutes()
        result["data_status"] = "stale" if reading_copy["is_stale"] else "current"
    except ValueError:
        reading_copy["is_stale"] = True
        result["data_status"] = "invalid_timestamp"
    result["reading"] = reading_copy
    return result


@mcp.tool()
def lensgo_latest_crowd(city_id: str = "macau") -> dict[str, Any]:
    """查询城市内全部景点的最新人流，仅用于只读行程判断与重排。"""

    payload = _get_json(
        "/api/density/latest",
        {"city_id": city_id.strip() or "macau", "level": "poi", "include_empty": "1"},
    )
    items = [_annotate_item(item) for item in _items(payload)]
    return {
        "city_id": city_id.strip() or "macau",
        "count": len(items),
        "current_count": sum(item.get("data_status") == "current" for item in items),
        "stale_after_minutes": _stale_minutes(),
        "warning": "data_status 不是 current 时，不能把人数称为实时或当前人数。",
        "items": items,
    }


@mcp.tool()
def lensgo_place_crowd(query: str, city_id: str = "macau") -> dict[str, Any]:
    """按景点名称或 region_id 查询最新人流；找不到时返回空列表。"""

    needle = query.strip().casefold()
    if not needle:
        return {"query": query, "count": 0, "items": []}
    payload = lensgo_latest_crowd(city_id)
    matches: list[dict[str, Any]] = []
    for item in payload["items"]:
        fields = (
            item.get("region_id"),
            item.get("name"),
            item.get("display_name"),
            item.get("name_en"),
        )
        if any(needle in str(value or "").casefold() for value in fields):
            matches.append(item)
    return {
        "query": query,
        "city_id": city_id,
        "count": len(matches),
        "warning": "只可将 data_status=current 的读数称为实时人数。",
        "items": matches[:20],
    }


if __name__ == "__main__":
    mcp.run()
