"""HTTP 层：标准库 http.server 实现的 JSON API + 静态页面。

刻意不引入 FastAPI —— 这台机器上没有安装，而发布器应该 `python run.py`
就能跑。业务逻辑全在 store.py，以后要换框架或并入主项目，改这一层即可。
"""

from __future__ import annotations

import json
import re
import traceback
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .amap import AmapClient, AmapError
from .auth import AuthError, AuthService, Principal, ROLES, SCOPES
from .config import (
    CROWD_LEVEL_LABELS,
    CROWD_THRESHOLDS,
    LEVEL_LABELS,
    LEVELS,
    Config,
    WEB_DIR,
)
from .store import NotFoundError, Store, ValidationError

MAX_BODY_BYTES = 4 * 1024 * 1024

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Route:
    __slots__ = ("method", "pattern", "handler", "scope", "public")

    def __init__(
        self, method: str, pattern: str, handler: str,
        scope: str | None = None, *, public: bool = False,
    ):
        self.method = method
        # /api/regions/{region_id} → 命名分组
        regex = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern)
        self.pattern = re.compile(f"^{regex}$")
        self.handler = handler
        self.scope = scope
        self.public = public


ROUTES: list[Route] = [
    Route("GET", "/api/health", "health", public=True),
    Route("POST", "/api/auth/login", "login", public=True),
    Route("POST", "/api/auth/logout", "logout"),
    Route("GET", "/api/auth/me", "me"),
    Route("GET", "/api/auth/key-info", "key_info"),
    Route("GET", "/api/meta", "meta", "crowd:read"),
    Route("GET", "/api/cities", "list_cities", "crowd:read"),
    Route("POST", "/api/cities", "create_city", "crowd:regions:write"),
    Route("GET", "/api/cities/{city_id}", "get_city", "crowd:read"),
    Route("GET", "/api/regions", "search_regions", "crowd:read"),
    Route("POST", "/api/regions", "create_region", "crowd:regions:write"),
    Route("GET", "/api/regions/{region_id}", "get_region", "crowd:read"),
    Route("GET", "/api/regions/{region_id}/history", "region_history", "crowd:read"),
    Route("POST", "/api/regions/from-amap", "region_from_amap", "crowd:regions:write"),
    Route("GET", "/api/amap/status", "amap_status", "crowd:amap:use"),
    Route("GET", "/api/amap/search", "amap_search", "crowd:amap:use"),
    Route("GET", "/api/amap/around", "amap_around", "crowd:amap:use"),
    Route("GET", "/api/amap/regeo", "amap_regeo", "crowd:amap:use"),
    Route("GET", "/api/density/latest", "latest_density", "crowd:read"),
    Route("POST", "/api/readings", "publish", "crowd:publish"),
    Route("GET", "/api/bus/routes", "bus_routes", "crowd:read"),
    Route("GET", "/api/bus/routes/{route_id}", "bus_route", "crowd:read"),
    Route("GET", "/api/bus/vehicles", "bus_vehicles", "crowd:read"),
    Route("POST", "/api/bus/vehicles", "bus_publish_vehicle", "crowd:publish"),
    Route("GET", "/api/bus/stops/{stop_id}/arrivals", "bus_arrivals", "crowd:read"),
    Route("GET", "/api/batches", "list_batches", "crowd:read"),
    Route("GET", "/api/batches/{batch_id}", "get_batch", "crowd:read"),
    Route("DELETE", "/api/batches/{batch_id}", "revert_batch", "crowd:batches:revert"),
    Route("GET", "/api/admin/users", "admin_list_users", "crowd:admin"),
    Route("POST", "/api/admin/users", "admin_create_user", "crowd:admin"),
    Route("PATCH", "/api/admin/users/{user_id}", "admin_update_user", "crowd:admin"),
    Route("GET", "/api/admin/api-keys", "admin_list_api_keys", "crowd:admin"),
    Route("POST", "/api/admin/api-keys", "admin_create_api_key", "crowd:admin"),
    Route("POST", "/api/admin/api-keys/{key_id}/revoke", "admin_revoke_api_key", "crowd:admin"),
    Route("GET", "/api/admin/audit", "admin_audit", "crowd:admin"),
]


