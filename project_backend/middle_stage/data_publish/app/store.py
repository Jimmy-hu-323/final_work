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

from . import seed_data
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
