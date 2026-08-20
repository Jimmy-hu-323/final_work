"""高德 Web 服务 API 客户端（只用标准库）。

**Key 只存在服务端。** 浏览器永远拿不到它：前端调用本服务的
`/api/amap/*`，由这里代为请求高德。这与主项目 `travel_planner.py` 的做法
一致（"高德 Key 只在服务端环境或 .env 中读取，不发送到浏览器"）。

需要的是**「Web服务」类型**的 Key，不是「Web端(JS API)」类型。用错类型
高德会返回 `USERKEY_PLAT_NOMATCH`（infocode 10009）。

高德返回的 `location` 已经是 GCJ-02，与本服务的入库坐标系一致，不需要转换。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

BASE = "https://restapi.amap.com/v3"

# 高德常见错误码 → 给用户看的中文解释
INFOCODE_HINTS = {
    "10001": "Key 不正确或已过期。",
    "10002": "没有权限使用相应的接口，请确认 Key 的服务权限。",
    "10003": "访问已超出日访问量。",
    "10004": "单位时间内访问过于频繁。",
    "10009": "Key 与平台类型不匹配：请创建「Web服务」类型的 Key，不能用 JS API 的 Key。",
    "10012": "权限不足，服务请求被拒绝。",
    "10021": "该 Key 未开通此服务，请在高德控制台检查。",
    "20000": "请求参数非法。",
    "20800": "规划点（起点、终点、途经点）不在中国境内。",
}


class AmapError(RuntimeError):
    """高德接口返回失败，或者本地没有配置 Key。"""


@dataclass
class AmapClient:
    key: str
    timeout: float = 8.0

    @property
    def configured(self) -> bool:
        return bool(self.key)

    def _get(self, path: str, params: dict[str, str]) -> dict:
        if not self.configured:
            raise AmapError("尚未配置高德 Key：请在 data_publish/.env 里设置 AMAP_WEB_KEY")

        query = {k: v for k, v in params.items() if v not in (None, "")}
        query["key"] = self.key
        url = f"{BASE}{path}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(url, headers={"User-Agent": "CrowdDataPublisher"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise AmapError(f"高德接口返回 HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise AmapError(f"无法连接高德接口：{error.reason}") from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise AmapError("高德返回的内容不是合法 JSON") from error

        if str(payload.get("status")) != "1":
            info = payload.get("info", "UNKNOWN")
            infocode = str(payload.get("infocode", ""))
            hint = INFOCODE_HINTS.get(infocode, "")
            raise AmapError(f"高德接口错误 {infocode} {info}。{hint}".strip())
        return payload

    # ── POI 关键字搜索 ─────────────────────────────────────────────────
    def search_poi(self, keywords: str, *, city: str = "", limit: int = 20, page: int = 1) -> list[dict]:
        payload = self._get(
            "/place/text",
            {
                "keywords": keywords,
                "city": city,
                "citylimit": "true" if city else "false",
                "offset": str(max(1, min(limit, 25))),
                "page": str(max(1, page)),
                "extensions": "base",
            },
        )
        return [_normalize_poi(poi) for poi in payload.get("pois") or [] if poi.get("location")]

    # ── 周边搜索（地图点击时找附近地点）────────────────────────────────
    def search_around(self, lng: float, lat: float, *, radius: int = 300, limit: int = 15) -> list[dict]:
        payload = self._get(
            "/place/around",
            {
                "location": f"{lng:.6f},{lat:.6f}",
                "radius": str(max(50, min(radius, 3000))),
                "offset": str(max(1, min(limit, 25))),
                "page": "1",
                "extensions": "base",
            },
        )
        return [_normalize_poi(poi) for poi in payload.get("pois") or [] if poi.get("location")]

    # ── 逆地理编码（坐标 → 地址）──────────────────────────────────────
    def regeo(self, lng: float, lat: float, *, radius: int = 200) -> dict:
        payload = self._get(
            "/geocode/regeo",
            {
                "location": f"{lng:.6f},{lat:.6f}",
                "extensions": "all",
                "radius": str(max(50, min(radius, 3000))),
            },
        )
        regeocode = payload.get("regeocode") or {}
        component = regeocode.get("addressComponent") or {}
        street_number = component.get("streetNumber") or {}
        township = _text(component.get("township"))
        street = _text(street_number.get("street"))

        return {
            "formatted_address": _text(regeocode.get("formatted_address")),
            "province": _text(component.get("province")),
            "city": _text(component.get("city")) or _text(component.get("province")),
            "district": _text(component.get("district")),
            "township": township,
            "street": street,
            "adcode": _text(component.get("adcode")),
            "citycode": _text(component.get("citycode")),
            "location": [lng, lat],
            # 附近 POI，让用户可以直接选一个真实地点而不是一串地址文字
            "nearby": [
                _normalize_poi(poi)
                for poi in (regeocode.get("pois") or [])[:12]
                if poi.get("location")
            ],
        }


def _text(value) -> str:
    """高德对空字段返回 [] 而不是 ""，统一成字符串。"""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return " ".join(str(item) for item in value if isinstance(item, str)).strip()
    return "" if value is None else str(value).strip()


def _normalize_poi(poi: dict) -> dict:
    raw = _text(poi.get("location"))
    lng, _, lat = raw.partition(",")
    try:
        center = [float(lng), float(lat)]
    except ValueError:
        center = None
    return {
        "amap_id": _text(poi.get("id")),
        "name": _text(poi.get("name")),
        "address": _text(poi.get("address")),
        "type": _text(poi.get("type")),
        "typecode": _text(poi.get("typecode")),
        "province": _text(poi.get("pname")),
        "city": _text(poi.get("cityname")) or _text(poi.get("pname")),
        "district": _text(poi.get("adname")),
        "adcode": _text(poi.get("adcode")),
        "distance": _text(poi.get("distance")),
        "center": center,
        "coord_system": "gcj02",
    }
