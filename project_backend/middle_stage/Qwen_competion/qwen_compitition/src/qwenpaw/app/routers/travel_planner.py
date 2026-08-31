# -*- coding: utf-8 -*-
"""Read-only data endpoint for the local travel-planner console page."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import threading
import time
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote
from urllib.parse import urlencode
from urllib.request import urlopen

import httpx
from fastapi import APIRouter, Body, File, HTTPException, Query, UploadFile
from fastapi.responses import Response

from qwenpaw.constant import WORKING_DIR

router = APIRouter(prefix="/travel-planner", tags=["travel-planner"])

AI_DRIVE_BASE_URL = os.getenv("AI_DRIVE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
AI_DRIVE_TOKEN = os.getenv("AI_DRIVE_TOKEN", "").strip()
AI_DRIVE_TIMEOUT_SECONDS = float(os.getenv("AI_DRIVE_TIMEOUT_SECONDS", "30"))
HOTEL_BOOKING_BASE_URL = os.getenv(
    "HOTEL_BOOKING_BASE_URL", "http://127.0.0.1:18110"
).rstrip("/")
HOTEL_BOOKING_SERVICE_TOKEN = os.getenv(
    "HOTEL_BOOKING_SERVICE_TOKEN", ""
).strip()
HOTEL_BOOKING_ENV_FILE = os.getenv(
    "HOTEL_BOOKING_ENV_FILE",
    "/home/jimmyhu/qwenpaw_competition/middle_stage/hotel_book/.dev.vars",
)
MAX_ALBUM_UPLOAD_BYTES = 20 * 1024 * 1024

# AMap directions: used to draw the *real* road route between stops. The key
# stays server-side; the browser only ever receives decoded polyline points.
AMAP_ENV_FILE = os.getenv(
    "AMAP_ENV_FILE", "/home/jimmyhu/Desktop/amap-mcp/.env"
)
AMAP_DIRECTION_BASE = "https://restapi.amap.com/v3/direction"
_COORD_RE = re.compile(r"^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$")
_ROUTE_MODES = {"driving", "walking"}
_route_cache_lock = threading.Lock()
_local_album_lock = threading.Lock()


@lru_cache(maxsize=1)
def _amap_key() -> str:
    """Resolve the AMap web-service key from env, then the local .env file."""
    key = os.getenv("AMAP_WEB_SERVICE_KEY", "").strip()
    if key:
        return key
    try:
        for line in Path(AMAP_ENV_FILE).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("AMAP_WEB_SERVICE_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return ""


@lru_cache(maxsize=1)
def _hotel_booking_token() -> str:
    """Resolve the private hotel service token without exposing it to clients."""
    if HOTEL_BOOKING_SERVICE_TOKEN:
        return HOTEL_BOOKING_SERVICE_TOKEN
    try:
        for line in Path(HOTEL_BOOKING_ENV_FILE).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("HOTEL_BOOKING_SERVICE_TOKEN="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return ""


def _route_cache_path() -> Path:
    return _snapshot_path().parent / "route-cache.json"


def _load_route_cache() -> dict:
    try:
        return json.loads(_route_cache_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_route_cache(cache: dict) -> None:
    path = _route_cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(cache, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def _decode_polyline(payload: dict) -> list[list[float]]:
    """Concatenate every step polyline into an ordered [[lat, lng], ...] list."""
    paths = (payload.get("route") or {}).get("paths") or []
    if not paths:
        return []
    points: list[list[float]] = []
    for step in paths[0].get("steps") or []:
        polyline = step.get("polyline")
        if not isinstance(polyline, str):
            continue
        for pair in polyline.split(";"):
            if not pair:
                continue
            lng_str, _, lat_str = pair.partition(",")
            try:
                lng, lat = float(lng_str), float(lat_str)
            except ValueError:
                continue
            # AMap returns GCJ-02 lng,lat; the console draws [lat, lng].
            if not points or points[-1] != [lat, lng]:
                points.append([lat, lng])
    return points


def _snapshot_path() -> Path:
    """Location shared with the bundled AMap MCP configuration."""
    return (
        WORKING_DIR
        / "workspaces"
        / "default"
        / "media"
        / "travel_maps"
        / "latest-itinerary.json"
    )


def _local_album_dir() -> Path:
    """Private QwenPaw fallback used when a separate AI Drive is unavailable."""
    return WORKING_DIR / "lensgo-cloud-album"


def _local_album_index_path() -> Path:
    return _local_album_dir() / "index.json"


def _load_local_album() -> list[dict]:
    try:
        payload = json.loads(_local_album_index_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return payload if isinstance(payload, list) else []


def _save_local_album(items: list[dict]) -> None:
    directory = _local_album_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = _local_album_index_path()
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(items, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def _local_album_item(file_id: int) -> dict | None:
    with _local_album_lock:
        return next(
            (
                item
                for item in _load_local_album()
                if item.get("file_id") == file_id
            ),
            None,
        )


def _store_local_album_photo(
    filename: str,
    content_type: str,
    content: bytes,
) -> int:
    safe_suffix = Path(filename).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", safe_suffix):
        safe_suffix = ".img"
    with _local_album_lock:
        items = _load_local_album()
        existing_ids = {
            int(item["file_id"])
            for item in items
            if isinstance(item.get("file_id"), int)
        }
        file_id = time.time_ns() // 1_000_000
        while file_id in existing_ids:
            file_id += 1
        directory = _local_album_dir()
        directory.mkdir(parents=True, exist_ok=True)
        storage_name = f"{file_id}{safe_suffix}"
        (directory / storage_name).write_bytes(content)
        items.append(
            {
                "file_id": file_id,
                "filename": filename,
                "display_name": filename,
                "content_type": content_type,
                "size_bytes": len(content),
                "created_at": int(time.time()),
                "storage_name": storage_name,
                "source": "qwenpaw-local-fallback",
            }
        )
        _save_local_album(items)
    return file_id


def _delete_local_album_photo(file_id: int) -> bool:
    with _local_album_lock:
        items = _load_local_album()
        target = next(
            (item for item in items if item.get("file_id") == file_id),
            None,
        )
        if target is None:
            return False
        storage_name = target.get("storage_name")
        if isinstance(storage_name, str):
            path = (_local_album_dir() / storage_name).resolve()
            try:
                path.relative_to(_local_album_dir().resolve())
                path.unlink(missing_ok=True)
            except (OSError, ValueError):
                pass
        _save_local_album(
            [item for item in items if item.get("file_id") != file_id]
        )
    return True


def _preview_path(value: object, media_dir: Path) -> str:
    """Return a safe API-relative preview URL for a generated route map."""
    if not isinstance(value, str) or not value.strip():
        return ""
    path = Path(value).resolve()
    try:
        path.relative_to(media_dir)
    except ValueError:
        return ""
    if not path.is_file():
        return ""
    return f"/files/preview/{quote(str(path), safe='')}"


@router.get("/latest")
async def get_latest_itinerary() -> dict:
    """Return the newest AMap MCP itinerary without exposing local paths."""
    snapshot = _snapshot_path()
    if not snapshot.is_file():
        raise HTTPException(
            status_code=404,
            detail="尚未生成行程。请先在聊天中确认并生成旅行计划。",
        )
    try:
        payload = json.loads(snapshot.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="行程数据暂时不可读取，请稍后刷新。") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("days"), list):
        raise HTTPException(status_code=503, detail="行程数据格式无效，请重新生成。")

    media_dir = snapshot.parent.resolve()
    days: list[dict] = []
    for day in payload["days"]:
        if not isinstance(day, dict):
            continue
        clean_day = {key: value for key, value in day.items() if key != "map_file_path"}
        clean_day["map_preview_path"] = _preview_path(
            day.get("map_file_path"), media_dir
        )
        days.append(clean_day)

    return {
        "title": str(payload.get("title") or "旅行行程"),
        "destination": str(payload.get("destination") or ""),
        "day_count": len(days),
        "transportation": str(payload.get("transportation") or ""),
        "updated_at": str(payload.get("updated_at") or ""),
        "days": days,
    }


async def _hotel_service_call(
    method: str,
    path: str,
    *,
    payload: dict | None = None,
) -> dict:
    """Call the private hotel-booking service on behalf of the phone user.

    The service credential stays on this server and is never included in the
    Android bundle or browser response. The hotel service treats a
    service-authenticated request that carries no agent actor header as the
    *user* acting, which is exactly what the phone's 账单 page needs: only the
    person holding the phone can grant payment authority, pay a bill, or
    confirm a bill adjustment.
    """
    service_token = _hotel_booking_token()
    if not service_token:
        raise HTTPException(
            status_code=503,
            detail="酒店账单服务尚未配置。",
        )
    try:
        async with httpx.AsyncClient(timeout=AI_DRIVE_TIMEOUT_SECONDS) as client:
            response = await client.request(
                method,
                f"{HOTEL_BOOKING_BASE_URL}{path}",
                headers={
                    "Authorization": f"Bearer {service_token}",
                    "Accept": "application/json",
                },
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail="无法连接酒店账单服务，请稍后重试。",
        ) from exc
    if response.status_code == 401:
        raise HTTPException(
            status_code=502,
            detail="酒店账单服务鉴权失败，请检查服务器配置。",
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="酒店账单数据格式无效。") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="酒店账单数据格式无效。")
    if response.is_error:
        # Pass the service's own wording through so the phone can explain *why*
        # an authorization, payment or adjustment was rejected (expired quote,
        # changed amount, bill already paid …) instead of a generic failure.
        error = body.get("error")
        detail = "酒店账单服务暂时不可用。"
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            detail = error["message"].strip() or detail
        status_code = (
            response.status_code
            if response.status_code in {400, 403, 404, 409}
            else 502
        )
        raise HTTPException(status_code=status_code, detail=detail)
    return body


@router.get("/hotel/state")
async def get_hotel_bill_state() -> dict:
    """Return hotel bills, AI payment authorizations and the activity log."""
    payload = await _hotel_service_call("GET", "/api/v1/state")
    if not isinstance(payload.get("bills"), list):
        raise HTTPException(status_code=502, detail="酒店账单数据格式无效。")
    return payload


@router.post("/hotel/payment-authorizations")
async def decide_hotel_payment_authorization(payload: dict = Body(...)) -> dict:
    """Grant or revoke a one-off AI payment authorization from the phone.

    Granting is deliberately reachable only from the user's own device: the
    hotel service refuses the same call when the caller identifies as an agent.
    """
    action = str(payload.get("action") or "").strip()
    authorization_id = str(
        payload.get("authorizationId") or payload.get("authorization_id") or ""
    ).strip()
    if action not in {"grant", "revoke"} or not authorization_id:
        raise HTTPException(status_code=400, detail="请选择要授予或撤销的付款授权。")
    return await _hotel_service_call(
        "POST",
        "/api/v1/payment-authorizations",
        payload={"action": action, "authorization_id": authorization_id},
    )


@router.post("/hotel/payments")
async def pay_hotel_bills(payload: dict = Body(...)) -> dict:
    """Pay the selected bills as the user (simulated payment)."""
    raw = payload.get("billIds") or payload.get("bill_ids") or []
    bill_ids = (
        [str(item).strip() for item in raw if str(item).strip()]
        if isinstance(raw, list)
        else []
    )
    if not bill_ids:
        raise HTTPException(status_code=400, detail="请选择需要支付的账单。")
    return await _hotel_service_call(
        "POST",
        "/api/v1/payment-sessions",
        payload={"bill_ids": bill_ids, "actor": "user"},
    )


@router.post("/hotel/bills/{bill_id}/adjustments/preview")
async def preview_hotel_bill_adjustment(
    bill_id: str,
    payload: dict | None = Body(default=None),
) -> dict:
    """Re-quote a pending bill so the phone can show the price delta first."""
    return await _hotel_service_call(
        "POST",
        f"/api/v1/bills/{quote(bill_id, safe='')}/adjustments/preview",
        payload={"breakfast": bool((payload or {}).get("breakfast"))},
    )


@router.post("/hotel/bills/{bill_id}/adjustments/confirm")
async def confirm_hotel_bill_adjustment(
    bill_id: str,
    payload: dict = Body(...),
) -> dict:
    """Apply a previously previewed adjustment after the user confirms it."""
    preview_id = str(
        payload.get("previewId") or payload.get("preview_id") or ""
    ).strip()
    if not preview_id:
        raise HTTPException(status_code=400, detail="请先预览账单调整。")
    return await _hotel_service_call(
        "POST",
        f"/api/v1/bills/{quote(bill_id, safe='')}/adjustments/confirm",
        payload={"preview_id": preview_id},
    )


@router.get("/attractions")
async def list_macau_attractions() -> dict:
    """Published Macau admission prices the planner costs an itinerary against."""
    return await _hotel_service_call("GET", "/api/v1/attractions")


@router.get("/hotels")
async def search_trip_hotels(
    check_in: str = Query(..., min_length=10, max_length=10),
    check_out: str = Query(..., min_length=10, max_length=10),
) -> dict:
    """Bookable Macau hotels with the total for the requested stay."""
    return await _hotel_service_call(
        "GET",
        f"/api/v1/hotels/search?check_in={quote(check_in, safe='')}"
        f"&check_out={quote(check_out, safe='')}",
    )


@router.get("/trip-expenses")
async def list_trip_expenses(trip_id: str = Query(default="")) -> dict:
    """Every cost the itinerary commits the traveller to, plus its total."""
    suffix = "/api/v1/trip-expenses"
    if trip_id.strip():
        suffix = f"{suffix}?trip_id={quote(trip_id.strip(), safe='')}"
    return await _hotel_service_call("GET", suffix)


@router.post("/trip-expenses", status_code=201)
async def create_trip_expenses(payload: dict = Body(...)) -> dict:
    """Add one line item, or a whole itinerary's worth via `expenses`.

    The planner posts the batch it just costed; the phone posts single items the
    traveller adds by hand.
    """
    single = isinstance(payload.get("expenses"), list) is False
    if single and not str(payload.get("title") or "").strip():
        raise HTTPException(status_code=400, detail="费用项需要名称。")
    return await _hotel_service_call("POST", "/api/v1/trip-expenses", payload=payload)


@router.delete("/trip-expenses")
async def delete_trip_expenses(trip_id: str = Query(...)) -> dict:
    """Remove all bill lines associated with one deleted itinerary."""
    normalized = trip_id.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="请选择需要删除的行程。")
    return await _hotel_service_call(
        "DELETE",
        f"/api/v1/trip-expenses?trip_id={quote(normalized, safe='')}",
    )


@router.patch("/trip-expenses/{expense_id}")
async def update_trip_expense(expense_id: str, payload: dict = Body(...)) -> dict:
    """Edit a line item. Only the keys the caller sends are changed."""
    if not payload:
        raise HTTPException(status_code=400, detail="没有需要修改的内容。")
    return await _hotel_service_call(
        "PATCH",
        f"/api/v1/trip-expenses/{quote(expense_id, safe='')}",
        payload=payload,
    )


@router.delete("/trip-expenses/{expense_id}")
async def delete_trip_expense(expense_id: str) -> dict:
    """Remove a line item the traveller does not want counted."""
    return await _hotel_service_call(
        "DELETE",
        f"/api/v1/trip-expenses/{quote(expense_id, safe='')}",
    )


@router.get("/route")
async def get_route(
    origin: str = Query(..., description="起点 lng,lat (GCJ-02)"),
    destination: str = Query(..., description="终点 lng,lat (GCJ-02)"),
    mode: str = Query("driving"),
) -> dict:
    """Return the real road-route polyline between two stops (server-side key).

    Results are cached on disk keyed by mode+origin+destination so repeated
    views of the itinerary don't spend AMap quota.
    """
    mode = mode if mode in _ROUTE_MODES else "driving"
    if not (_COORD_RE.match(origin) and _COORD_RE.match(destination)):
        raise HTTPException(status_code=400, detail="坐标格式无效。")

    cache_key = f"{mode}:{origin}:{destination}"
    with _route_cache_lock:
        cache = _load_route_cache()
        cached = cache.get(cache_key)
    if isinstance(cached, list):
        return {"points": cached, "mode": mode, "cached": True}

    key = _amap_key()
    if not key:
        # No key configured: let the console fall back to a straight segment.
        return {"points": [], "mode": mode, "cached": False}

    try:
        async with httpx.AsyncClient(timeout=AI_DRIVE_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{AMAP_DIRECTION_BASE}/{mode}",
                params={
                    "origin": origin,
                    "destination": destination,
                    "output": "json",
                    "key": key,
                },
            )
    except httpx.HTTPError:
        return {"points": [], "mode": mode, "cached": False}

    if response.is_error:
        return {"points": [], "mode": mode, "cached": False}
    try:
        payload = response.json()
    except ValueError:
        return {"points": [], "mode": mode, "cached": False}
    if str(payload.get("status")) != "1":
        return {"points": [], "mode": mode, "cached": False}

    points = _decode_polyline(payload)
    if points:
        with _route_cache_lock:
            cache = _load_route_cache()
            cache[cache_key] = points
            _save_route_cache(cache)
    return {"points": points, "mode": mode, "cached": False}


def _guide_amap_key() -> str:
    """Reuse the authorized crowd map credential for this guide endpoint only.

    Do not import crowd configuration: that would populate this process with
    unrelated secrets. Read only its two map-key fields, without modifying the
    file, os.environ, the existing route key resolver, or the crowd service.
    """
    configured = _amap_key()
    if configured:
        return configured
    names = ("AMAP_WEB_KEY", "AMAP_KEY")
    values = {name: os.environ[name] for name in names if name in os.environ}
    project_root = Path(__file__).resolve().parents[5]
    configured_root = os.getenv("LENSGO_CROWD_PROJECT_ROOT", "").strip()
    crowd_root = Path(configured_root).expanduser() if configured_root else project_root.parent / "data_publish"
    if not crowd_root.is_absolute():
        crowd_root = project_root / crowd_root
    try:
        with (crowd_root / ".env").open(encoding="utf-8-sig") as source:
            for raw in source:
                name, separator, value = raw.strip().partition("=")
                name = name.strip()
                if separator and name in names:
                    values.setdefault(name, value.strip().strip('"').strip("'"))
    except (OSError, UnicodeError):
        pass
    return values.get("AMAP_WEB_KEY", values.get("AMAP_KEY", "")).strip()


def _guide_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (ValueError, TypeError):
        return None
    return result if math.isfinite(result) else None


def _guide_places(payload: dict, radius: int) -> list[dict]:
    """Normalize real POIs; absent ratings must never become invented scores."""
    items: list[dict] = []
    seen: set[str] = set()
    for poi in payload.get("pois", []) if isinstance(payload.get("pois"), list) else []:
        if not isinstance(poi, dict):
            continue
        location = str(poi.get("location", "")).split(",")
        if len(location) != 2:
            continue
        lng, lat = (_guide_number(part) for part in location)
        distance = _guide_number(poi.get("distance"))
        if (lng is None or lat is None or not -180 <= lng <= 180 or not -90 <= lat <= 90
                or distance is None or not 0 <= distance <= radius):
            continue
        name = poi.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        poi_id = str(poi.get("id") or f"{name}:{lng}:{lat}")
        if poi_id in seen:
            continue
        seen.add(poi_id)
        biz = poi.get("biz_ext") if isinstance(poi.get("biz_ext"), dict) else {}
        rating = _guide_number(biz.get("rating"))
        if rating is not None and not 0 < rating <= 5:
            rating = None
        items.append({
            "id": poi_id, "name": name[:200],
            "address": poi.get("address", "") if isinstance(poi.get("address"), str) else "",
            "category": poi.get("type", "") if isinstance(poi.get("type"), str) else "",
            "latitude": lat, "longitude": lng, "distance": distance, "rating": rating,
        })
    items.sort(key=lambda item: (item["rating"] is None, -(item["rating"] or 0), item["distance"]))
    return items[:5]


def _fetch_guide_pois(key: str, latitude: float, longitude: float, kind: str, radius: int) -> dict:
    # AMap's documented v3 around endpoint returns ratings with extensions=all:
    # https://lbs.amap.com/api/webservice/guide/api/search/
    # urllib avoids HTTP client's INFO URL logging of the query-string secret.
    query = urlencode({
        "key": key, "location": f"{longitude:.6f},{latitude:.6f}",
        "types": "050000" if kind == "food" else "110000",
        "radius": radius, "extensions": "all", "sortrule": "weight",
        "offset": 25, "page": 1, "output": "json",
    })
    with urlopen(f"https://restapi.amap.com/v3/place/around?{query}", timeout=15) as response:
        return json.loads(response.read(1_000_000))


@router.post("/guide/nearby")
async def get_guide_nearby(data: dict = Body(...)) -> dict:
    """Journey/Chat-only POI search. Coordinates stay out of access-log URLs."""
    lat, lng = _guide_number(data.get("latitude")), _guide_number(data.get("longitude"))
    kind = data.get("kind")
    if (lat is None or lng is None or not -90 <= lat <= 90 or not -180 <= lng <= 180
            or kind not in ("food", "photo")):
        raise HTTPException(status_code=400, detail="附近导览查询参数无效")
    result = {"available": False, "items": [], "radius": 3000, "source": "高德地图 POI"}
    key = _guide_amap_key()
    if not key:
        return {**result, "reason": "当前导览服务未配置高德 Web 服务，无法核实附近地点和评分，请联系维护者后重试。"}
    try:
        payload = await asyncio.to_thread(_fetch_guide_pois, key, lat, lng, kind, result["radius"])
        if not isinstance(payload, dict) or str(payload.get("status")) != "1":
            return {**result, "reason": "地图查询暂不可用，无法核实附近地点或评分，请稍后重试。"}
        return {**result, "available": True, "items": _guide_places(payload, result["radius"])}
    except Exception:
        # Never expose transport exceptions: they can contain the API key URL.
        return {**result, "reason": "地图查询超时或连接失败，请稍后重试。"}


def _fetch_guide_origin(key: str, latitude: float, longitude: float) -> dict:
    # https://lbs.amap.com/api/webservice/guide/api/georegeo
    # Request only on journey start; the provider never receives a GPS stream.
    query = urlencode({
        "key": key, "location": f"{longitude:.6f},{latitude:.6f}",
        "radius": 200, "extensions": "all", "output": "json",
    })
    with urlopen(f"https://restapi.amap.com/v3/geocode/regeo?{query}", timeout=10) as response:
        return json.loads(response.read(1_000_000))


def _guide_origin(payload: dict) -> dict:
    regeo = payload.get("regeocode")
    regeo = regeo if isinstance(regeo, dict) else {}
    pois = regeo.get("pois")
    candidates = []
    for poi in pois if isinstance(pois, list) else []:
        if not isinstance(poi, dict):
            continue
        name, distance = poi.get("name"), _guide_number(poi.get("distance"))
        if isinstance(name, str) and name.strip() and distance is not None and 0 <= distance <= 200:
            candidates.append((distance, name.strip()[:200], str(poi.get("type", ""))))
    if candidates:
        distance, name, category = min(candidates, key=lambda item: item[0])
        # A nearby hotel is not proof the visitor is inside or staying there.
        return {"available": True, "label": f"你目前在{name}附近", "name": name,
                "kind": "hotel" if any(word in category for word in ("酒店", "住宿", "宾馆", "賓館")) else "place",
                "distance": distance, "source": "高德地图附近地点识别"}
    address = regeo.get("formatted_address")
    if isinstance(address, str) and address.strip():
        return {"available": True, "label": f"你目前在{address.strip()[:200]}附近",
                "kind": "address", "source": "高德地图地址识别"}
    return {"available": False, "reason": "已获取位置，但地图暂未返回可核实的地点名称。"}


@router.post("/guide/origin")
async def get_guide_origin(data: dict = Body(...)) -> dict:
    """Journey-only starting-place lookup; do not log coordinates or map keys."""
    lat, lng = _guide_number(data.get("latitude")), _guide_number(data.get("longitude"))
    if lat is None or lng is None or not -90 <= lat <= 90 or not -180 <= lng <= 180:
        raise HTTPException(status_code=400, detail="出发地查询参数无效")
    unavailable = {"available": False, "reason": "出发地名称暂不可用，仍可根据位置选择附近景点。"}
    key = _guide_amap_key()
    if not key:
        return unavailable
    try:
        payload = await asyncio.to_thread(_fetch_guide_origin, key, lat, lng)
        if not isinstance(payload, dict) or str(payload.get("status")) != "1":
            return unavailable
        return _guide_origin(payload)
    except Exception:
        return unavailable


def _ai_drive_headers() -> dict[str, str]:
    """Use an optional server-side AI Drive token; never expose it to the UI."""
    return {"Authorization": f"Bearer {AI_DRIVE_TOKEN}"} if AI_DRIVE_TOKEN else {}


async def _ai_drive_request(
    method: str,
    path: str,
    *,
    params: dict[str, object] | None = None,
    files: dict[str, tuple[str, bytes, str]] | None = None,
) -> httpx.Response:
    """Call an allow-listed AI Drive endpoint from QwenPaw's host machine."""
    try:
        async with httpx.AsyncClient(timeout=AI_DRIVE_TIMEOUT_SECONDS) as client:
            response = await client.request(
                method,
                f"{AI_DRIVE_BASE_URL}{path}",
                params=params,
                headers=_ai_drive_headers(),
                files=files,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail="无法连接 AI Drive，请确认其后端已启动。",
        ) from exc
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="未找到对应图片。")
    if response.status_code == 401:
        raise HTTPException(status_code=502, detail="AI Drive 鉴权失败，请检查服务端配置。")
    if response.status_code in {400, 413}:
        try:
            detail = response.json().get("detail")
        except (ValueError, AttributeError):
            detail = None
        raise HTTPException(
            status_code=response.status_code,
            detail=str(detail or "AI Drive 未接受该图片。"),
        )
    if response.is_error:
        raise HTTPException(status_code=502, detail="AI Drive 图片服务暂时不可用。")
    return response


