#!/usr/bin/env python3
"""MCP adapter that lets the travel director price and record a trip.

Everything goes through QwenPaw's `/api/travel-planner` proxy rather than the
hotel service directly, so the service credential stays on the server side and
the agent only ever sees traveller-facing data.
"""

from __future__ import annotations

import json
import os
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP


DEFAULT_BASE_URL = "http://127.0.0.1:18088"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024

mcp = FastMCP("LensGo Booking")


def _base_url() -> str:
    return os.environ.get("LENSGO_BOOKING_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")


def _timeout() -> float:
    raw = os.environ.get("LENSGO_BOOKING_TIMEOUT_SECONDS", "20").strip()
    try:
        return min(max(float(raw), 1.0), 60.0)
    except ValueError:
        return 20.0


def _call(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{_base_url()}/api/travel-planner{path}"
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=_timeout()) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        detail = ""
        try:
            detail = json.loads(error.read().decode("utf-8")).get("detail", "")
        except Exception:  # noqa: BLE001 - the error body is best-effort context
            pass
        raise RuntimeError(f"预订服务返回 HTTP {error.code}{f'：{detail}' if detail else ''}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError("暂时无法连接 LensGo 预订与账单服务") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("预订服务响应过大")
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError("预订服务返回了无法解析的数据") from error


def _yuan(cents: Any) -> float:
    return round(int(cents or 0) / 100, 2)


@mcp.tool()
def search_macau_hotels(check_in: str, check_out: str) -> dict[str, Any]:
    """List bookable Macau hotels and the total price for the whole stay.

    Args:
        check_in: Check-in date, `YYYY-MM-DD`.
        check_out: Check-out date, `YYYY-MM-DD`. Must be after check_in.

    Returns each hotel with `total_cny` for the whole stay and `per_night_cny`,
    so a budget can be checked before anything is committed.
    """
    payload = _call("GET", f"/hotels?{urlencode({'check_in': check_in, 'check_out': check_out})}")
    rows = payload.get("data") or payload.get("hotels") or []
    nights = max(1, (date.fromisoformat(check_out) - date.fromisoformat(check_in)).days)
    hotels = []
    for row in rows:
        total = int(row.get("price") or 0)
        hotels.append(
            {
                "hotel_id": row.get("id"),
                "name": row.get("name"),
                "area": row.get("area"),
                "address": row.get("address"),
                "stars": row.get("stars"),
                "rating": row.get("rating"),
                "room_name": row.get("roomName"),
                "total_cny": _yuan(total),
                "per_night_cny": _yuan(total // nights),
                "available_rooms": row.get("availableRooms"),
                "latitude": row.get("latitude"),
                "longitude": row.get("longitude"),
                "highlights": row.get("amenities"),
                "description": row.get("description"),
            }
        )
    return {"check_in": check_in, "check_out": check_out, "nights": nights, "hotels": hotels}


@mcp.tool()
def list_macau_attractions() -> dict[str, Any]:
    """Published Macau admission prices, including the free sights.

    Use this to cost an itinerary honestly: a day made of free sights should be
    reported as costing nothing rather than guessed at.
    """
    payload = _call("GET", "/attractions")
    return {
        "attractions": [
            {
                "poi_id": row.get("id"),
                "name": row.get("name"),
                "area": row.get("area"),
                "category": row.get("category"),
                "ticket_cny": _yuan(row.get("ticket_amount")),
                "free": int(row.get("ticket_amount") or 0) == 0,
                "latitude": row.get("latitude"),
                "longitude": row.get("longitude"),
                "note": row.get("note"),
            }
            for row in payload.get("attractions", [])
        ]
    }


@mcp.tool()
def save_trip_expenses(trip_id: str, expenses: list[dict[str, Any]]) -> dict[str, Any]:
    """Record what a planned itinerary will cost, one line item per spend.

    Each entry accepts: `title` (required), `amount_cny` (required, per unit),
    `category` (hotel/ticket/transport/meal/other), `place_name`, `latitude`,
    `longitude`, `day`, `quantity`, `required` (false marks it optional) and
    `note`. The traveller sees these in 账单 and can edit or delete any of them.
    """
    items = []
    for entry in expenses or []:
        title = str(entry.get("title") or "").strip()
        if not title:
            continue
        amount = entry.get("amount_cny", entry.get("amount"))
        items.append(
            {
                "trip_id": trip_id,
                "title": title,
                "category": entry.get("category") or "other",
                "place_name": entry.get("place_name") or "",
                "latitude": entry.get("latitude"),
                "longitude": entry.get("longitude"),
                "day": entry.get("day"),
                "unit_amount": int(round(float(amount or 0) * 100)),
                "quantity": int(entry.get("quantity") or 1),
                "required": entry.get("required", True),
                "note": entry.get("note") or "",
                "source": "agent",
            }
        )
    if not items:
        raise RuntimeError("没有可保存的费用项")
    payload = _call("POST", "/trip-expenses", {"trip_id": trip_id, "expenses": items})
    summary = payload.get("summary") or {}
    return {
        "saved": len(payload.get("created") or []),
        "total_cny": _yuan(summary.get("total")),
        "required_cny": _yuan(summary.get("required_total")),
        "optional_cny": _yuan(summary.get("optional_total")),
    }


@mcp.tool()
def list_trip_expenses(trip_id: str = "") -> dict[str, Any]:
    """Read back the traveller's current cost list and its total.

    The traveller may have edited or deleted items in 账单, so read this before
    quoting a total back to them.
    """
    suffix = f"/trip-expenses?{urlencode({'trip_id': trip_id})}" if trip_id else "/trip-expenses"
    payload = _call("GET", suffix)
    summary = payload.get("summary") or {}
    return {
        "expenses": [
            {
                "id": row.get("id"),
                "title": row.get("title"),
                "category": row.get("category"),
                "place_name": row.get("place_name"),
                "day": row.get("day"),
                "quantity": row.get("quantity"),
                "amount_cny": _yuan(row.get("amount")),
                "required": row.get("required"),
            }
            for row in payload.get("expenses", [])
        ],
        "total_cny": _yuan(summary.get("total")),
        "required_cny": _yuan(summary.get("required_total")),
        "optional_cny": _yuan(summary.get("optional_total")),
    }


if __name__ == "__main__":
    mcp.run()
