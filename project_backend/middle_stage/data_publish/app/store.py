"""数据访问层。

所有 SQL 都集中在这里，HTTP 层只负责解析请求和序列化响应。这样以后要把
服务换成 FastAPI，或者直接把本模块嵌进主项目，都不用重写查询逻辑。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from . import bus_seed_data, seed_data
from .config import LEVELS, derive_crowd_level
from .db import connect
from .geo import to_gcj02


class ValidationError(ValueError):
    """请求数据不合法。HTTP 层会转成 400。"""


class NotFoundError(LookupError):
    """目标不存在。HTTP 层会转成 404。"""


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_timestamp(value: str | None) -> str:
    """接受 ISO8601（带或不带 Z / 时区），统一存成 UTC。"""
    if not value:
        return utc_now()
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as error:
        raise ValidationError(f"observed_at 不是合法的 ISO8601 时间: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slugify(text: str) -> str:
    """英文名 → url 友好 slug；中文等非 ASCII 字符会被去掉。"""
    normalized = unicodedata.normalize("NFKD", text)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_only).strip("-").lower()
    return slug


def _short_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def _json_list(value: Any) -> str | None:
    """别名列表统一存成 JSON 数组字符串。"""
    if value is None:
        return None
    if isinstance(value, str):
        items = [part.strip() for part in re.split(r"[,，;；]", value) if part.strip()]
    elif isinstance(value, (list, tuple)):
        items = [str(item).strip() for item in value if str(item).strip()]
    else:
        raise ValidationError("aliases 必须是数组或以逗号分隔的字符串")
    return json.dumps(items, ensure_ascii=False) if items else None


def _row_to_city(row: sqlite3.Row) -> dict:
    return {
        "city_id": row["city_id"],
        "name": row["name"],
        "name_en": row["name_en"],
        "center": [row["center_lng"], row["center_lat"]],
        "default_zoom": row["default_zoom"],
        "bounds": json.loads(row["bounds"]) if row["bounds"] else None,
        "source": row["source"],
        "created_at": row["created_at"],
    }


def _row_to_region(row: sqlite3.Row) -> dict:
    keys = row.keys()
    region = {
        "region_id": row["region_id"],
        "city_id": row["city_id"],
        "parent_id": row["parent_id"],
        "level": row["level"],
        "name": row["name"],
        "name_en": row["name_en"],
        "aliases": json.loads(row["aliases"]) if row["aliases"] else [],
        "center": (
            [row["center_lng"], row["center_lat"]]
            if row["center_lng"] is not None and row["center_lat"] is not None
            else None
        ),
        "radius_m": row["radius_m"],
        "area_m2": row["area_m2"],
        "geometry": json.loads(row["geometry"]) if row["geometry"] else None,
        "source": row["source"],
        "created_at": row["created_at"],
        "coord_system": "gcj02",
    }
    # 带 JOIN 的查询会多出这几列，有就一起返回，方便前端少发一次请求。
    for extra in ("city_name", "parent_name"):
        if extra in keys:
            region[extra] = row[extra]
    # v1.1 迁移新增的列
    for extra in ("external_source", "external_id", "address", "adcode", "amap_type"):
        if extra in keys:
            region[extra] = row[extra]
    return region


# 高德的城市名 → 内置城市 id。避免「澳门特别行政区」又建一个重复城市。
SEED_CITY_ALIASES = {
    "澳门": "macau",
    "香港": "hongkong",
    "广州": "guangzhou",
    "深圳": "shenzhen",
}


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    # ── 连接 ────────────────────────────────────────────────────────────
    @contextmanager
    def _session(self) -> Iterator[sqlite3.Connection]:
        """每个请求一条连接。sqlite3 的 `with conn` 只管事务不管关闭，所以这里
        自己负责 close，避免长时间运行后句柄泄漏。"""
        connection = connect(self.db_path)
        try:
            yield connection
        finally:
            connection.close()

    # ── 城市 ────────────────────────────────────────────────────────────
    def list_cities(self, q: str = "") -> list[dict]:
        sql = "SELECT * FROM cities"
        params: list[Any] = []
        if q:
            sql += " WHERE name LIKE ? OR IFNULL(name_en, '') LIKE ? OR city_id LIKE ?"
            like = f"%{q}%"
            params = [like, like, like]
        sql += " ORDER BY name"
        with self._session() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_row_to_city(row) for row in rows]

    def get_city(self, city_id: str) -> dict:
        with self._session() as connection:
            row = connection.execute(
                "SELECT * FROM cities WHERE city_id = ?", (city_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"城市不存在: {city_id}")
        return _row_to_city(row)

    def create_city(self, payload: dict) -> dict:
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ValidationError("name 不能为空")
        lng, lat = self._read_center(payload, required=True)
        city_id = str(payload.get("city_id", "")).strip()
        if not city_id:
            city_id = _slugify(str(payload.get("name_en") or "")) or f"city-{_short_hash(name)}"
        bounds = payload.get("bounds")
        if bounds is not None and (not isinstance(bounds, (list, tuple)) or len(bounds) != 4):
            raise ValidationError("bounds 必须是 [minLng, minLat, maxLng, maxLat]")
        with self._session() as connection:
            exists = connection.execute(
                "SELECT 1 FROM cities WHERE city_id = ?", (city_id,)
            ).fetchone()
            if exists:
                raise ValidationError(f"城市已存在: {city_id}")
            connection.execute(
                """
                INSERT INTO cities (city_id, name, name_en, center_lng, center_lat,
                                    default_zoom, bounds, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)
                """,
                (
                    city_id,
                    name,
                    str(payload.get("name_en") or "").strip() or None,
                    lng,
                    lat,
                    float(payload.get("default_zoom") or 12),
                    json.dumps(list(bounds)) if bounds else None,
                    utc_now(),
                ),
            )
            connection.commit()
        return self.get_city(city_id)

    # ── 区域 / 景点 ─────────────────────────────────────────────────────
    def search_regions(
        self,
        *,
        city_id: str = "",
        level: str = "",
        parent_id: str = "",
        q: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        where: list[str] = []
        params: list[Any] = []
        if city_id:
            where.append("r.city_id = ?")
            params.append(city_id)
        if level:
            if level not in LEVELS:
                raise ValidationError(f"level 必须是 {'/'.join(LEVELS)} 之一")
            where.append("r.level = ?")
            params.append(level)
        if parent_id:
            where.append("r.parent_id = ?")
            params.append(parent_id)
        if q:
            like = f"%{q}%"
            where.append(
                "(r.name LIKE ? OR IFNULL(r.name_en, '') LIKE ? "
                "OR IFNULL(r.aliases, '') LIKE ? OR r.region_id LIKE ?)"
            )
            params.extend([like, like, like, like])
        clause = f" WHERE {' AND '.join(where)}" if where else ""

        base = (
            "FROM regions r "
            "LEFT JOIN cities c ON c.city_id = r.city_id "
            "LEFT JOIN regions p ON p.region_id = r.parent_id"
        ) + clause
        with self._session() as connection:
            total = connection.execute(f"SELECT COUNT(*) AS n {base}", params).fetchone()["n"]
            rows = connection.execute(
                "SELECT r.*, c.name AS city_name, p.name AS parent_name "
                f"{base} ORDER BY r.city_id, "
                "CASE r.level WHEN 'district' THEN 0 WHEN 'street' THEN 1 ELSE 2 END, "
                "r.name LIMIT ? OFFSET ?",
                [*params, max(1, min(int(limit), 500)), max(0, int(offset))],
            ).fetchall()
        return {"total": int(total), "items": [_row_to_region(row) for row in rows]}

    def get_region(self, region_id: str) -> dict:
        with self._session() as connection:
            row = connection.execute(
                "SELECT r.*, c.name AS city_name, p.name AS parent_name "
                "FROM regions r "
                "LEFT JOIN cities c ON c.city_id = r.city_id "
                "LEFT JOIN regions p ON p.region_id = r.parent_id "
                "WHERE r.region_id = ?",
                (region_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"区域不存在: {region_id}")
        return _row_to_region(row)

    def _read_center(self, payload: dict, *, required: bool) -> tuple[float | None, float | None]:
        """读取经纬度并统一转成 GCJ-02。支持 center=[lng,lat] 或 lng/lat 字段。"""
        center = payload.get("center")
        if isinstance(center, (list, tuple)) and len(center) == 2:
            raw_lng, raw_lat = center
        else:
            raw_lng = payload.get("lng", payload.get("longitude"))
            raw_lat = payload.get("lat", payload.get("latitude"))
        if raw_lng in (None, "") or raw_lat in (None, ""):
            if required:
                raise ValidationError("缺少坐标：请提供 center=[lng, lat] 或 lng / lat")
            return None, None
        try:
            lng = float(raw_lng)
            lat = float(raw_lat)
        except (TypeError, ValueError) as error:
            raise ValidationError("坐标必须是数字") from error
        if not -180 <= lng <= 180 or not -90 <= lat <= 90:
            raise ValidationError("坐标超出合法范围")
        try:
            return to_gcj02(lng, lat, str(payload.get("coord_system") or "gcj02"))
        except ValueError as error:
            raise ValidationError(str(error)) from error

    def create_region(self, payload: dict) -> dict:
        city_id = str(payload.get("city_id", "")).strip()
        if not city_id:
            raise ValidationError("city_id 不能为空")
        level = str(payload.get("level", "")).strip()
        if level not in LEVELS:
            raise ValidationError(f"level 必须是 {'/'.join(LEVELS)} 之一")
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ValidationError("name 不能为空")
        parent_id = str(payload.get("parent_id") or "").strip() or None
        lng, lat = self._read_center(payload, required=False)

        geometry = payload.get("geometry")
        if geometry is not None and not isinstance(geometry, dict):
            raise ValidationError("geometry 必须是 GeoJSON 对象")

        with self._session() as connection:
            if connection.execute(
                "SELECT 1 FROM cities WHERE city_id = ?", (city_id,)
            ).fetchone() is None:
                raise ValidationError(f"城市不存在: {city_id}")
            if parent_id is not None:
                parent = connection.execute(
                    "SELECT city_id FROM regions WHERE region_id = ?", (parent_id,)
                ).fetchone()
                if parent is None:
                    raise ValidationError(f"上级区域不存在: {parent_id}")
                if parent["city_id"] != city_id:
                    raise ValidationError("上级区域必须和当前区域属于同一城市")

            region_id = str(payload.get("region_id") or "").strip()
            if not region_id:
                region_id = self._generate_region_id(connection, city_id, level, name, payload)
            elif connection.execute(
                "SELECT 1 FROM regions WHERE region_id = ?", (region_id,)
            ).fetchone():
                raise ValidationError(f"区域 ID 已存在: {region_id}")

            connection.execute(
                """
                INSERT INTO regions (region_id, city_id, parent_id, level, name, name_en,
                                     aliases, center_lng, center_lat, radius_m, area_m2,
                                     geometry, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
                """,
                (
                    region_id,
                    city_id,
                    parent_id,
                    level,
                    name,
                    str(payload.get("name_en") or "").strip() or None,
                    _json_list(payload.get("aliases")),
                    lng,
                    lat,
                    _optional_float(payload.get("radius_m"), "radius_m"),
                    _optional_float(payload.get("area_m2"), "area_m2"),
                    json.dumps(geometry, ensure_ascii=False) if geometry else None,
                    utc_now(),
                ),
            )
            connection.commit()
        return self.get_region(region_id)

    def _generate_region_id(
        self, connection: sqlite3.Connection, city_id: str, level: str, name: str, payload: dict
    ) -> str:
        prefix = {"district": "d", "street": "s", "poi": "poi"}[level]
        slug = _slugify(str(payload.get("name_en") or "")) or _slugify(name)
        if not slug:
            slug = f"n{_short_hash(name)}"
        candidate = f"{city_id}-{prefix}-{slug}"
        suffix = 2
        while connection.execute(
            "SELECT 1 FROM regions WHERE region_id = ?", (candidate,)
        ).fetchone():
            candidate = f"{city_id}-{prefix}-{slug}-{suffix}"
            suffix += 1
        return candidate

    # ── 高德来源的地点 ──────────────────────────────────────────────────
    def _resolve_city(
        self,
        connection: sqlite3.Connection,
        *,
        city_name: str,
        adcode: str,
        center: tuple[float, float],
    ) -> str:
        """把高德返回的城市落到本库的一个 city_id 上，必要时自动建城市。

        这样「高德能搜到的任何地方」都能直接发布，不用先手工建城市。
        """
        name = (city_name or "").strip()

        # 1) 内置城市别名（澳门特别行政区 → macau）
        for alias, city_id in SEED_CITY_ALIASES.items():
            if alias and alias in name:
                if connection.execute(
                    "SELECT 1 FROM cities WHERE city_id = ?", (city_id,)
                ).fetchone():
                    return city_id

        # 2) 已经按 adcode 建过
        if adcode:
            row = connection.execute(
                "SELECT city_id FROM cities WHERE adcode = ?", (adcode,)
            ).fetchone()
            if row:
                return row["city_id"]

        # 3) 名称完全一致的已有城市
        if name:
            row = connection.execute(
                "SELECT city_id FROM cities WHERE name = ?", (name,)
            ).fetchone()
            if row:
                return row["city_id"]

        # 4) 拿不到城市名（例如没配 Key 时直接点地图）：就近归属到已有城市。
        #    超过 80 公里说明确实不在任何已知城市附近，这时才要求用户指定。
        if not name:
            nearest_id, nearest_distance = None, float("inf")
            for row in connection.execute(
                "SELECT city_id, center_lng, center_lat FROM cities"
            ).fetchall():
                distance = _rough_distance_m(
                    center[0], center[1], row["center_lng"], row["center_lat"]
                )
                if distance < nearest_distance:
                    nearest_id, nearest_distance = row["city_id"], distance
            if nearest_id and nearest_distance <= 80_000:
                return nearest_id
            raise ValidationError(
                "无法判断这个坐标属于哪个城市：请在页面上先选定「限定城市」，"
                "或配置高德 Key 后重试。"
            )
        city_id = f"amap-{adcode}" if adcode else f"amap-{_short_hash(name)}"
        suffix = 2
        while connection.execute(
            "SELECT 1 FROM cities WHERE city_id = ?", (city_id,)
        ).fetchone():
            city_id = f"{city_id}-{suffix}"
            suffix += 1
        connection.execute(
            """
            INSERT INTO cities (city_id, name, name_en, center_lng, center_lat,
                                default_zoom, bounds, adcode, source, created_at)
            VALUES (?, ?, NULL, ?, ?, 12, NULL, ?, 'amap', ?)
            """,
            (city_id, name, center[0], center[1], adcode or None, utc_now()),
        )
        return city_id

    def upsert_amap_region(self, payload: dict) -> dict:
        """把一个高德 POI / 逆地理编码结果登记成可发布的区域。

        同一个高德 POI 重复添加时返回已有记录，不会产生重复区域。
        """
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ValidationError("name 不能为空")

        level = str(payload.get("level") or "poi").strip()
        if level not in LEVELS:
            raise ValidationError(f"level 必须是 {'/'.join(LEVELS)} 之一")

        # 高德返回的坐标本来就是 GCJ-02，默认不再转换。
        lng, lat = self._read_center(
            {**payload, "coord_system": payload.get("coord_system") or "gcj02"}, required=True
        )

        amap_id = str(payload.get("amap_id") or "").strip() or None
        adcode = str(payload.get("adcode") or "").strip()
        city_name = str(payload.get("city") or "").strip()
        address = str(payload.get("address") or "").strip() or None

        with self._session() as connection:
            if amap_id:
                existing = connection.execute(
                    "SELECT region_id FROM regions WHERE external_source = 'amap' AND external_id = ?",
                    (amap_id,),
                ).fetchone()
                if existing:
                    return {**self.get_region(existing["region_id"]), "created": False}

            city_id = str(payload.get("city_id") or "").strip()
            if city_id:
                if connection.execute(
                    "SELECT 1 FROM cities WHERE city_id = ?", (city_id,)
                ).fetchone() is None:
                    raise ValidationError(f"城市不存在: {city_id}")
            else:
                city_id = self._resolve_city(
                    connection, city_name=city_name, adcode=adcode, center=(lng, lat)
                )

            # 没有高德 id（例如纯坐标点击）时，用「同城 + 同名 + 30 米内」去重，
            # 避免连点几下把同一个地方登记成好几条。
            if not amap_id:
                nearby = connection.execute(
                    """
                    SELECT region_id, center_lng, center_lat FROM regions
                    WHERE city_id = ? AND name = ? AND center_lng IS NOT NULL
                    """,
                    (city_id, name),
                ).fetchall()
                for row in nearby:
                    if _rough_distance_m(lng, lat, row["center_lng"], row["center_lat"]) <= 30:
                        connection.commit()
                        return {**self.get_region(row["region_id"]), "created": False}

            # 中文名生成不出 slug，用高德 POI id 兜底，比一串哈希好追溯。
            region_id = self._generate_region_id(
                connection,
                city_id,
                level,
                name,
                {"name_en": payload.get("name_en") or amap_id or ""},
            )
            connection.execute(
                """
                INSERT INTO regions (region_id, city_id, parent_id, level, name, name_en,
                                     aliases, center_lng, center_lat, radius_m, area_m2,
                                     geometry, source, created_at,
                                     external_source, external_id, address, adcode, amap_type)
                VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'amap', ?, ?, ?, ?, ?, ?)
                """,
                (
                    region_id,
                    city_id,
                    level,
                    name,
                    str(payload.get("name_en") or "").strip() or None,
                    _json_list(payload.get("aliases")),
                    lng,
                    lat,
                    _optional_float(payload.get("radius_m"), "radius_m"),
                    utc_now(),
                    "amap",
                    amap_id,
                    address,
                    adcode or None,
                    str(payload.get("amap_type") or "").strip() or None,
                ),
            )
            connection.commit()
        return {**self.get_region(region_id), "created": True}

    # ── 发布 ────────────────────────────────────────────────────────────
    def publish(self, payload: dict) -> dict:
        """一次发布 = 一个批次，整批写入或整批失败。"""
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise ValidationError("items 不能为空，格式为 [{region_id, people_count}, ...]")
        if len(items) > 500:
            raise ValidationError("单次发布最多 500 条")

        publisher = str(payload.get("publisher") or "").strip() or "anonymous"
        batch_note = str(payload.get("note") or "").strip() or None
        default_observed_at = _parse_timestamp(payload.get("observed_at"))

        prepared: list[tuple] = []
        created_at = utc_now()
        with self._session() as connection:
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    raise ValidationError(f"items[{index}] 必须是对象")
                region_id = str(item.get("region_id", "")).strip()
                if not region_id:
                    raise ValidationError(f"items[{index}] 缺少 region_id")
                region = connection.execute(
                    "SELECT level FROM regions WHERE region_id = ?", (region_id,)
                ).fetchone()
                if region is None:
                    raise ValidationError(f"items[{index}] 的区域不存在: {region_id}")

                raw_count = item.get("people_count", item.get("count"))
                try:
                    people_count = int(raw_count)
                except (TypeError, ValueError) as error:
                    raise ValidationError(f"items[{index}] 的人数必须是整数") from error
                if people_count < 0:
                    raise ValidationError(f"items[{index}] 的人数不能为负")
                if people_count > 10_000_000:
                    raise ValidationError(f"items[{index}] 的人数明显超出合理范围")

                raw_level = item.get("crowd_level")
                if raw_level in (None, ""):
                    crowd_level = derive_crowd_level(region["level"], people_count)
                else:
                    try:
                        crowd_level = int(raw_level)
                    except (TypeError, ValueError) as error:
                        raise ValidationError(f"items[{index}] 的 crowd_level 必须是整数") from error
                    if not 0 <= crowd_level <= 4:
                        raise ValidationError(f"items[{index}] 的 crowd_level 必须在 0~4 之间")

                observed_at = (
                    _parse_timestamp(item["observed_at"])
                    if item.get("observed_at")
                    else default_observed_at
                )
                prepared.append(
                    (
                        region_id,
                        observed_at,
                        people_count,
                        crowd_level,
                        str(item.get("note") or "").strip() or None,
                        created_at,
                    )
                )

            batch_id = f"batch_{uuid.uuid4().hex[:12]}"
            connection.execute(
                """
                INSERT INTO batches (batch_id, publisher, note, status, item_count, created_at)
                VALUES (?, ?, ?, 'published', ?, ?)
                """,
                (batch_id, publisher, batch_note, len(prepared), created_at),
            )
            connection.executemany(
                """
                INSERT INTO readings (region_id, batch_id, observed_at, people_count,
                                      crowd_level, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (region_id, batch_id, observed_at, count, level, note, stamp)
                    for region_id, observed_at, count, level, note, stamp in prepared
                ],
            )
            connection.commit()

        return {
            "batch_id": batch_id,
            "publisher": publisher,
            "item_count": len(prepared),
            "created_at": created_at,
        }

    def list_batches(self, limit: int = 50) -> list[dict]:
        with self._session() as connection:
            rows = connection.execute(
                "SELECT * FROM batches ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_batch(self, batch_id: str) -> dict:
        with self._session() as connection:
            batch = connection.execute(
                "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
            ).fetchone()
            if batch is None:
                raise NotFoundError(f"批次不存在: {batch_id}")
            rows = connection.execute(
                "SELECT rd.*, r.name AS region_name, r.level AS region_level "
                "FROM readings rd JOIN regions r ON r.region_id = rd.region_id "
                "WHERE rd.batch_id = ? ORDER BY rd.reading_id",
                (batch_id,),
            ).fetchall()
        result = dict(batch)
        result["items"] = [dict(row) for row in rows]
        return result

    def revert_batch(self, batch_id: str) -> dict:
        """撤销一个批次：删掉它的读数，批次本身标记为 reverted 留痕。"""
        with self._session() as connection:
            batch = connection.execute(
                "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
            ).fetchone()
            if batch is None:
                raise NotFoundError(f"批次不存在: {batch_id}")
            if batch["status"] == "reverted":
                raise ValidationError("该批次已经撤销过")
            connection.execute("DELETE FROM readings WHERE batch_id = ?", (batch_id,))
            connection.execute(
                "UPDATE batches SET status = 'reverted' WHERE batch_id = ?", (batch_id,)
            )
            connection.commit()
        return {"batch_id": batch_id, "status": "reverted"}

    # ── 读取密度 ────────────────────────────────────────────────────────
    def latest_density(
        self, *, city_id: str = "", level: str = "", include_empty: bool = True
    ) -> dict:
        """每个区域取最新一条读数。include_empty=True 时把没有数据的区域也带上，
        值为 null —— 前端必须把「无数据」和「0 人」区分开，不能都画成最浅色。"""
        if level and level not in LEVELS:
            raise ValidationError(f"level 必须是 {'/'.join(LEVELS)} 之一")

        where: list[str] = []
        params: list[Any] = []
        if city_id:
            where.append("r.city_id = ?")
            params.append(city_id)
        if level:
            where.append("r.level = ?")
            params.append(level)
        clause = f" WHERE {' AND '.join(where)}" if where else ""

        sql = f"""
            SELECT r.*, c.name AS city_name, p.name AS parent_name,
                   latest.people_count, latest.crowd_level,
                   latest.observed_at, latest.batch_id, latest.note AS reading_note
            FROM regions r
            LEFT JOIN cities c ON c.city_id = r.city_id
            LEFT JOIN regions p ON p.region_id = r.parent_id
            LEFT JOIN readings latest ON latest.reading_id = (
                SELECT reading_id FROM readings
                WHERE region_id = r.region_id
                ORDER BY observed_at DESC, reading_id DESC
                LIMIT 1
            )
            {clause}
            ORDER BY r.city_id,
                     CASE r.level WHEN 'district' THEN 0 WHEN 'street' THEN 1 ELSE 2 END,
                     r.name
        """
        with self._session() as connection:
            rows = connection.execute(sql, params).fetchall()

        items = []
        for row in rows:
            has_reading = row["people_count"] is not None
            if not has_reading and not include_empty:
                continue
            region = _row_to_region(row)
            region["reading"] = (
                {
                    "people_count": row["people_count"],
                    "crowd_level": row["crowd_level"],
                    "observed_at": row["observed_at"],
                    "batch_id": row["batch_id"],
                    "note": row["reading_note"],
                }
                if has_reading
                else None
            )
            items.append(region)
        return {"generated_at": utc_now(), "count": len(items), "items": items}

    def region_history(self, region_id: str, limit: int = 50) -> dict:
        region = self.get_region(region_id)
        with self._session() as connection:
            rows = connection.execute(
                "SELECT * FROM readings WHERE region_id = ? "
                "ORDER BY observed_at DESC, reading_id DESC LIMIT ?",
                (region_id, max(1, min(int(limit), 500))),
            ).fetchall()
        return {"region": region, "items": [dict(row) for row in rows]}

    # ── 模拟巴士报站 ──────────────────────────────────────────────────
    @staticmethod
    def _bus_route_with_stops(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
        route = dict(row)
        route["active"] = bool(route["active"])
        stops = connection.execute(
            """SELECT s.stop_id, s.name, s.name_en, s.center_lng, s.center_lat,
                      rs.stop_sequence, rs.minutes_from_start
               FROM bus_route_stops rs
               JOIN bus_stops s ON s.stop_id = rs.stop_id
               WHERE rs.route_id = ? ORDER BY rs.stop_sequence""",
            (route["route_id"],),
        ).fetchall()
        route["stops"] = [
            {
                "stop_id": stop["stop_id"],
                "name": stop["name"],
                "name_en": stop["name_en"],
                "center": [stop["center_lng"], stop["center_lat"]],
                "stop_sequence": stop["stop_sequence"],
                "minutes_from_start": stop["minutes_from_start"],
                "coord_system": "gcj02",
            }
            for stop in stops
        ]
        route["stop_count"] = len(route["stops"])
        return route

    def list_bus_routes(self, *, route_id: str = "") -> dict:
        with self._session() as connection:
            if route_id:
                rows = connection.execute(
                    "SELECT * FROM bus_routes WHERE route_id = ? AND active = 1",
                    (route_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM bus_routes WHERE active = 1 ORDER BY route_no, direction"
                ).fetchall()
            routes = [self._bus_route_with_stops(connection, row) for row in rows]
        if route_id and not routes:
            raise NotFoundError(f"巴士路线不存在: {route_id}")
        return {
            "generated_at": utc_now(),
            "source": "mock",
            "disclaimer": "模拟数据，仅用于 LensGo 功能演示，不可作为实际乘车依据。",
            "count": len(routes),
            "items": routes,
        }

    @staticmethod
    def _enrich_bus_vehicle(
        connection: sqlite3.Connection, row: sqlite3.Row
    ) -> dict:
        route_row = connection.execute(
            "SELECT * FROM bus_routes WHERE route_id = ?", (row["route_id"],)
        ).fetchone()
        if route_row is None:
            raise NotFoundError(f"巴士路线不存在: {row['route_id']}")
        route = Store._bus_route_with_stops(connection, route_row)
        stops = route["stops"]
        sequence = int(row["current_stop_sequence"])
        current = stops[sequence]
        following = stops[sequence + 1] if sequence + 1 < len(stops) else None
        progress = float(row["progress"])

        if following:
            segment_minutes = max(
                0.1,
                float(following["minutes_from_start"]) - float(current["minutes_from_start"]),
            )
            eta_next = max(
                0, int(segment_minutes * (1 - progress) + int(row["delay_minutes"]) + 0.999)
            )
            position = [
                current["center"][0] + (following["center"][0] - current["center"][0]) * progress,
                current["center"][1] + (following["center"][1] - current["center"][1]) * progress,
            ]
        else:
            eta_next = 0
            position = list(current["center"])

        return {
            "vehicle_id": row["vehicle_id"],
            "display_name": row["display_name"] or row["vehicle_id"],
            "route_id": row["route_id"],
            "route_no": route["route_no"],
            "direction": route["direction"],
            "destination": route["destination"],
            "color": route["color"],
            "current_stop_sequence": sequence,
            "current_stop": current,
            "next_stop": following,
            "progress": progress,
            "remaining_stops": max(0, len(stops) - sequence - 1),
            "eta_to_next_stop_minutes": eta_next,
            "position": position,
            "coord_system": "gcj02",
            "status": row["status"],
            "occupancy_level": int(row["occupancy_level"]),
            "delay_minutes": int(row["delay_minutes"]),
            "speed_kmh": float(row["speed_kmh"]),
            "observed_at": row["observed_at"],
            "updated_at": row["updated_at"],
            "source": row["source"],
        }

    def publish_bus_vehicle(self, payload: dict) -> dict:
        vehicle_id = str(payload.get("vehicle_id") or "").strip()
        route_id = str(payload.get("route_id") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{2,64}", vehicle_id):
            raise ValidationError("vehicle_id 需为 2~64 位字母、数字、点、下划线或连字符")
        if not route_id:
            raise ValidationError("缺少 route_id")

        try:
            sequence = int(payload.get("current_stop_sequence", 0))
            progress = float(payload.get("progress", 0))
            occupancy = int(payload.get("occupancy_level", 0))
            delay = int(payload.get("delay_minutes", 0))
            speed = float(payload.get("speed_kmh", 0))
        except (TypeError, ValueError) as error:
            raise ValidationError("站点序号、进度、拥挤度、延误和速度必须是数字") from error

        status = str(payload.get("status") or "running").strip()
        allowed_statuses = ("running", "at_stop", "paused", "out_of_service")
        if status not in allowed_statuses:
            raise ValidationError(f"status 必须是 {'/'.join(allowed_statuses)} 之一")
        if not 0 <= progress <= 1:
            raise ValidationError("progress 必须在 0~1 之间")
        if not 0 <= occupancy <= 4:
            raise ValidationError("occupancy_level 必须在 0~4 之间")
        if not -30 <= delay <= 180:
            raise ValidationError("delay_minutes 必须在 -30~180 之间")
        if not 0 <= speed <= 120:
            raise ValidationError("speed_kmh 必须在 0~120 之间")

        observed_at = _parse_timestamp(payload.get("observed_at"))
        created_at = utc_now()
        display_name = str(payload.get("display_name") or "").strip() or None
        with self._session() as connection:
            route = connection.execute(
                "SELECT route_id FROM bus_routes WHERE route_id = ? AND active = 1", (route_id,)
            ).fetchone()
            if route is None:
                raise ValidationError(f"巴士路线不存在: {route_id}")
            stop_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM bus_route_stops WHERE route_id = ?", (route_id,)
                ).fetchone()[0]
            )
            if sequence < 0 or sequence >= stop_count:
                raise ValidationError(f"current_stop_sequence 必须在 0~{stop_count - 1} 之间")
            if sequence == stop_count - 1 and progress != 0:
                raise ValidationError("终点站 progress 必须为 0")

            values = (
                vehicle_id, route_id, display_name, sequence, progress, status,
                occupancy, delay, speed, observed_at, created_at,
            )
            connection.execute(
                """INSERT INTO bus_vehicles
                       (vehicle_id, route_id, display_name, current_stop_sequence, progress,
                        status, occupancy_level, delay_minutes, speed_kmh, observed_at,
                        updated_at, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock')
                   ON CONFLICT(vehicle_id) DO UPDATE SET
                       route_id = excluded.route_id,
                       display_name = excluded.display_name,
                       current_stop_sequence = excluded.current_stop_sequence,
                       progress = excluded.progress,
                       status = excluded.status,
                       occupancy_level = excluded.occupancy_level,
                       delay_minutes = excluded.delay_minutes,
                       speed_kmh = excluded.speed_kmh,
                       observed_at = excluded.observed_at,
                       updated_at = excluded.updated_at,
                       source = 'mock'""",
                values,
            )
            connection.execute(
                """INSERT INTO bus_vehicle_readings
                       (vehicle_id, route_id, current_stop_sequence, progress, status,
                        occupancy_level, delay_minutes, speed_kmh, observed_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    vehicle_id, route_id, sequence, progress, status, occupancy,
                    delay, speed, observed_at, created_at,
                ),
            )
            row = connection.execute(
                "SELECT * FROM bus_vehicles WHERE vehicle_id = ?", (vehicle_id,)
            ).fetchone()
            connection.commit()
            assert row is not None
            result = self._enrich_bus_vehicle(connection, row)
        return result

    def list_bus_vehicles(
        self, *, route_id: str = "", include_inactive: bool = False
    ) -> dict:
        where: list[str] = []
        params: list[Any] = []
        if route_id:
            where.append("route_id = ?")
            params.append(route_id)
        if not include_inactive:
            where.append("status != 'out_of_service'")
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        with self._session() as connection:
            rows = connection.execute(
                f"SELECT * FROM bus_vehicles{clause} ORDER BY route_id, vehicle_id", params
            ).fetchall()
            items = [self._enrich_bus_vehicle(connection, row) for row in rows]
        return {
            "generated_at": utc_now(),
            "source": "mock",
            "disclaimer": "模拟数据，仅用于 LensGo 功能演示，不可作为实际乘车依据。",
            "count": len(items),
            "items": items,
        }

    def bus_arrivals(self, stop_id: str, *, route_id: str = "") -> dict:
        stop_id = stop_id.strip()
        if not stop_id:
            raise ValidationError("缺少 stop_id")
        with self._session() as connection:
            stop_row = connection.execute(
                "SELECT * FROM bus_stops WHERE stop_id = ?", (stop_id,)
            ).fetchone()
            if stop_row is None:
                raise NotFoundError(f"巴士站不存在: {stop_id}")
            vehicle_rows = connection.execute(
                "SELECT * FROM bus_vehicles WHERE status != 'out_of_service'"
                + (" AND route_id = ?" if route_id else "")
                + " ORDER BY route_id, vehicle_id",
                (route_id,) if route_id else (),
            ).fetchall()
            arrivals = []
            for vehicle_row in vehicle_rows:
                target = connection.execute(
                    """SELECT stop_sequence, minutes_from_start FROM bus_route_stops
                       WHERE route_id = ? AND stop_id = ?""",
                    (vehicle_row["route_id"], stop_id),
                ).fetchone()
                if target is None:
                    continue
                current_sequence = int(vehicle_row["current_stop_sequence"])
                target_sequence = int(target["stop_sequence"])
                if target_sequence < current_sequence:
                    continue
                route_row = connection.execute(
                    "SELECT * FROM bus_routes WHERE route_id = ?", (vehicle_row["route_id"],)
                ).fetchone()
                assert route_row is not None
                route = self._bus_route_with_stops(connection, route_row)
                current = route["stops"][current_sequence]
                progress = float(vehicle_row["progress"])
                if target_sequence == current_sequence:
                    eta = 0 if progress == 0 else None
                else:
                    following = route["stops"][current_sequence + 1]
                    segment_minutes = float(following["minutes_from_start"]) - float(
                        current["minutes_from_start"]
                    )
                    current_minutes = float(current["minutes_from_start"]) + progress * segment_minutes
                    eta = max(
                        0,
                        int(
                            float(target["minutes_from_start"])
                            - current_minutes
                            + int(vehicle_row["delay_minutes"])
                            + 0.999
                        ),
                    )
                if eta is None:
                    continue
                arrivals.append(
                    {
                        "vehicle_id": vehicle_row["vehicle_id"],
                        "route_id": route["route_id"],
                        "route_no": route["route_no"],
                        "direction": route["direction"],
                        "destination": route["destination"],
                        "eta_minutes": eta,
                        "stops_away": max(0, target_sequence - current_sequence),
                        "occupancy_level": int(vehicle_row["occupancy_level"]),
                        "delay_minutes": int(vehicle_row["delay_minutes"]),
                        "status": vehicle_row["status"],
                        "observed_at": vehicle_row["observed_at"],
                        "source": "mock",
                    }
                )
            arrivals.sort(key=lambda item: (item["eta_minutes"], item["route_no"]))
        return {
            "generated_at": utc_now(),
            "source": "mock",
            "disclaimer": "模拟到站预测，仅用于 LensGo 功能演示，不可作为实际乘车依据。",
            "stop": {
                "stop_id": stop_row["stop_id"],
                "name": stop_row["name"],
                "center": [stop_row["center_lng"], stop_row["center_lat"]],
                "coord_system": "gcj02",
            },
            "count": len(arrivals),
            "items": arrivals,
        }

    def stats(self) -> dict:
        with self._session() as connection:
            def scalar(sql: str) -> int:
                return int(connection.execute(sql).fetchone()[0])

            return {
                "cities": scalar("SELECT COUNT(*) FROM cities"),
                "regions": scalar("SELECT COUNT(*) FROM regions"),
                "districts": scalar("SELECT COUNT(*) FROM regions WHERE level = 'district'"),
                "streets": scalar("SELECT COUNT(*) FROM regions WHERE level = 'street'"),
                "pois": scalar("SELECT COUNT(*) FROM regions WHERE level = 'poi'"),
                "readings": scalar("SELECT COUNT(*) FROM readings"),
                "batches": scalar("SELECT COUNT(*) FROM batches WHERE status = 'published'"),
                "bus_routes": scalar("SELECT COUNT(*) FROM bus_routes WHERE active = 1"),
                "bus_stops": scalar("SELECT COUNT(*) FROM bus_stops"),
                "bus_vehicles": scalar("SELECT COUNT(*) FROM bus_vehicles"),
            }

    # ── 初始化 ──────────────────────────────────────────────────────────
    def seed(self, *, reset: bool = False) -> dict:
        """写入内置城市/区域。已存在的记录默认跳过，不会覆盖用户新增的数据。"""
        created_at = utc_now()
        inserted_cities = 0
        inserted_regions = 0
        with self._session() as connection:
            if reset:
                connection.execute("DELETE FROM readings")
                connection.execute("DELETE FROM batches")
                connection.execute("DELETE FROM regions")
                connection.execute("DELETE FROM cities")

            for city in seed_data.CITIES:
                if connection.execute(
                    "SELECT 1 FROM cities WHERE city_id = ?", (city["city_id"],)
                ).fetchone():
                    continue
                lng, lat = to_gcj02(city["center"][0], city["center"][1], "wgs84")
                bounds = city.get("bounds")
                if bounds:
                    min_lng, min_lat = to_gcj02(bounds[0], bounds[1], "wgs84")
                    max_lng, max_lat = to_gcj02(bounds[2], bounds[3], "wgs84")
                    bounds_json = json.dumps([min_lng, min_lat, max_lng, max_lat])
                else:
                    bounds_json = None
                connection.execute(
                    """
                    INSERT INTO cities (city_id, name, name_en, center_lng, center_lat,
                                        default_zoom, bounds, source, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?)
                    """,
                    (
                        city["city_id"],
                        city["name"],
                        city.get("name_en"),
                        lng,
                        lat,
                        float(city.get("default_zoom", 12)),
                        bounds_json,
                        created_at,
                    ),
                )
                inserted_cities += 1

            # 先区、再街道、最后景点，保证 parent 已经存在。
            order = {"district": 0, "street": 1, "poi": 2}
            for region in sorted(seed_data.REGIONS, key=lambda item: order[item["level"]]):
                if connection.execute(
                    "SELECT 1 FROM regions WHERE region_id = ?", (region["region_id"],)
                ).fetchone():
                    continue
                lng, lat = to_gcj02(region["center"][0], region["center"][1], "wgs84")
                connection.execute(
                    """
                    INSERT INTO regions (region_id, city_id, parent_id, level, name, name_en,
                                         aliases, center_lng, center_lat, radius_m, area_m2,
                                         geometry, source, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'seed', ?)
                    """,
                    (
                        region["region_id"],
                        region["city_id"],
                        region.get("parent_id"),
                        region["level"],
                        region["name"],
                        region.get("name_en"),
                        _json_list(region.get("aliases")),
                        lng,
                        lat,
                        region.get("radius_m"),
                        region.get("area_m2"),
                        created_at,
                    ),
                )
                inserted_regions += 1
            connection.commit()
        return {"cities": inserted_cities, "regions": inserted_regions, "reset": reset}

    def seed_bus(self, *, reset: bool = False) -> dict:
        """幂等写入澳门巴士演示路线。不会覆盖发布过的车辆状态。"""
        created_at = utc_now()
        inserted_routes = 0
        inserted_stops = 0
        with self._session() as connection:
            if reset:
                connection.execute("DELETE FROM bus_vehicle_readings")
                connection.execute("DELETE FROM bus_vehicles")
                connection.execute("DELETE FROM bus_route_stops")
                connection.execute("DELETE FROM bus_stops")
                connection.execute("DELETE FROM bus_routes")

            for route in bus_seed_data.ROUTES:
                exists = connection.execute(
                    "SELECT 1 FROM bus_routes WHERE route_id = ?", (route["route_id"],)
                ).fetchone()
                if exists is None:
                    connection.execute(
                        """INSERT INTO bus_routes
                               (route_id, route_no, direction, origin, destination, operator,
                                color, source, active, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 'mock', 1, ?)""",
                        (
                            route["route_id"], route["route_no"], route["direction"],
                            route["origin"], route["destination"], route.get("operator"),
                            route.get("color"), created_at,
                        ),
                    )
                    inserted_routes += 1

                for sequence, stop in enumerate(route["stops"]):
                    stop_id, name, wgs_lng, wgs_lat, minutes_from_start = stop
                    if connection.execute(
                        "SELECT 1 FROM bus_stops WHERE stop_id = ?", (stop_id,)
                    ).fetchone() is None:
                        lng, lat = to_gcj02(wgs_lng, wgs_lat, "wgs84")
                        connection.execute(
                            """INSERT INTO bus_stops
                                   (stop_id, name, name_en, center_lng, center_lat, source, created_at)
                               VALUES (?, ?, NULL, ?, ?, 'mock', ?)""",
                            (stop_id, name, lng, lat, created_at),
                        )
                        inserted_stops += 1
                    connection.execute(
                        """INSERT OR IGNORE INTO bus_route_stops
                               (route_id, stop_id, stop_sequence, minutes_from_start)
                           VALUES (?, ?, ?, ?)""",
                        (route["route_id"], stop_id, sequence, minutes_from_start),
                    )
            connection.commit()
        return {
            "routes": inserted_routes,
            "stops": inserted_stops,
            "reset": reset,
        }


def _rough_distance_m(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    """够用的小尺度平面近似距离（几十米量级的去重判断，不需要 haversine）。"""
    import math

    mean_lat = math.radians((lat1 + lat2) / 2)
    dx = (lng1 - lng2) * 111_320 * math.cos(mean_lat)
    dy = (lat1 - lat2) * 110_540
    return math.hypot(dx, dy)


def _optional_float(value: Any, field: str) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValidationError(f"{field} 必须是数字") from error
    if number < 0:
        raise ValidationError(f"{field} 不能为负")
    return number


def iter_levels() -> Iterable[str]:
    return LEVELS