async def _ai_drive_get(path: str, params: dict[str, object] | None = None) -> httpx.Response:
    return await _ai_drive_request("GET", path, params=params)


@router.get("/album/photos")
async def list_album_photos(
    limit: int = Query(default=120, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """Proxy the AI Drive photo timeline, ordered by shooting time then upload time."""
    try:
        response = await _ai_drive_get(
            "/api/photos",
            {"limit": limit, "offset": offset, "sort": "taken_at"},
        )
    except HTTPException as exc:
        if exc.status_code not in {502, 503}:
            raise
        with _local_album_lock:
            local_items = list(reversed(_load_local_album()))
        page = local_items[offset : offset + limit]
        return {
            "items": page,
            "total": len(local_items),
            "limit": limit,
            "offset": offset,
            "sort": "created_at_desc",
            "storage": "qwenpaw-local-fallback",
        }
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="AI Drive 返回了无效的相册数据。") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise HTTPException(status_code=502, detail="AI Drive 相册数据格式无效。")

    items: list[dict] = []
    allowed_fields = {
        "file_id",
        "filename",
        "display_name",
        "content_type",
        "size_bytes",
        "created_at",
        "taken_at",
        "gps_lat",
        "gps_lon",
        "camera_make",
        "camera_model",
        "width",
        "height",
        "summary",
        "tags",
    }
    for item in payload["items"]:
        if isinstance(item, dict) and isinstance(item.get("file_id"), int):
            items.append({key: value for key, value in item.items() if key in allowed_fields})
    return {
        "items": items,
        "total": int(payload.get("total") or len(items)),
        "limit": int(payload.get("limit") or limit),
        "offset": int(payload.get("offset") or offset),
        "sort": "taken_at_desc_then_created_at_desc",
    }


@router.get("/album/photos/{file_id}/image")
async def get_album_photo_image(file_id: int) -> Response:
    """Serve a single AI Drive image through QwenPaw for remote-browser access."""
    try:
        response = await _ai_drive_get(f"/files/{file_id}/download")
    except HTTPException as exc:
        if exc.status_code not in {404, 502, 503}:
            raise
        item = _local_album_item(file_id)
        if item is None:
            raise HTTPException(status_code=404, detail="未找到对应图片。") from exc
        storage_name = item.get("storage_name")
        if not isinstance(storage_name, str):
            raise HTTPException(status_code=404, detail="未找到对应图片。") from exc
        path = (_local_album_dir() / storage_name).resolve()
        try:
            path.relative_to(_local_album_dir().resolve())
            content = path.read_bytes()
        except (OSError, ValueError) as read_error:
            raise HTTPException(status_code=404, detail="未找到对应图片。") from read_error
        return Response(
            content=content,
            media_type=str(item.get("content_type") or "application/octet-stream"),
            headers={"Cache-Control": "private, max-age=300"},
        )
    content_type = response.headers.get("content-type", "application/octet-stream")
    if not content_type.lower().startswith("image/"):
        raise HTTPException(status_code=502, detail="AI Drive 返回的不是图片文件。")
    return Response(
        content=response.content,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.post("/album/photos", status_code=201)
async def upload_album_photo(photo: UploadFile = File(...)) -> dict:
    """Upload an image to AI Drive so it joins the shared photo timeline."""
    content_type = (photo.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="只能上传图片文件。")
    content = await photo.read(MAX_ALBUM_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="不能上传空图片。")
    if len(content) > MAX_ALBUM_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="单张图片不能超过 20 MB。")
    filename = photo.filename or "photo"
    try:
        response = await _ai_drive_request(
            "POST",
            "/files/upload",
            files={"upload": (filename, content, content_type)},
        )
    except HTTPException as exc:
        if exc.status_code not in {502, 503}:
            raise
        file_id = _store_local_album_photo(filename, content_type, content)
        return {
            "file_id": file_id,
            "message": "图片已上传到 QwenPaw 私有云相册。",
            "storage": "qwenpaw-local-fallback",
        }
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="AI Drive 上传响应无效。") from exc
    file_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(file_id, int):
        raise HTTPException(status_code=502, detail="AI Drive 未返回上传图片信息。")
    return {"file_id": file_id, "message": "图片已上传到 AI Drive。"}


@router.delete("/album/photos/{file_id}")
async def delete_album_photo(file_id: int) -> dict:
    """Soft-delete a photo through AI Drive; recovery remains available there."""
    try:
        response = await _ai_drive_request("DELETE", f"/files/{file_id}")
    except HTTPException as exc:
        if exc.status_code not in {404, 502, 503}:
            raise
        if not _delete_local_album_photo(file_id):
            raise HTTPException(status_code=404, detail="未找到对应图片。") from exc
        return {
            "ok": True,
            "message": "图片已从 QwenPaw 私有云相册删除。",
            "storage": "qwenpaw-local-fallback",
        }
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    return {
        "ok": bool(payload.get("ok", True)) if isinstance(payload, dict) else True,
        "message": "图片已移入 AI Drive 回收站。",
    }
