from __future__ import annotations

import http.client
import json
import sqlite3
import threading
import unittest
import uuid
from contextlib import closing
from datetime import timedelta
from pathlib import Path

from app import db
from app.api import make_handler
from app.auth import AuthError, AuthService, utc_now, utc_text
from app.config import Config
from app.store import Store


PEPPER = "test-pepper-0123456789-abcdefghijklmnopqrstuvwxyz"
PASSWORD = "correct horse battery staple"


def local_db_path() -> Path:
    return Path(__file__).resolve().parent / f"test-{uuid.uuid4().hex}.db"


def remove_test_db(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()


class AuthStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = local_db_path()
        db.init_db(self.db_path)
        self.auth = AuthService(self.db_path, auth_pepper=PEPPER, session_idle_seconds=1800)
        self.admin = self.auth.create_initial_admin("admin", PASSWORD, "Administrator")

    def tearDown(self) -> None:
        remove_test_db(self.db_path)

    def test_schema_password_session_and_idle_timeout(self) -> None:
        expected = {"users", "sessions", "api_keys", "audit_logs", "login_attempts"}
        with closing(sqlite3.connect(self.db_path)) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            stored = connection.execute("SELECT password_hash FROM users").fetchone()[0]
        self.assertTrue(expected <= tables)
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertNotIn(PASSWORD, stored)

        payload, token = self.auth.login("admin", PASSWORD, "127.0.0.1", "test")
        self.assertIn("csrf_token", payload)
        with closing(sqlite3.connect(self.db_path)) as connection:
            stored_token = connection.execute("SELECT token_hash FROM sessions").fetchone()[0]
            self.assertNotEqual(token, stored_token)
            connection.execute(
                "UPDATE sessions SET last_seen_at = ?",
                (utc_text(utc_now() - timedelta(hours=2)),),
            )
            connection.commit()
        with self.assertRaises(AuthError):
            self.auth.authenticate_session(token)

    def test_api_key_only_returned_once_and_revoke(self) -> None:
        created = self.auth.create_api_key(
            name="qwen-read", scopes=["crowd:read"], created_by=self.admin["user_id"]
        )
        complete = created["api_key"]
        self.assertRegex(complete, r"^lgc_live_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{32,}$")
        with closing(sqlite3.connect(self.db_path)) as connection:
            row = connection.execute("SELECT key_hash FROM api_keys").fetchone()
        self.assertNotEqual(complete, row[0])
        self.assertNotIn("api_key", self.auth.list_api_keys()[0])
        principal = self.auth.authenticate_api_key(complete, "127.0.0.1")
        self.assertEqual(principal.scopes, frozenset({"crowd:read"}))
        self.auth.revoke_api_key(created["key_id"])
        with self.assertRaises(AuthError):
            self.auth.authenticate_api_key(complete, "127.0.0.1")


class HttpAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = local_db_path()
        db.init_db(self.db_path)
        auth = AuthService(self.db_path, auth_pepper=PEPPER)
        auth.create_initial_admin("admin", PASSWORD)
        config = Config(
            host="127.0.0.1", port=0, db_path=self.db_path, seed_on_empty=False,
            auth_pepper=PEPPER, cors_origins="*",
        )
        from http.server import ThreadingHTTPServer

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(config, Store(self.db_path)))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        remove_test_db(self.db_path)

    def request(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        sent_headers = {"Content-Type": "application/json", **(headers or {})}
        connection.request(method, path, body=data, headers=sent_headers)
        response = connection.getresponse()
        raw = response.read()
        payload = json.loads(raw) if raw else None
        result = response.status, payload, response.getheaders()
        connection.close()
        return result

    @staticmethod
    def cookie_from(headers: list[tuple[str, str]], name: str) -> str:
        for header, value in headers:
            if header.lower() == "set-cookie" and value.startswith(name + "="):
                return value.split(";", 1)[0]
        raise AssertionError(f"missing cookie {name}")

    def test_http_contract_csrf_scope_and_revoke(self) -> None:
        status, payload, _ = self.request("GET", "/api/health")
        self.assertEqual((status, payload), (200, {"status": "ok"}))
        self.assertEqual(self.request("GET", "/api/meta")[0], 401)
        self.assertEqual(self.request("GET", "/index.html")[0], 302)

        status, payload, headers = self.request(
            "POST", "/api/auth/login", {"username": "admin", "password": PASSWORD}
        )
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", next(value for key, value in headers if key.lower() == "set-cookie" and value.startswith("crowd_session=")))
        self.assertIn("SameSite=Lax", str(headers))
        session_cookie = self.cookie_from(headers, "crowd_session")
        csrf_cookie = self.cookie_from(headers, "crowd_csrf")
        cookies = f"{session_cookie}; {csrf_cookie}"
        csrf = payload["csrf_token"]

        base_headers = {"Cookie": cookies, "X-CSRF-Token": csrf}
        self.assertEqual(
            self.request("POST", "/api/admin/api-keys", {"name": "x", "scopes": ["crowd:read"]}, base_headers)[0],
            403,
        )
        secure_headers = {**base_headers, "Origin": self.origin}
        status, payload, _ = self.request(
            "POST", "/api/admin/api-keys",
            {"name": "qwen", "scopes": ["crowd:read"]}, secure_headers,
        )
        self.assertEqual(status, 201)
        complete = payload["api_key"]
        key_id = payload["key"]["key_id"]
        bearer = {"Authorization": f"Bearer {complete}"}
        self.assertEqual(self.request("GET", "/api/meta", headers=bearer)[0], 200)
        # 独立权限在 handler 运行前拦截，因此不会调用高德。
        self.assertEqual(self.request("GET", "/api/amap/status", headers=bearer)[0], 403)

        status, payload, _ = self.request(
            "POST", f"/api/admin/api-keys/{key_id}/revoke", {}, secure_headers
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["key"]["status"], "revoked")
        self.assertEqual(self.request("GET", "/api/meta", headers=bearer)[0], 401)


if __name__ == "__main__":
    unittest.main()
