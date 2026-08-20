#!/usr/bin/env python
"""人流密度数据发布器 —— 启动入口。

只依赖 Python 标准库，不需要 pip install：

    python run.py                       # 本机启动，默认 http://127.0.0.1:18099
    python run.py --port 18100          # 换端口
    python run.py --host 0.0.0.0        # 对局域网开放（必须配合 --write-token）
    python run.py --reseed              # 清空并重建内置城市/景点数据
    python run.py --seed-only           # 只初始化数据库，不启动服务
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Windows 控制台默认可能是 cp936，日志里的中文/符号遇到不可编码字符会抛
# UnicodeEncodeError 把服务打挂。这里只降级为替换字符，不改控制台代码页。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(errors="replace")
        except (ValueError, OSError):
            pass

from app import api, db  # noqa: E402
from app.auth import AuthService  # noqa: E402
from app.config import DEFAULT_HOST, DEFAULT_PORT, Config  # noqa: E402
from app.store import Store  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="人流密度数据发布器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--host", default=None, help=f"监听地址（默认 {DEFAULT_HOST}）")
    parser.add_argument("--port", type=int, default=None, help=f"监听端口（默认 {DEFAULT_PORT}）")
    parser.add_argument("--db", default=None, help="SQLite 文件路径（默认 data/crowd.db）")
    parser.add_argument("--write-token", default=None, help="旧写入令牌；仅 CROWD_AUTH_MODE=compat 生效")
    parser.add_argument("--read-token", default=None, help="旧读取令牌；仅 CROWD_AUTH_MODE=compat 生效")
    parser.add_argument("--cors-origins", default=None, help="允许的跨域来源，默认 *")
    parser.add_argument("--reseed", action="store_true", help="清空所有数据并重建内置数据")
    parser.add_argument("--seed-only", action="store_true", help="只初始化数据库，不启动服务")
    parser.add_argument("--no-seed", action="store_true", help="空库时也不写入内置数据")
    parser.add_argument(
        "--create-admin", metavar="USERNAME",
        help="仅在账号表为空时安全创建初始管理员；密码优先通过交互 getpass 输入",
    )
    parser.add_argument("--admin-display-name", default="", help="初始管理员显示名称")
    parser.add_argument(
        "--create-api-key", metavar="NAME",
        help="使用已有管理员作为创建者签发 API Key，打印一次完整 Key 后退出",
    )
    parser.add_argument(
        "--scope", action="append", dest="api_key_scopes",
        help="API Key 权限；可重复，默认 crowd:read",
    )
    parser.add_argument("--api-key-expires-at", default=None, help="API Key 过期时间（ISO8601）")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = Config.from_env()
    if args.host is not None:
        config.host = args.host
    if args.port is not None:
        config.port = args.port
    if args.db is not None:
        config.db_path = Path(args.db)
    if args.write_token is not None:
        config.write_token = args.write_token.strip()
    if args.read_token is not None:
        config.read_token = args.read_token.strip()
    if args.cors_origins is not None:
        config.cors_origins = args.cors_origins

    db.init_db(config.db_path)
    store = Store(config.db_path)
    try:
        auth_service = AuthService(
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
    except ValueError as error:
        print(f"[auth] 配置错误：{error}", file=sys.stderr)
        print("[auth] 请在 .env 设置 CROWD_AUTH_PEPPER 为至少 32 字节随机值。", file=sys.stderr)
        return 2

    if args.create_admin:
        password = os.getenv("CROWD_INITIAL_ADMIN_PASSWORD", "")
        if not password:
            if not sys.stdin.isatty():
                print(
                    "[auth] 非交互环境请临时设置 CROWD_INITIAL_ADMIN_PASSWORD；不要把密码放在命令行。",
                    file=sys.stderr,
                )
                return 2
            password = getpass.getpass("初始管理员密码（至少 10 字符）: ")
            confirmation = getpass.getpass("再次输入密码: ")
            if password != confirmation:
                print("[auth] 两次输入的密码不一致。", file=sys.stderr)
                return 2
        try:
            user = auth_service.create_initial_admin(
                args.create_admin, password, args.admin_display_name
            )
        except ValueError as error:
            print(f"[auth] 创建管理员失败：{error}", file=sys.stderr)
            return 2
        finally:
            password = ""
        print(f"[auth] 已创建初始管理员：{user['username']} ({user['user_id']})")

    if config.auth_mode == "required" and auth_service.user_count() == 0:
        print(
            "[auth] required 模式下必须先创建管理员：python run.py --create-admin admin --seed-only",
            file=sys.stderr,
        )
        return 2

    if args.create_api_key:
        admins = [
            user for user in auth_service.list_users()
            if user["active"] and user["role"] == "admin"
        ]
        if not admins:
            print("[auth] 创建 API Key 前必须有一个启用的管理员账号。", file=sys.stderr)
            return 2
        try:
            created = auth_service.create_api_key(
                name=args.create_api_key,
                scopes=args.api_key_scopes or ["crowd:read"],
                created_by=admins[0]["user_id"],
                expires_at=args.api_key_expires_at,
            )
        except ValueError as error:
            print(f"[auth] 创建 API Key 失败：{error}", file=sys.stderr)
            return 2
        print("API Key 只显示这一次，请立即保存：")
        print(created["api_key"])
        return 0

    if args.reseed:
        result = store.seed(reset=True)
        print(f"[seed] 已重建：{result['cities']} 个城市，{result['regions']} 个区域")
    elif not args.no_seed and config.seed_on_empty and db.is_empty(config.db_path):
        result = store.seed()
        print(f"[seed] 首次初始化：{result['cities']} 个城市，{result['regions']} 个区域")

    if args.seed_only:
        print(f"[seed] 数据库就绪：{config.db_path}")
        return 0

    api.serve(config, store)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
