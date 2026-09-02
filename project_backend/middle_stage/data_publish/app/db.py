"""SQLite 连接与表结构。

每个请求开一条连接（线程安全，且 WAL 下读写不互相阻塞），schema 用
`CREATE TABLE IF NOT EXISTS` 保证重复启动安全。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path


class ManagedConnection(sqlite3.Connection):
    """`with connect(...)` 时既提交/回滚，也确定性关闭文件句柄。"""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()

SCHEMA = """
CREATE TABLE IF NOT EXISTS cities (
    city_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    name_en      TEXT,
    center_lng   REAL NOT NULL,
    center_lat   REAL NOT NULL,
    default_zoom REAL NOT NULL DEFAULT 12,
    bounds       TEXT,
    source       TEXT NOT NULL DEFAULT 'seed',
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
    region_id  TEXT PRIMARY KEY,
    city_id    TEXT NOT NULL REFERENCES cities(city_id),
    parent_id  TEXT REFERENCES regions(region_id),
    level      TEXT NOT NULL CHECK (level IN ('district', 'street', 'poi')),
    name       TEXT NOT NULL,
    name_en    TEXT,
    aliases    TEXT,
    center_lng REAL,
    center_lat REAL,
    radius_m   REAL,
    area_m2    REAL,
    geometry   TEXT,
    source     TEXT NOT NULL DEFAULT 'seed',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_regions_city_level ON regions (city_id, level);
CREATE INDEX IF NOT EXISTS idx_regions_parent ON regions (parent_id);

CREATE TABLE IF NOT EXISTS batches (
    batch_id   TEXT PRIMARY KEY,
    publisher  TEXT,
    note       TEXT,
    status     TEXT NOT NULL DEFAULT 'published',
    item_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
    reading_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    region_id    TEXT NOT NULL REFERENCES regions(region_id),
    batch_id     TEXT NOT NULL REFERENCES batches(batch_id),
    observed_at  TEXT NOT NULL,
    people_count INTEGER NOT NULL,
    crowd_level  INTEGER NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_region_time
    ON readings (region_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_batch ON readings (batch_id);

CREATE TABLE IF NOT EXISTS bus_routes (
    route_id     TEXT PRIMARY KEY,
    route_no     TEXT NOT NULL,
    direction    TEXT NOT NULL,
    origin       TEXT NOT NULL,
    destination  TEXT NOT NULL,
    operator     TEXT,
    color        TEXT,
    source       TEXT NOT NULL DEFAULT 'mock',
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bus_stops (
    stop_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    name_en      TEXT,
    center_lng   REAL NOT NULL,
    center_lat   REAL NOT NULL,
    source       TEXT NOT NULL DEFAULT 'mock',
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bus_route_stops (
    route_id          TEXT NOT NULL REFERENCES bus_routes(route_id),
    stop_id           TEXT NOT NULL REFERENCES bus_stops(stop_id),
    stop_sequence     INTEGER NOT NULL,
    minutes_from_start REAL NOT NULL,
    PRIMARY KEY (route_id, stop_sequence),
    UNIQUE (route_id, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_bus_route_stops_stop
    ON bus_route_stops (stop_id, route_id);

CREATE TABLE IF NOT EXISTS bus_vehicles (
    vehicle_id           TEXT PRIMARY KEY,
    route_id             TEXT NOT NULL REFERENCES bus_routes(route_id),
    display_name         TEXT,
    current_stop_sequence INTEGER NOT NULL,
    progress             REAL NOT NULL DEFAULT 0,
    status               TEXT NOT NULL,
    occupancy_level      INTEGER NOT NULL DEFAULT 0,
    delay_minutes        INTEGER NOT NULL DEFAULT 0,
    speed_kmh            REAL NOT NULL DEFAULT 0,
    observed_at          TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    source               TEXT NOT NULL DEFAULT 'mock'
);

CREATE INDEX IF NOT EXISTS idx_bus_vehicles_route
    ON bus_vehicles (route_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS bus_vehicle_readings (
    reading_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id            TEXT NOT NULL,
    route_id              TEXT NOT NULL REFERENCES bus_routes(route_id),
    current_stop_sequence INTEGER NOT NULL,
    progress              REAL NOT NULL,
    status                TEXT NOT NULL,
    occupancy_level       INTEGER NOT NULL,
    delay_minutes         INTEGER NOT NULL,
    speed_kmh             REAL NOT NULL,
    observed_at           TEXT NOT NULL,
    created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bus_vehicle_history
    ON bus_vehicle_readings (vehicle_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('admin', 'publisher', 'reviewer', 'viewer')),
    active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id     TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    csrf_hash      TEXT NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(user_id),
    created_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    revoked_at     TEXT,
    client_ip      TEXT,
    user_agent     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS api_keys (
    key_id         TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    key_prefix     TEXT NOT NULL,
    key_hash       TEXT NOT NULL UNIQUE,
    scopes         TEXT NOT NULL,
    created_by     TEXT REFERENCES users(user_id),
    created_at     TEXT NOT NULL,
    expires_at     TEXT,
    last_used_at   TEXT,
    last_used_ip   TEXT,
    revoked_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys (created_by, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id     TEXT,
    actor_type     TEXT NOT NULL,
    actor_id       TEXT,
    action         TEXT NOT NULL,
    resource       TEXT,
    result         TEXT NOT NULL,
    details        TEXT,
    client_ip      TEXT,
    user_agent     TEXT,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_type, actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL,
    client_ip      TEXT,
    success        INTEGER NOT NULL CHECK (success IN (0, 1)),
    attempted_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
    ON login_attempts (username, client_ip, attempted_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id  TEXT PRIMARY KEY,
    applied_at    TEXT NOT NULL
);
"""


# v1 → v1.1：接入高德后新增的列。用 ADD COLUMN 增量迁移，不动已有数据。
MIGRATIONS: list[tuple[str, str, str]] = [
    ("regions", "external_source", "TEXT"),   # 'amap' / 'manual' / 'seed'
    ("regions", "external_id", "TEXT"),       # 高德 POI id
    ("regions", "address", "TEXT"),           # 高德返回的详细地址
    ("regions", "adcode", "TEXT"),            # 高德行政区编码
    ("regions", "amap_type", "TEXT"),         # 高德 POI 分类
    ("cities", "adcode", "TEXT"),
]

POST_MIGRATION_INDEXES = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_external "
    "ON regions (external_source, external_id) "
    "WHERE external_source IS NOT NULL AND external_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_cities_adcode ON cities (adcode)",
]


def _existing_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def migrate(connection: sqlite3.Connection) -> list[str]:
    applied: list[str] = []
    for table, column, column_type in MIGRATIONS:
        if column not in _existing_columns(connection, table):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")
            applied.append(f"{table}.{column}")
    for statement in POST_MIGRATION_INDEXES:
        connection.execute(statement)
    connection.commit()
    return applied


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=10, factory=ManagedConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db(db_path: Path) -> None:
    connection = connect(db_path)
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
        connection.commit()
        applied = migrate(connection)
        if applied:
            print(f"[db] 已迁移新增列：{', '.join(applied)}")
    finally:
        connection.close()


def is_empty(db_path: Path) -> bool:
    connection = connect(db_path)
    try:
        row = connection.execute("SELECT COUNT(*) AS n FROM cities").fetchone()
        return int(row["n"]) == 0
    finally:
        connection.close()
