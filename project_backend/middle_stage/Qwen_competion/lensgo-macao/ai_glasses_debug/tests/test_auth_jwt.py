import base64
import json

from glasses.server.auth import TokenPolicy, bearer_token_from_auth_header, parse_user_id_from_jwt


def _make_jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.sig"


def test_parse_user_id_from_jwt():
    token = _make_jwt({"userId": 99089019768})
    assert parse_user_id_from_jwt(token) == "99089019768"


def test_bearer_token():
    assert bearer_token_from_auth_header("Bearer abc") == "abc"
    assert bearer_token_from_auth_header("") is None


def test_token_policy():
    p = TokenPolicy(allow_any=True, allowlist=set(), token_regex=None)
    assert p.ok("any")
    p2 = TokenPolicy(allow_any=False, allowlist={"t1"}, token_regex=None)
    assert p2.ok("t1")
    assert not p2.ok("t2")