def make_handler(config: Config, store: Store) -> type[BaseHTTPRequestHandler]:
    auth = AuthService(
        config.db_path,
        auth_mode=config.auth_mode,
        write_token=config.write_token,
        read_token=config.read_token,
        session_ttl_seconds=config.session_ttl_seconds,
        session_idle_seconds=config.session_idle_seconds,
        login_max_failures=config.login_max_failures,
        login_window_seconds=config.login_window_seconds,
        auth_pepper=config.auth_pepper,
        api_key_touch_seconds=config.api_key_touch_seconds,
    )
    amap = AmapClient(key=config.amap_key, timeout=config.amap_timeout)

    class Handler(BaseHTTPRequestHandler):
        server_version = f"CrowdDataPublisher/{__version__}"
        protocol_version = "HTTP/1.1"

        # ── 基础工具 ────────────────────────────────────────────────────
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            print(f"[{self.log_date_time_string()}] {self.address_string()} {format % args}")

        @property
        def client_ip(self) -> str:
            return self.client_address[0] if self.client_address else ""

        def _cors_headers(self) -> None:
            configured = [item.strip() for item in config.cors_origins.split(",") if item.strip()]
            request_origin = (self.headers.get("Origin") or "").strip()
            if "*" in configured:
                self.send_header("Access-Control-Allow-Origin", "*")
            elif request_origin and request_origin in configured:
                self.send_header("Access-Control-Allow-Origin", request_origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization, X-Crowd-Token, X-CSRF-Token",
            )
            self.send_header("Access-Control-Expose-Headers", "X-Request-ID")
            self.send_header("Access-Control-Max-Age", "600")

        def _send(
            self, status: int, body: bytes, content_type: str,
            headers: list[tuple[str, str]] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if getattr(self, "request_id", None):
                self.send_header("X-Request-ID", self.request_id)
            for name, value in headers or []:
                self.send_header(name, value)
            self._cors_headers()
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def send_json(
            self, status: int, payload: object,
            headers: list[tuple[str, str]] | None = None,
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8", headers)

        def send_error_json(self, status: int, message: str) -> None:
            # 出错时请求体可能还没读完（例如鉴权失败提前返回）。HTTP/1.1 复用
            # 连接时，残留的字节会被当成下一个请求的报文头，所以直接断开。
            self.close_connection = True
            self.send_json(status, {"error": message, "status": status})

        def presented_token(self) -> str:
            header = self.headers.get("Authorization", "")
            if header.lower().startswith("bearer "):
                return header[7:].strip()
            return (self.headers.get("X-Crowd-Token") or "").strip()

        def cookie_value(self, name: str) -> str:
            try:
                cookie = SimpleCookie(self.headers.get("Cookie") or "")
                return cookie[name].value if name in cookie else ""
            except Exception:  # malformed Cookie header
                return ""

        def _cookie_header(self, name: str, value: str, max_age: int, *, http_only: bool) -> str:
            parts = [f"{name}={value}", "Path=/", "SameSite=Lax", f"Max-Age={max_age}"]
            if http_only:
                parts.append("HttpOnly")
            if config.session_cookie_secure:
                parts.append("Secure")
            return "; ".join(parts)

        def _clear_auth_cookies(self) -> list[tuple[str, str]]:
            return [
                ("Set-Cookie", self._cookie_header(config.session_cookie_name, "", 0, http_only=True)),
                ("Set-Cookie", self._cookie_header("crowd_csrf", "", 0, http_only=False)),
            ]

        def _validate_session_origin(self) -> None:
            raw = (self.headers.get("Origin") or self.headers.get("Referer") or "").strip()
            if not raw:
                raise AuthError("网页登录写请求必须提供 Origin 或 Referer", 403)
            parsed = urlparse(raw)
            source_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
            host = (self.headers.get("Host") or "").lower()
            if source_origin and parsed.netloc.lower() == host:
                return
            allowed = {
                item.strip().rstrip("/") for item in config.cors_origins.split(",")
                if item.strip() and item.strip() != "*"
            }
            if source_origin not in allowed:
                raise AuthError("请求来源不在允许列表中", 403)

        def _redirect(self, location: str) -> None:
            self._send(302, b"", "text/plain; charset=utf-8", [("Location", location)])

        def read_json_body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            if length > MAX_BODY_BYTES:
                raise ValidationError("请求体过大")
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValidationError(f"请求体不是合法 JSON: {error}") from error
            if not isinstance(payload, dict):
                raise ValidationError("请求体必须是 JSON 对象")
            return payload

        # ── 分发 ────────────────────────────────────────────────────────
        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def do_PATCH(self) -> None:  # noqa: N802
            self._dispatch("PATCH")

        def _dispatch(self, method: str) -> None:
            self.request_id = "req_" + uuid.uuid4().hex[:16]
            self.principal: Principal | None = None
            parsed = urlparse(self.path)
            path = unquote(parsed.path).rstrip("/") or "/"
            self.query = {
                key: values[0] for key, values in parse_qs(parsed.query, keep_blank_values=True).items()
            }

            if not path.startswith("/api"):
                if method != "GET":
                    self.send_error_json(405, f"不支持的方法: {method}")
                    return
                public_static = (
                    path in ("/login.html", "/login.js", "/styles.css", "/favicon.ico")
                    or path.startswith("/vendor/")
                )
                if not public_static:
                    try:
                        auth.authenticate_session(self.cookie_value(config.session_cookie_name))
                    except AuthError:
                        if path in ("/", "/index.html"):
                            self._redirect("/login.html")
                        else:
                            self.send_error_json(401, "需要登录")
                        return
                self._serve_static(path)
                return

            for route in ROUTES:
                if route.method != method:
                    continue
                match = route.pattern.match(path)
                if not match:
                    continue
                try:
                    if not route.public:
                        self.principal = auth.authenticate(
                            self.presented_token(),
                            self.cookie_value(config.session_cookie_name),
                            self.client_ip,
                        )
                        auth.require_scope(self.principal, route.scope)
                        if method in ("POST", "PATCH", "DELETE"):
                            auth.validate_csrf(
                                self.principal, (self.headers.get("X-CSRF-Token") or "").strip()
                            )
                            if self.principal.actor_type == "session":
                                self._validate_session_origin()
                    handler: Callable[..., None] = getattr(self, f"api_{route.handler}")
                    handler(**match.groupdict())
                    if method in ("POST", "PATCH", "DELETE") and route.handler != "login":
                        auth.audit(
                            self.principal, f"http.{method.lower()}", path, "success",
                            request_id=self.request_id, client_ip=self.client_ip,
                            user_agent=self.headers.get("User-Agent", ""),
                        )
                except AuthError as error:
                    self._audit_failure(method, path, str(error))
                    self.send_error_json(error.status, str(error))
                except (ValidationError, ValueError) as error:
                    self._audit_failure(method, path, str(error))
                    self.send_error_json(400, str(error))
                except NotFoundError as error:
                    self.send_error_json(404, str(error))
                except AmapError as error:
                    # 上游（高德）问题或未配置 Key，不是本服务的错误
                    self.send_error_json(502, str(error))
                except Exception:  # noqa: BLE001 - 兜底，避免线程里静默崩溃
                    traceback.print_exc()
                    self.send_error_json(500, "服务内部错误，详见服务端日志")
                return

            self.send_error_json(404, f"未知接口: {method} {path}")

        def _audit_failure(self, method: str, path: str, message: str) -> None:
            if method not in ("POST", "PATCH", "DELETE") or path == "/api/auth/login":
                return
            try:
                auth.audit(
                    self.principal, f"http.{method.lower()}", path, "denied",
                    request_id=self.request_id, details={"reason": message[:200]},
                    client_ip=self.client_ip, user_agent=self.headers.get("User-Agent", ""),
                )
            except Exception:
                traceback.print_exc()

        # ── 静态资源 ────────────────────────────────────────────────────
        def _serve_static(self, path: str) -> None:
            relative = "index.html" if path == "/" else path.lstrip("/")
            target = (WEB_DIR / relative).resolve()
            try:
                target.relative_to(WEB_DIR.resolve())
            except ValueError:
                self.send_error_json(403, "非法路径")
                return
            if not target.is_file():
                self.send_error_json(404, "页面不存在")
                return
            content_type = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
            self._send(200, target.read_bytes(), content_type)

        # ── 接口实现 ────────────────────────────────────────────────────
        def api_health(self) -> None:
            self.send_json(200, {"status": "ok"})

        def api_login(self) -> None:
            payload = self.read_json_body()
            username = str(payload.get("username") or "")
            password = str(payload.get("password") or "")
            result, session_token = auth.login(
                username, password, self.client_ip, self.headers.get("User-Agent", "")
            )
            csrf_token = result["csrf_token"]
            headers = [
                (
                    "Set-Cookie",
                    self._cookie_header(
                        config.session_cookie_name, session_token,
                        config.session_ttl_seconds, http_only=True,
                    ),
                ),
                (
                    "Set-Cookie",
                    self._cookie_header(
                        "crowd_csrf", csrf_token,
                        config.session_ttl_seconds, http_only=False,
                    ),
                ),
            ]
            self.send_json(200, result, headers)

        def api_logout(self) -> None:
            assert self.principal is not None
            auth.logout(self.principal)
            self.send_json(200, {"ok": True}, self._clear_auth_cookies())

        def api_me(self) -> None:
            assert self.principal is not None
            result = self.principal.public()
            if self.principal.actor_type == "session" and self.principal.user_id:
                result["user"] = auth.get_user(self.principal.user_id)
                csrf_token = self.cookie_value("crowd_csrf")
                try:
                    auth.validate_csrf(self.principal, csrf_token)
                except AuthError:
                    csrf_token = None
                result["csrf_token"] = csrf_token
            self.send_json(200, result)

        def api_key_info(self) -> None:
            assert self.principal is not None
            self.send_json(200, self.principal.public())

        def api_meta(self) -> None:
            self.send_json(
                200,
                {
                    "levels": list(LEVELS),
                    "level_labels": LEVEL_LABELS,
                    "crowd_level_labels": CROWD_LEVEL_LABELS,
                    "crowd_thresholds": CROWD_THRESHOLDS,
                    "coord_system": "gcj02",
                    "bus": {
                        "source": "mock",
                        "status_labels": {
                            "running": "行驶中",
                            "at_stop": "停站中",
                            "paused": "模拟已暂停",
                            "out_of_service": "已停止服务",
                        },
                        "occupancy_labels": ["空闲", "较少", "适中", "拥挤", "非常拥挤"],
                        "disclaimer": "模拟数据，仅用于 LensGo 功能演示，不可作为实际乘车依据。",
                    },
                    "auth": {
                        "mode": config.auth_mode,
                        "principal": self.principal.public() if self.principal else None,
                    },
                },
            )

        def api_list_cities(self) -> None:
            self.send_json(200, {"items": store.list_cities(self.query.get("q", "").strip())})

        def api_get_city(self, city_id: str) -> None:
            self.send_json(200, store.get_city(city_id))

        def api_create_city(self) -> None:
            self.send_json(201, store.create_city(self.read_json_body()))

        def api_search_regions(self) -> None:
            result = store.search_regions(
                city_id=self.query.get("city_id", "").strip(),
                level=self.query.get("level", "").strip(),
                parent_id=self.query.get("parent_id", "").strip(),
                q=self.query.get("q", "").strip(),
                limit=_int_param(self.query.get("limit"), 100),
                offset=_int_param(self.query.get("offset"), 0),
            )
            self.send_json(200, result)

        def api_get_region(self, region_id: str) -> None:
            self.send_json(200, store.get_region(region_id))

        def api_create_region(self) -> None:
            self.send_json(201, store.create_region(self.read_json_body()))

        def api_region_history(self, region_id: str) -> None:
            self.send_json(
                200, store.region_history(region_id, _int_param(self.query.get("limit"), 50))
            )

        # ── 高德代理（Key 只留在服务端）──────────────────────────────
        def api_amap_status(self) -> None:
            self.send_json(
                200,
                {
                    "configured": amap.configured,
                    "hint": (
                        "已配置高德 Web 服务 Key"
                        if amap.configured
                        else "未配置：在 data_publish/.env 里设置 AMAP_WEB_KEY 后重启服务"
                    ),
                },
            )

        def api_amap_search(self) -> None:
            keywords = self.query.get("q", "").strip()
            if not keywords:
                raise ValidationError("缺少搜索关键词 q")
            items = amap.search_poi(
                keywords,
                city=self.query.get("city", "").strip(),
                limit=_int_param(self.query.get("limit"), 20),
                page=_int_param(self.query.get("page"), 1),
            )
            self.send_json(200, {"count": len(items), "items": items})

        def api_amap_around(self) -> None:
            lng, lat = _require_lnglat(self.query)
            items = amap.search_around(
                lng,
                lat,
                radius=_int_param(self.query.get("radius"), 300),
                limit=_int_param(self.query.get("limit"), 15),
            )
            self.send_json(200, {"count": len(items), "items": items})

        def api_amap_regeo(self) -> None:
            lng, lat = _require_lnglat(self.query)
            self.send_json(
                200, amap.regeo(lng, lat, radius=_int_param(self.query.get("radius"), 200))
            )

        def api_region_from_amap(self) -> None:
            result = store.upsert_amap_region(self.read_json_body())
            self.send_json(201 if result.get("created") else 200, result)

        def api_latest_density(self) -> None:
            include_empty = self.query.get("include_empty", "1").lower() not in ("0", "false", "no")
            self.send_json(
                200,
                store.latest_density(
                    city_id=self.query.get("city_id", "").strip(),
                    level=self.query.get("level", "").strip(),
                    include_empty=include_empty,
                ),
            )

        def api_publish(self) -> None:
            self.send_json(201, store.publish(self.read_json_body()))

        # ── 模拟巴士报站 ──────────────────────────────────────────────
        def api_bus_routes(self) -> None:
            self.send_json(200, store.list_bus_routes())

        def api_bus_route(self, route_id: str) -> None:
            self.send_json(200, store.list_bus_routes(route_id=route_id))

        def api_bus_vehicles(self) -> None:
            include_inactive = self.query.get("include_inactive", "0").lower() in (
                "1", "true", "yes",
            )
            self.send_json(
                200,
                store.list_bus_vehicles(
                    route_id=self.query.get("route_id", "").strip(),
                    include_inactive=include_inactive,
                ),
            )

        def api_bus_publish_vehicle(self) -> None:
            self.send_json(201, store.publish_bus_vehicle(self.read_json_body()))

        def api_bus_arrivals(self, stop_id: str) -> None:
            self.send_json(
                200,
                store.bus_arrivals(
                    stop_id, route_id=self.query.get("route_id", "").strip()
                ),
            )

        def api_list_batches(self) -> None:
            self.send_json(
                200, {"items": store.list_batches(_int_param(self.query.get("limit"), 50))}
            )

        def api_get_batch(self, batch_id: str) -> None:
            self.send_json(200, store.get_batch(batch_id))

        def api_revert_batch(self, batch_id: str) -> None:
            self.send_json(200, store.revert_batch(batch_id))

        # ── 管理接口 ──────────────────────────────────────────────────
        def api_admin_list_users(self) -> None:
            self.send_json(200, {"items": auth.list_users()})

        def api_admin_create_user(self) -> None:
            payload = self.read_json_body()
            user = auth.create_user(
                str(payload.get("username") or ""),
                str(payload.get("password") or ""),
                str(payload.get("role") or "viewer"),
                display_name=str(payload.get("display_name") or ""),
            )
            self.send_json(201, user)

        def api_admin_update_user(self, user_id: str) -> None:
            self.send_json(200, auth.update_user(user_id, self.read_json_body()))

        def api_admin_list_api_keys(self) -> None:
            self.send_json(200, {"items": auth.list_api_keys()})

        def api_admin_create_api_key(self) -> None:
            assert self.principal is not None
            payload = self.read_json_body()
            scopes = payload.get("scopes")
            if not isinstance(scopes, list) or not all(isinstance(item, str) for item in scopes):
                raise ValidationError("scopes 必须是字符串数组")
            created = auth.create_api_key(
                name=str(payload.get("name") or ""), scopes=scopes,
                created_by=self.principal.user_id,
                expires_at=str(payload["expires_at"]) if payload.get("expires_at") else None,
            )
            complete = created.pop("api_key")
            self.send_json(201, {"api_key": complete, "key": created})

        def api_admin_revoke_api_key(self, key_id: str) -> None:
            # 读取空 JSON，使 HTTP/1.1 请求体不残留。
            self.read_json_body()
            self.send_json(200, {"key": auth.revoke_api_key(key_id)})

        def api_admin_audit(self) -> None:
            self.send_json(
                200,
                {
                    "items": auth.list_audit(
                        _int_param(self.query.get("limit"), 100),
                        _int_param(self.query.get("offset"), 0),
                    )
                },
            )

    return Handler


def _require_lnglat(query: dict[str, str]) -> tuple[float, float]:
    try:
        lng = float(query["lng"])
        lat = float(query["lat"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValidationError("需要合法的 lng 与 lat 参数") from error
    if not -180 <= lng <= 180 or not -90 <= lat <= 90:
        raise ValidationError("坐标超出合法范围")
    return lng, lat


def _int_param(raw: str | None, default: int) -> int:
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except (TypeError, ValueError) as error:
        raise ValidationError(f"参数必须是整数: {raw}") from error


def serve(config: Config, store: Store) -> None:
    handler = make_handler(config, store)
    httpd = ThreadingHTTPServer((config.host, config.port), handler)
    httpd.daemon_threads = True
    shown_host = "127.0.0.1" if config.host in ("0.0.0.0", "::") else config.host
    print()
    print("  人流密度数据发布器已启动")
    print(f"    发布页面 : http://{shown_host}:{config.port}/")
    print(f"    API 根   : http://{shown_host}:{config.port}/api/health")
    print(f"    数据库   : {config.db_path}")
    if config.amap_key:
        print(f"    高德 Key  : 已配置（{config.amap_key[:4]}…，只在服务端使用）")
    else:
        print("    高德 Key  : 未配置，地图搜索/逆地理编码不可用")
        print("               在 data_publish/.env 里设置 AMAP_WEB_KEY 后重启即可")
    if config.write_token:
        print("    写入鉴权 : 已启用（需要 Authorization: Bearer <CROWD_WRITE_TOKEN>）")
    else:
        print("    写入鉴权 : 未设置令牌，仅允许本机写入")
        if config.host not in ("127.0.0.1", "localhost", "::1"):
            print("    [!] 服务绑定在非回环地址，建议设置 CROWD_WRITE_TOKEN 后再对外开放")
    print("  按 Ctrl+C 停止")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止...")
    finally:
        httpd.server_close()


# WEB_DIR 在 config 中定义，这里再导出一次方便测试引用。
__all__ = ["serve", "make_handler", "WEB_DIR", "Path"]
