"""坐标系转换。

主项目（LensGo × QwenPaw）的地图底图用的是高德栅格瓦片，属于 GCJ-02；
TravelPlanner 页面里存的坐标也是 GCJ-02 的 "lng,lat"。所以本发布器把
**GCJ-02 作为唯一入库坐标系**，任何来源于 OSM / GPS / 官方开放数据的
WGS-84 坐标都必须在写库前转换，否则在高德底图上会整体偏移 300~600 米。
"""

from __future__ import annotations

import math

# 克拉索夫斯基椭球参数，GCJ-02 加偏算法使用
_A = 6378245.0
_EE = 0.00669342162296594323


def out_of_china(lng: float, lat: float) -> bool:
    """粗略判断是否在 GCJ-02 加偏范围外。港澳在范围内，同样需要转换。"""
    return not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lng: float, lat: float) -> tuple[float, float]:
    """WGS-84（GPS / OSM）→ GCJ-02（高德、腾讯）。"""
    if out_of_china(lng, lat):
        return lng, lat
    d_lat = _transform_lat(lng - 105.0, lat - 35.0)
    d_lng = _transform_lng(lng - 105.0, lat - 35.0)
    rad_lat = lat / 180.0 * math.pi
    magic = math.sin(rad_lat)
    magic = 1 - _EE * magic * magic
    sqrt_magic = math.sqrt(magic)
    d_lat = (d_lat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrt_magic) * math.pi)
    d_lng = (d_lng * 180.0) / (_A / sqrt_magic * math.cos(rad_lat) * math.pi)
    return lng + d_lng, lat + d_lat


def gcj02_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    """GCJ-02 → WGS-84。用一次反向偏移近似，误差在米级，够用。"""
    if out_of_china(lng, lat):
        return lng, lat
    offset_lng, offset_lat = wgs84_to_gcj02(lng, lat)
    return lng * 2 - offset_lng, lat * 2 - offset_lat


def to_gcj02(lng: float, lat: float, coord_system: str) -> tuple[float, float]:
    """按声明的坐标系统一转成 GCJ-02。"""
    system = (coord_system or "gcj02").strip().lower()
    if system in ("gcj02", "gcj-02", "amap"):
        return lng, lat
    if system in ("wgs84", "wgs-84", "gps"):
        return wgs84_to_gcj02(lng, lat)
    raise ValueError(f"unsupported coord_system: {coord_system}")
