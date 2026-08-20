"""账号会话、API Key、权限与审计（仅 Python 标准库）。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .db import connect

ROLES = ("admin", "publisher", "reviewer", "viewer")
SCOPES = (
    "crowd:read",
    "crowd:publish",
    "crowd:regions:write",
    "crowd:batches:revert",
    "crowd:admin",
    "crowd:amap:use",
)
ROLE_SCOPES: dict[str, frozenset[str]] = {
    "admin": frozenset(SCOPES),
    "publisher": frozenset(("crowd:read", "crowd:publish", "crowd:regions:write", "crowd:amap:use")),
    "reviewer": frozenset(("crowd:read", "crowd:batches:revert")),
    "viewer": frozenset(("crowd:read",)),
}
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")
API_KEY_RE = re.compile(r"^lgc_live_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{32,})$")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_text(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat(timespec="seconds")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("密码至少需要 10 个字符")
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$16384$8$1${}${}".format(
        base64.urlsafe_b64encode(salt).decode("ascii").rstrip("="),
        base64.urlsafe_b64encode(derived).decode("ascii").rstrip("="),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n_raw, r_raw, p_raw, salt_raw, hash_raw = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_raw + "=" * (-len(salt_raw) % 4))
        expected = base64.urlsafe_b64decode(hash_raw + "=" * (-len(hash_raw) % 4))
        actual = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=int(n_raw), r=int(r_raw),
            p=int(p_raw), dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


class AuthError(PermissionError):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Principal:
    actor_type: str
    actor_id: str
    display_name: str
    scopes: frozenset[str]
    role: str | None = None
    user_id: str | None = None
    csrf_hash: str | None = None
    expires_at: str | None = None

    def public(self) -> dict[str, Any]:
        return {
            "actor_type": self.actor_type,
            "actor_id": self.actor_id,
            "display_name": self.display_name,
            "role": self.role,
            "scopes": sorted(self.scopes),
            "expires_at": self.expires_at,
        }


class AuthService:
    def __init__(
        self, db_path: Path, *, auth_mode: str = "required", write_token: str = "",
        read_token: str = "", session_ttl_seconds: int = 28800,
        session_idle_seconds: int = 1800, login_max_failures: int = 5,
        login_window_seconds: int = 900, auth_pepper: str,
        api_key_touch_seconds: int = 60,
    ):
        if len(auth_pepper.encode("utf-8")) < 32:
            raise ValueError("CROWD_AUTH_PEPPER 至少需要 32 字节随机值")
        self.db_path = db_path
        self.auth_mode = auth_mode
        self.write_token = write_token
        self.read_token = read_token
        self.session_ttl_seconds = session_ttl_seconds
        self.session_idle_seconds = session_idle_seconds
        self.login_max_failures = login_max_failures
        self.login_window_seconds = login_window_seconds
        self._pepper = auth_pepper.encode("utf-8")
        self.api_key_touch_seconds = api_key_touch_seconds

    def _digest(self, value: str) -> str:
        return hmac.new(self._pepper, value.encode("utf-8"), hashlib.sha256).hexdigest()

    def user_count(self) -> int:
        with connect(self.db_path) as connection:
            return int(connection.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def create_initial_admin(self, username: str, password: str, display_name: str = "") -> dict:
        if self.user_count():
            raise ValueError("数据库中已有账号；初始管理员只能在账号表为空时创建")
        return self.create_user(username, password, "admin", display_name=display_name)

    def create_user(
        self, username: str, password: str, role: str, *, display_name: str = ""
    ) -> dict:
        username = username.strip()
        if not USERNAME_RE.fullmatch(username):
            raise ValueError("用户名需为 3-64 位字母、数字、点、下划线或连字符")
        if role not in ROLES:
            raise ValueError(f"未知角色: {role}")
        user_id = "usr_" + uuid.uuid4().hex[:16]
        now = utc_text()
        try:
            with connect(self.db_path) as connection:
                connection.execute(
                    """INSERT INTO users
                       (user_id, username, display_name, password_hash, role, active,
                        created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)""",
                    (user_id, username, display_name.strip() or None, hash_password(password), role, now, now),
                )
        except sqlite3.IntegrityError as error:
            raise ValueError("用户名已存在") from error
        return self.get_user(user_id)

    def get_user(self, user_id: str) -> dict:
        with connect(self.db_path) as connection:
            row = connection.execute(
                """SELECT user_id, username, display_name, role, active, created_at,
                          updated_at, last_login_at FROM users WHERE user_id = ?""",
                (user_id,),
            ).fetchone()
        if row is None:
            raise ValueError("用户不存在")
        result = dict(row)
        result["active"] = bool(result["active"])
        result["scopes"] = sorted(ROLE_SCOPES[result["role"]])
        return result

    def list_users(self) -> list[dict]:
        with connect(self.db_path) as connection:
            rows = connection.execute(
                """SELECT user_id, username, display_name, role, active, created_at,
                          updated_at, last_login_at FROM users ORDER BY username COLLATE NOCASE"""
            ).fetchall()
        return [{**dict(row), "active": bool(row["active"]), "scopes": sorted(ROLE_SCOPES[row["role"]])} for row in rows]

    def update_user(self, user_id: str, payload: dict[str, Any]) -> dict:
        allowed: dict[str, Any] = {}
        if "display_name" in payload:
            allowed["display_name"] = str(payload["display_name"] or "").strip() or None
        if "role" in payload:
            role = str(payload["role"])
            if role not in ROLES:
                raise ValueError(f"未知角色: {role}")
            allowed["role"] = role
        if "active" in payload:
            allowed["active"] = int(bool(payload["active"]))
        password_changed = False
        if payload.get("password"):
            allowed["password_hash"] = hash_password(str(payload["password"]))
            password_changed = True
        if not allowed:
            raise ValueError("没有可更新的字段")
        allowed["updated_at"] = utc_text()
        values = list(allowed.values()) + [user_id]
        with connect(self.db_path) as connection:
            cursor = connection.execute(
                "UPDATE users SET " + ", ".join(f"{name} = ?" for name in allowed) + " WHERE user_id = ?", values,
            )
            if cursor.rowcount != 1:
                raise ValueError("用户不存在")
            if password_changed or allowed.get("active") == 0:
                connection.execute(
                    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (utc_text(), user_id),
                )
        return self.get_user(user_id)

    def _blocked(self, username: str, client_ip: str) -> bool:
        cutoff = utc_text(utc_now() - timedelta(seconds=self.login_window_seconds))
        with connect(self.db_path) as connection:
            row = connection.execute(
                """SELECT COUNT(*) FROM login_attempts
                   WHERE username = ? COLLATE NOCASE AND IFNULL(client_ip, '') = ?
                     AND success = 0 AND attempted_at >= ?""",
                (username, client_ip, cutoff),
            ).fetchone()
        return int(row[0]) >= self.login_max_failures

    def login(self, username: str, password: str, client_ip: str, user_agent: str) -> tuple[dict, str]:
        username = username.strip()
        if self._blocked(username, client_ip):
            raise AuthError("登录失败次数过多，请稍后再试", 429)
        with connect(self.db_path) as connection:
            row = connection.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
        valid = row is not None and bool(row["active"]) and verify_password(password, row["password_hash"])
        with connect(self.db_path) as connection:
            connection.execute(
                "INSERT INTO login_attempts (username, client_ip, success, attempted_at) VALUES (?, ?, ?, ?)",
                (username, client_ip, int(valid), utc_text()),
            )
        if not valid:
            self.audit(None, "auth.login", username, "denied", client_ip=client_ip, user_agent=user_agent)
            raise AuthError("用户名或密码错误", 401)
        session_id = "ses_" + uuid.uuid4().hex[:16]
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        now = utc_now()
        expires = now + timedelta(seconds=self.session_ttl_seconds)
        with connect(self.db_path) as connection:
            connection.execute(
                """INSERT INTO sessions
                   (session_id, token_hash, csrf_hash, user_id, created_at, expires_at,
                    last_seen_at, client_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (session_id, self._digest(token), self._digest(csrf), row["user_id"], utc_text(now), utc_text(expires), utc_text(now), client_ip, user_agent[:500]),
            )
            connection.execute(
                "UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?",
                (utc_text(now), utc_text(now), row["user_id"]),
            )
        principal = Principal(
            "session", session_id, row["display_name"] or row["username"], ROLE_SCOPES[row["role"]],
            row["role"], row["user_id"], self._digest(csrf), utc_text(expires),
        )
        self.audit(principal, "auth.login", row["user_id"], "success", client_ip=client_ip, user_agent=user_agent)
        return {"user": self.get_user(row["user_id"]), "csrf_token": csrf, "expires_at": utc_text(expires)}, token

    def authenticate_session(self, token: str) -> Principal:
        if not token:
            raise AuthError("需要登录或提供 API Key")
        now_dt = utc_now()
        now = utc_text(now_dt)
        idle_cutoff = utc_text(now_dt - timedelta(seconds=self.session_idle_seconds))
        with connect(self.db_path) as connection:
            row = connection.execute(
                """SELECT s.*, u.username, u.display_name, u.role, u.active
                   FROM sessions s JOIN users u ON u.user_id = s.user_id
                   WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
                     AND s.last_seen_at > ?""",
                (self._digest(token), now, idle_cutoff),
            ).fetchone()
            if row is not None and bool(row["active"]):
                connection.execute("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?", (now, row["session_id"]))
        if row is None or not bool(row["active"]):
            raise AuthError("登录会话无效或已过期")
        return Principal(
            "session", row["session_id"], row["display_name"] or row["username"], ROLE_SCOPES[row["role"]],
            row["role"], row["user_id"], row["csrf_hash"], row["expires_at"],
        )

    def logout(self, principal: Principal) -> None:
        if principal.actor_type != "session":
            raise AuthError("退出登录只适用于网页登录会话", 403)
        with connect(self.db_path) as connection:
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL", (utc_text(), principal.actor_id),
            )

    def validate_csrf(self, principal: Principal, presented: str) -> None:
        if principal.actor_type != "session":
            return
        if not presented or not principal.csrf_hash or not hmac.compare_digest(self._digest(presented), principal.csrf_hash):
            raise AuthError("CSRF Token 无效，请重新登录", 403)

    def create_api_key(
        self, *, name: str, scopes: Iterable[str], created_by: str | None, expires_at: str | None = None,
    ) -> dict:
        name = name.strip()
        if not name or len(name) > 120:
            raise ValueError("API Key 名称不能为空且不能超过 120 字符")
        normalized = sorted(set(scopes))
        invalid = set(normalized) - set(SCOPES)
        if invalid or not normalized:
            raise ValueError("scopes 必须是至少一个已知权限")
        expiry = parse_time(expires_at)
        if expiry is not None and expiry <= utc_now():
            raise ValueError("expires_at 必须晚于当前时间")
        key_id = secrets.token_hex(6)
        secret = secrets.token_urlsafe(32)
        complete = f"lgc_live_{key_id}_{secret}"
        now = utc_text()
        with connect(self.db_path) as connection:
            connection.execute(
                """INSERT INTO api_keys
                   (key_id, name, key_prefix, key_hash, scopes, created_by, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (key_id, name, f"lgc_live_{key_id}_", self._digest(complete), json.dumps(normalized, ensure_ascii=False), created_by, now, utc_text(expiry) if expiry else None),
            )
        return {**self.get_api_key(key_id), "api_key": complete}

    @staticmethod
    def _api_key_public(row: sqlite3.Row) -> dict:
        result = dict(row)
        result["scopes"] = json.loads(result["scopes"])
        expiry = parse_time(result["expires_at"])
        result["status"] = "revoked" if result["revoked_at"] else "expired" if expiry and expiry <= utc_now() else "active"
        return result

    def get_api_key(self, key_id: str) -> dict:
        with connect(self.db_path) as connection:
            row = connection.execute(
                """SELECT k.key_id, k.name, k.key_prefix, k.scopes, k.created_by,
                          u.username AS created_by_username, k.created_at, k.expires_at,
                          k.last_used_at, k.last_used_ip, k.revoked_at
                   FROM api_keys k LEFT JOIN users u ON u.user_id = k.created_by WHERE k.key_id = ?""",
                (key_id,),
            ).fetchone()
        if row is None:
            raise ValueError("API Key 不存在")
        return self._api_key_public(row)

    def list_api_keys(self) -> list[dict]:
        with connect(self.db_path) as connection:
            rows = connection.execute(
                """SELECT k.key_id, k.name, k.key_prefix, k.scopes, k.created_by,
                          u.username AS created_by_username, k.created_at, k.expires_at,
                          k.last_used_at, k.last_used_ip, k.revoked_at
                   FROM api_keys k LEFT JOIN users u ON u.user_id = k.created_by ORDER BY k.created_at DESC"""
            ).fetchall()
        return [self._api_key_public(row) for row in rows]

    def revoke_api_key(self, key_id: str) -> dict:
        with connect(self.db_path) as connection:
            cursor = connection.execute(
                "UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL", (utc_text(), key_id),
            )
            if cursor.rowcount != 1:
                row = connection.execute("SELECT 1 FROM api_keys WHERE key_id = ?", (key_id,)).fetchone()
                if row is None:
                    raise ValueError("API Key 不存在")
        return self.get_api_key(key_id)

    def authenticate_api_key(self, complete: str, client_ip: str) -> Principal:
        match = API_KEY_RE.fullmatch(complete)
        if not match:
            raise AuthError("API Key 格式无效")
        key_id = match.group(1)
        now_dt = utc_now()
        now = utc_text(now_dt)
        with connect(self.db_path) as connection:
            row = connection.execute(
                "SELECT * FROM api_keys WHERE key_id = ? AND key_hash = ? AND revoked_at IS NULL", (key_id, self._digest(complete)),
            ).fetchone()
            if row is not None and (not row["expires_at"] or row["expires_at"] > now):
                touch_cutoff = utc_text(now_dt - timedelta(seconds=self.api_key_touch_seconds))
                if not row["last_used_at"] or row["last_used_at"] <= touch_cutoff:
                    connection.execute("UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE key_id = ?", (now, client_ip, key_id))
        if row is None or (row["expires_at"] and row["expires_at"] <= now):
            raise AuthError("API Key 无效、已撤销或已过期")
        return Principal("api_key", key_id, row["name"], frozenset(json.loads(row["scopes"])), expires_at=row["expires_at"])

    def authenticate_legacy(self, token: str) -> Principal | None:
        if self.auth_mode != "compat" or not token:
            return None
        if self.write_token and hmac.compare_digest(token, self.write_token):
            return Principal("legacy", "write-token", "旧写入令牌", frozenset(("crowd:read", "crowd:publish", "crowd:regions:write", "crowd:batches:revert")))
        if self.read_token and hmac.compare_digest(token, self.read_token):
            return Principal("legacy", "read-token", "旧读取令牌", frozenset(("crowd:read",)))
        return None

    def authenticate(self, bearer: str, session_token: str, client_ip: str) -> Principal:
        if bearer:
            if bearer.startswith("lgc_live_"):
                return self.authenticate_api_key(bearer, client_ip)
            legacy = self.authenticate_legacy(bearer)
            if legacy is not None:
                return legacy
            raise AuthError("Bearer 凭据无效")
        return self.authenticate_session(session_token)

    @staticmethod
    def require_scope(principal: Principal, scope: str | None) -> None:
        if scope and scope not in principal.scopes:
            raise AuthError(f"权限不足，需要 {scope}", 403)

    def audit(
        self, principal: Principal | None, action: str, resource: str | None, result: str, *,
        request_id: str | None = None, details: dict[str, Any] | None = None,
        client_ip: str = "", user_agent: str = "",
    ) -> None:
        safe_details = json.dumps(details, ensure_ascii=False) if details else None
        with connect(self.db_path) as connection:
            connection.execute(
                """INSERT INTO audit_logs
                   (request_id, actor_type, actor_id, action, resource, result, details,
                    client_ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (request_id, principal.actor_type if principal else "anonymous", principal.actor_id if principal else None, action, resource, result, safe_details, client_ip, user_agent[:500], utc_text()),
            )

    def list_audit(self, limit: int = 100, offset: int = 0) -> list[dict]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        with connect(self.db_path) as connection:
            rows = connection.execute("SELECT * FROM audit_logs ORDER BY audit_id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["details"] = json.loads(item["details"]) if item["details"] else None
            result.append(item)
        return result
