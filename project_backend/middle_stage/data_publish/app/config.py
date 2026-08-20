"""运行配置。全部来自环境变量或命令行，没有需要提交的密钥。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env"


def load_env_file(path: Path = ENV_FILE) -> None:
    """把同目录 .env 里的键值读进 os.environ。

    已经存在的环境变量优先，不会被文件覆盖。这样密钥只留在本机文件里，
    不需要出现在命令行、文档或聊天记录中。
    """
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

# 主项目已占用 18088 / 18765 / 18866 / 8000，这里选 18099 避免冲突。
DEFAULT_PORT = 18099
DEFAULT_HOST = "127.0.0.1"

# 拥挤度分级：0 空旷 → 4 非常拥挤。颜色在前端定义，这里只管语义。
CROWD_LEVEL_LABELS = ["空旷", "较少", "适中", "拥挤", "非常拥挤"]

# 未手动指定 crowd_level 时的推导阈值（人数下限 → 等级）。
# 区 / 街道 / 景点的人数量级差很多，所以分开定义。这是启发式，不是标准，
# 发布时可以手动覆盖。
CROWD_THRESHOLDS: dict[str, list[int]] = {
    "district": [0, 1000, 5000, 15000, 30000],
    "street": [0, 100, 500, 1500, 3000],
    "poi": [0, 50, 200, 500, 1000],
}

LEVELS = ("district", "street", "poi")
LEVEL_LABELS = {"district": "区", "street": "街道", "poi": "景点"}


def derive_crowd_level(level: str, people_count: int) -> int:
    """按人数和区域层级推导拥挤度。"""
    thresholds = CROWD_THRESHOLDS.get(level, CROWD_THRESHOLDS["poi"])
    result = 0
    for index, floor in enumerate(thresholds):
        if people_count >= floor:
            result = index
    return result


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Config:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    db_path: Path = field(default_factory=lambda: DATA_DIR / "crowd.db")
    # 写入令牌。为空时只允许来自本机回环地址的写请求（见 auth.py）。
    write_token: str = ""
    # 读取令牌。为空时读接口公开，方便地图前端直接调用。
    read_token: str = ""
    cors_origins: str = "*"
    seed_on_empty: bool = True
    # 高德 Web 服务 Key。只保存在服务端，绝不下发给浏览器。
    amap_key: str = ""
    amap_timeout: float = 8.0
    # required: 仅账号会话 / 新 API Key；compat: 额外接受旧读写 token。
    auth_mode: str = "required"
    session_ttl_seconds: int = 8 * 60 * 60
    session_idle_seconds: int = 30 * 60
    session_cookie_name: str = "crowd_session"
    session_cookie_secure: bool = False
    auth_pepper: str = ""
    api_key_touch_seconds: int = 60
    login_max_failures: int = 5
    login_window_seconds: int = 15 * 60

    @classmethod
    def from_env(cls) -> "Config":
        load_env_file()
        auth_mode = os.getenv("CROWD_AUTH_MODE", "required").strip().lower()
        if auth_mode not in ("required", "compat"):
            raise ValueError("CROWD_AUTH_MODE 只能是 required 或 compat")
        return cls(
            host=os.getenv("CROWD_HOST", DEFAULT_HOST),
            port=int(os.getenv("CROWD_PORT", str(DEFAULT_PORT))),
            db_path=Path(os.getenv("CROWD_DB", str(DATA_DIR / "crowd.db"))),
            write_token=os.getenv("CROWD_WRITE_TOKEN", "").strip(),
            read_token=os.getenv("CROWD_READ_TOKEN", "").strip(),
            cors_origins=os.getenv("CROWD_CORS_ORIGINS", "*"),
            seed_on_empty=_env_flag("CROWD_SEED_ON_EMPTY", True),
            amap_key=os.getenv("AMAP_WEB_KEY", os.getenv("AMAP_KEY", "")).strip(),
            amap_timeout=float(os.getenv("AMAP_TIMEOUT_SECONDS", "8")),
            auth_mode=auth_mode,
            session_ttl_seconds=max(300, int(os.getenv("CROWD_SESSION_TTL_SECONDS", "28800"))),
            session_idle_seconds=max(60, int(os.getenv("CROWD_SESSION_IDLE_SECONDS", "1800"))),
            session_cookie_name=(
                os.getenv("CROWD_SESSION_COOKIE_NAME", "crowd_session").strip()
                or "crowd_session"
            ),
            session_cookie_secure=_env_flag("CROWD_SESSION_COOKIE_SECURE", False),
            auth_pepper=os.getenv("CROWD_AUTH_PEPPER", "").strip(),
            api_key_touch_seconds=max(
                0, int(os.getenv("CROWD_API_KEY_TOUCH_SECONDS", "60"))
            ),
            login_max_failures=max(1, int(os.getenv("CROWD_LOGIN_MAX_FAILURES", "5"))),
            login_window_seconds=max(
                60, int(os.getenv("CROWD_LOGIN_WINDOW_SECONDS", "900"))
            ),
        )
