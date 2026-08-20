#!/usr/bin/env python3
"""Non-destructive integration orchestrator for LensGo and QwenPaw."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
LENSGO = ROOT / "lensgo-macao"
GLASSES = LENSGO / "ai_glasses_debug"
QWENPAW = ROOT / "qwen_compitition"
RUNTIME = ROOT / "workspace"
QWEN_WORKING = RUNTIME / "qwenpaw"
ENV_FILE = ROOT / ".env.integrated"
ENV_EXAMPLE = ROOT / ".env.integrated.example"
LENSGO_CONFIG = ROOT / "config" / "lensgo.integrated.toml"

CUSTOM_SKILLS = ("macau_trip_planner", "qwenpaw_ai_drive_storage", "lensgo_pose_coach")


@dataclass(frozen=True)
class AgentSpec:
    agent_id: str
    name: str
    description: str
    skills: tuple[str, ...] = ()


AGENTS = (
    AgentSpec(
        "lensgo-travel-director",
        "LensGo Travel Director",
        "澳门旅行陪伴、用户意图与幸福时刻编排主 Agent",
        ("multi_agent_collaboration",),
    ),
    AgentSpec(
        "lensgo-vision-curator",
        "LensGo Vision Curator",
        "旅游图片视频理解、拍照建议与重要时刻视觉判断",
    ),
    AgentSpec(
        "lensgo-memory-keeper",
        "LensGo Memory Keeper",
        "用户身份、旅程、幸福时刻和共享记忆整理专家",
    ),
    AgentSpec(
        "lensgo-media-archivist",
        "LensGo Media Archivist",
        "图片视频去重、生命周期、隐私和归档策略专家",
    ),
    AgentSpec(
        "lensgo-pose-coach",
        "LensGo Pose Coach",
        "旅行拍照姿势设计、动作分解与参考图提示词专家",
    ),
)


def load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value and value[0:1] == value[-1:] and value.startswith(("'", '"')):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def integrated_env() -> dict[str, str]:
    env = os.environ.copy()
    for key, value in load_dotenv(ENV_FILE).items():
        env.setdefault(key, value)
    # Subprocesses use different working directories, so any project-relative
    # file consumed directly by QwenPaw must be made absolute here.
    hotel_env_file = env.get("HOTEL_BOOKING_ENV_FILE", "").strip()
    if hotel_env_file:
        hotel_env_path = Path(hotel_env_file).expanduser()
        if not hotel_env_path.is_absolute():
            hotel_env_path = ROOT / hotel_env_path
        env["HOTEL_BOOKING_ENV_FILE"] = str(hotel_env_path.resolve())
    env["QWENPAW_WORKING_DIR"] = str(QWEN_WORKING.resolve())
    env["COPAW_WORKING_DIR"] = str(QWEN_WORKING.resolve())
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault(
        "QWENPAW_CORS_ORIGINS",
        "http://tauri.localhost,https://tauri.localhost,tauri://localhost",
    )
    env.setdefault("LENSGO_CORS_ORIGINS", "*")
    return env


def env_value(env: dict[str, str], key: str, default: str = "") -> str:
    return str(env.get(key, default)).strip()


def env_path(env: dict[str, str], key: str) -> Path | None:
    raw = env_value(env, key)
    if not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


def venv_python() -> Path:
    if os.name == "nt":
        return ROOT / ".venv" / "Scripts" / "python.exe"
    return ROOT / ".venv" / "bin" / "python"


def venv_pythonw() -> Path:
    if os.name == "nt":
        return ROOT / ".venv" / "Scripts" / "pythonw.exe"
    return venv_python()


def venv_qwenpaw() -> Path:
    if os.name == "nt":
        return ROOT / ".venv" / "Scripts" / "qwenpaw.exe"
    return ROOT / ".venv" / "bin" / "qwenpaw"


def run(command: Iterable[object], *, env: dict[str, str] | None = None, cwd: Path = ROOT) -> None:
    rendered = [str(item) for item in command]
    print("+", subprocess.list2cmdline(rendered), flush=True)
    subprocess.run(rendered, cwd=cwd, env=env, check=True)


def load_json(path: Path, default: object) -> object:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def copy_file_missing(source: Path, target: Path) -> str:
    if not source.is_file():
        raise FileNotFoundError(source)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return "created"
    if source.read_bytes() == target.read_bytes():
        return "same"
    return "conflict"


def copy_tree_missing(source: Path, target: Path) -> list[tuple[Path, str]]:
    results: list[tuple[Path, str]] = []
    if not source.is_dir():
        raise FileNotFoundError(source)
    for item in source.rglob("*"):
        if item.is_file():
            relative = item.relative_to(source)
            results.append((relative, copy_file_missing(item, target / relative)))
    return results


def configured_agents() -> set[str]:
    raw = load_json(QWEN_WORKING / "config.json", {})
    if not isinstance(raw, dict):
        return set()
    agents = raw.get("agents", {})
    if not isinstance(agents, dict):
        return set()
    profiles = agents.get("profiles", {})
    return set(profiles) if isinstance(profiles, dict) else set()


def repair_workspace_paths() -> int:
    """Rebase persisted agent workspace paths after the project is moved."""
    config_path = QWEN_WORKING / "config.json"
    raw = load_json(config_path, {})
    if not isinstance(raw, dict):
        raise RuntimeError(f"QwenPaw config must contain an object: {config_path}")
    agents = raw.get("agents", {})
    profiles = agents.get("profiles", {}) if isinstance(agents, dict) else {}
    if not isinstance(profiles, dict):
        raise RuntimeError("QwenPaw config field agents.profiles must contain an object")

    repaired = 0
    for agent_id, profile in profiles.items():
        if not isinstance(profile, dict):
            continue
        expected = (QWEN_WORKING / "workspaces" / agent_id).resolve()
        configured = profile.get("workspace_dir")
        if not isinstance(configured, str) or Path(configured).resolve() != expected:
            profile["workspace_dir"] = str(expected)
            repaired += 1

        agent_path = expected / "agent.json"
        agent = load_json(agent_path, {})
        if isinstance(agent, dict):
            agent_workspace = agent.get("workspace_dir")
            if not isinstance(agent_workspace, str) or Path(agent_workspace).resolve() != expected:
                agent["workspace_dir"] = str(expected)
                save_json(agent_path, agent)
                repaired += 1

    if repaired:
        save_json(config_path, raw)
        print(f"[bootstrap] rebased {repaired} persisted workspace path(s)")
    return repaired


def merge_custom_skill_manifest(workspace: Path) -> None:
    source_path = QWENPAW / "working" / "workspaces" / "default" / "skill.json"
    target_path = workspace / "skill.json"
    source = load_json(source_path, {})
    target = load_json(target_path, {"skills": {}})
    if not isinstance(source, dict) or not isinstance(target, dict):
        raise RuntimeError("skill.json must contain a JSON object")
    source_skills = source.get("skills", {})
    target_skills = target.setdefault("skills", {})
    if not isinstance(source_skills, dict) or not isinstance(target_skills, dict):
        raise RuntimeError("skill.json field 'skills' must contain an object")
    added: list[str] = []
    for name in CUSTOM_SKILLS:
        if name not in source_skills:
            raise RuntimeError(f"Source skill manifest is missing {name}")
        if name not in target_skills:
            target_skills[name] = source_skills[name]
            added.append(name)
    if added:
        save_json(target_path, target)
        print(f"[bootstrap] enabled missing skills in {workspace.name}: {', '.join(added)}")


def yaml_string(value: object) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def write_missing_text(path: Path, content: str) -> str:
    normalized = content.rstrip() + "\n"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(normalized, encoding="utf-8")
        return "created"
    if path.read_text(encoding="utf-8-sig") == normalized:
        return "same"
    return "conflict"


def amap_driver(env: dict[str, str], server: Path, config: Path) -> str:
    python = venv_python().resolve()
    output = (QWEN_WORKING / "workspaces" / "default" / "media" / "travel_maps").resolve()
    return f"""name: amap-macau
protocol: mcp
endpoint:
  transport: stdio
  command: {yaml_string(python)}
  args:
  - {yaml_string(server)}
  env:
    AMAP_CONFIG_FILE:
      source: literal
      value: {yaml_string(config)}
    AMAP_MAP_OUTPUT_DIR:
      source: literal
      value: {yaml_string(output)}
credentials: {{}}
config:
  display_name: 高德地图（澳门行程）
  description: 澳门 POI、真实路线与路线图生成；密钥只保存在本机受限文件。
enabled: true
policy:
  default_effect: ask
  rules:
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: amap_search_poi}}
    principal: {{source_type: '*', source_value: '*', subject_type: '*', subject_value: '*'}}
    condition: null
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: amap_plan_route}}
    principal: {{source_type: '*', source_value: '*', subject_type: '*', subject_value: '*'}}
    condition: null
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: amap_render_route_map}}
    principal: {{source_type: '*', source_value: '*', subject_type: '*', subject_value: '*'}}
    condition: null
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: amap_build_itinerary}}
    principal: {{source_type: channel, source_value: lensgo-mobile, subject_type: all, subject_value: '*'}}
    condition: null
"""


def ai_drive_driver(env: dict[str, str], server: Path) -> str:
    python = venv_python().resolve()
    media = (QWEN_WORKING / "workspaces" / "default" / "media").resolve()
    base_url = env_value(env, "AI_DRIVE_BASE_URL", "http://127.0.0.1:8000")
    timeout = env_value(env, "AI_DRIVE_TIMEOUT_SECONDS", "60")
    return f"""name: ai-drive
protocol: mcp
endpoint:
  transport: stdio
  command: {yaml_string(python)}
  args:
  - {yaml_string(server)}
  env:
    AI_DRIVE_BASE_URL:
      source: literal
      value: {yaml_string(base_url)}
    AI_DRIVE_TIMEOUT_SECONDS:
      source: literal
      value: {yaml_string(timeout)}
    QWENPAW_MEDIA_ROOT:
      source: literal
      value: {yaml_string(media)}
credentials: {{}}
config:
  display_name: AI Drive
  description: QwenPaw 分析后的文件归档与可视化。
enabled: true
policy:
  default_effect: ask
  rules:
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: ai_drive_store_from_qwenpaw}}
    principal: {{source_type: '*', source_value: '*', subject_type: '*', subject_value: '*'}}
    condition: null
"""


def crowd_driver(env: dict[str, str]) -> str:
    python = venv_python().resolve()
    server = (ROOT / "scripts" / "mcp" / "lensgo_crowd_server.py").resolve()
    base_url = env_value(env, "LENSGO_CROWD_BASE_URL", "http://127.0.0.1:18099")
    read_token = env_value(env, "LENSGO_CROWD_READ_TOKEN")
    timeout = env_value(env, "LENSGO_CROWD_TIMEOUT_SECONDS", "8")
    stale_minutes = env_value(env, "LENSGO_CROWD_STALE_MINUTES", "30")
    return f"""name: lensgo-crowd
protocol: mcp
endpoint:
  transport: stdio
  command: {yaml_string(python)}
  args:
  - {yaml_string(server)}
  env:
    LENSGO_CROWD_BASE_URL:
      source: literal
      value: {yaml_string(base_url)}
    LENSGO_CROWD_READ_TOKEN:
      source: literal
      value: {yaml_string(read_token)}
    LENSGO_CROWD_TIMEOUT_SECONDS:
      source: literal
      value: {yaml_string(timeout)}
    LENSGO_CROWD_STALE_MINUTES:
      source: literal
      value: {yaml_string(stale_minutes)}
credentials: {{}}
config:
  display_name: LensGo 实时人流
  description: 从 publish 服务只读查询澳门景点最新人流，用于行程提醒和重排。
enabled: true
policy:
  default_effect: ask
  rules:
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: lensgo_latest_crowd}}
    principal: {{source_type: '*', source_value: '*', subject_type: '*', subject_value: '*'}}
    condition: null
  - subject: '*'
    effect: allow
    target: {{kind: tool, name: lensgo_place_crowd}}
    principal: {{source_type: '*', source_value: '*', subject_type: '*', subject_value: '*'}}
    condition: null
"""


def install_drivers(env: dict[str, str], workspaces: Iterable[Path]) -> None:
    amap_server = env_path(env, "AMAP_MCP_SERVER")
    amap_config = env_path(env, "AMAP_CONFIG_FILE")
    ai_drive_server = env_path(env, "AI_DRIVE_MCP_SERVER")
    for workspace in workspaces:
        driver_dir = workspace / "drivers" / "mcp"
        status = write_missing_text(
            driver_dir / "lensgo-crowd.yaml",
            crowd_driver(env),
        )
        print(f"[bootstrap] {workspace.name}/lensgo-crowd.yaml: {status}")
        if amap_server and amap_config and amap_server.is_file() and amap_config.is_file():
            status = write_missing_text(
                driver_dir / "amap-macau.yaml",
                amap_driver(env, amap_server, amap_config),
            )
            print(f"[bootstrap] {workspace.name}/amap-macau.yaml: {status}")
        else:
            print("[bootstrap] AMap MCP not configured or path missing; driver skipped")
        if ai_drive_server and ai_drive_server.is_file():
            status = write_missing_text(
                driver_dir / "ai-drive.yaml",
                ai_drive_driver(env, ai_drive_server),
            )
            print(f"[bootstrap] {workspace.name}/ai-drive.yaml: {status}")
        else:
            print("[bootstrap] AI Drive MCP not configured or path missing; driver skipped")


def bootstrap(args: argparse.Namespace) -> int:
    env = integrated_env()
    RUNTIME.mkdir(parents=True, exist_ok=True)
    (RUNTIME / "logs").mkdir(parents=True, exist_ok=True)
    (RUNTIME / "runtime").mkdir(parents=True, exist_ok=True)

    if not args.skip_install:
        if not venv_python().is_file():
            run([sys.executable, "-m", "venv", ROOT / ".venv"])
        run(
            [
                venv_python(),
                "-m",
                "pip",
                "install",
                "-e",
                QWENPAW,
                "-e",
                GLASSES,
                "fastapi==0.139.2",
                "uvicorn[standard]==0.51.0",
                "python-multipart==0.0.32",
                "pywebview",
            ],
            env=env,
        )
    elif not venv_python().is_file():
        print("[bootstrap] --skip-install used, but .venv does not exist", file=sys.stderr)
        return 2

    if args.build_console:
        npm = shutil.which("npm")
        if not npm:
            print("[bootstrap] npm is required for --build-console", file=sys.stderr)
            return 2
        # The checked-in lockfile can contain legacy npmmirror tarball URLs.
        # Always replace those hosts so a fresh bootstrap uses npm's official
        # registry and remains reproducible on machines where npmmirror TLS is
        # unavailable.
        run(
            [
                npm,
                "ci",
                "--registry=https://registry.npmjs.org",
                "--replace-registry-host=always",
            ],
            cwd=QWENPAW / "console",
            env=env,
        )
        run([npm, "run", "build"], cwd=QWENPAW / "console", env=env)

    if not venv_qwenpaw().is_file():
        print(f"[bootstrap] qwenpaw executable missing: {venv_qwenpaw()}", file=sys.stderr)
        return 2

    if not (QWEN_WORKING / "config.json").is_file():
        telemetry_marker = QWEN_WORKING / ".telemetry_collected"
        if not telemetry_marker.exists():
            save_json(
                telemetry_marker,
                {"opted_out": True, "collected_versions": []},
            )
        run([venv_qwenpaw(), "init", "--defaults", "--accept-security"], env=env)
    else:
        print("[bootstrap] existing QwenPaw config preserved")

    repair_workspace_paths()

    existing = configured_agents()
    created_agents: set[str] = set()
    provider = env_value(env, "QWENPAW_PROVIDER_ID")
    model = env_value(env, "QWENPAW_MODEL_ID")
    for spec in AGENTS:
        if spec.agent_id in existing:
            print(f"[bootstrap] agent exists, preserved: {spec.agent_id}")
            continue
        command: list[object] = [
            venv_qwenpaw(),
            "agents",
            "create",
            "--name",
            spec.name,
            "--agent-id",
            spec.agent_id,
            "--description",
            spec.description,
            "--language",
            "zh",
            "--template",
            "default",
        ]
        for skill in spec.skills:
            command.extend(["--skill", skill])
        if provider and model:
            command.extend(["--provider-id", provider, "--model-id", model])
        run(command, env=env)
        created_agents.add(spec.agent_id)

    source_prompts = LENSGO / "qwenpaw_agents"
    workspaces = []
    for spec in AGENTS:
        workspace = QWEN_WORKING / "workspaces" / spec.agent_id
        workspaces.append(workspace)
        for name in ("AGENTS.md", "SOUL.md"):
            source = source_prompts / spec.agent_id / name
            target = workspace / name
            if spec.agent_id in created_agents:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                status = "installed"
            else:
                status = copy_file_missing(source, target)
            print(f"[bootstrap] {spec.agent_id}/{name}: {status}")

    skill_source = QWENPAW / "working" / "workspaces" / "default" / "skills"
    for workspace in (
        QWEN_WORKING / "workspaces" / "default",
        QWEN_WORKING / "workspaces" / "lensgo-travel-director",
    ):
        for name in CUSTOM_SKILLS:
            results = copy_tree_missing(skill_source / name, workspace / "skills" / name)
            conflicts = [str(path) for path, status in results if status == "conflict"]
            if conflicts:
                print(
                    f"[bootstrap] preserved conflicting files in {workspace.name}/{name}: "
                    + ", ".join(conflicts),
                    file=sys.stderr,
                )
        merge_custom_skill_manifest(workspace)

    install_drivers(
        env,
        (
            QWEN_WORKING / "workspaces" / "default",
            QWEN_WORKING / "workspaces" / "lensgo-travel-director",
        ),
    )
    print("[bootstrap] integration workspace is ready")
    return 0


def port_available(host: str, port: int) -> bool:
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((probe_host, port)) != 0


def check_http(url: str, timeout: float = 0.5) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except (OSError, urllib.error.URLError):
        return False


def lensgo_ports() -> tuple[int, int]:
    """Return the WebSocket and HTTP ports from the integrated LensGo config."""
    with LENSGO_CONFIG.open("rb") as handle:
        raw_config = tomllib.load(handle)
    server = raw_config.get("server", {})
    if not isinstance(server, dict):
        server = {}
    return int(server.get("port", 18765)), int(server.get("http_port", 18000))


def doctor(_args: argparse.Namespace) -> int:
    env = integrated_env()
    errors = 0

    def report(level: str, message: str) -> None:
        nonlocal errors
        if level == "ERROR":
            errors += 1
        print(f"[{level:<5}] {message}")

    version = sys.version_info[:3]
    report("OK" if (3, 11) <= version < (3, 14) else "ERROR", f"Python {'.'.join(map(str, version))}")
    required = (
        (LENSGO, "LensGo module"),
        (GLASSES / "glasses" / "server" / "app.py", "LensGo glasses server"),
        (QWENPAW / "src" / "qwenpaw" / "app" / "_app.py", "QwenPaw module"),
        (LENSGO_CONFIG, "integrated LensGo config"),
    )
    for path, label in required:
        report("OK" if path.exists() else "ERROR", f"{label}: {path}")
    report("OK" if ENV_FILE.is_file() else "WARN", f"environment file: {ENV_FILE}")
    venv_exists = venv_python().is_file()
    report("OK" if venv_exists else "WARN", f"virtualenv Python: {venv_python()}")
    if venv_exists:
        import_check = subprocess.run(
            [str(venv_python()), "-c", "import qwenpaw, glasses"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        report(
            "OK" if import_check.returncode == 0 else "ERROR",
            "editable Python installs (qwenpaw, glasses)",
        )
        test_import_check = subprocess.run(
            [str(venv_python()), "-c", "import pytest, pytest_asyncio"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        report(
            "OK" if test_import_check.returncode == 0 else "WARN",
            "Python test dependencies (pytest, pytest-asyncio)",
        )
    report(
        "OK" if (QWEN_WORKING / "config.json").is_file() else "WARN",
        f"QwenPaw integrated workspace: {QWEN_WORKING}",
    )
    try:
        config = load_json(QWEN_WORKING / "config.json", {})
        agents = config.get("agents", {}) if isinstance(config, dict) else {}
        profiles = agents.get("profiles", {}) if isinstance(agents, dict) else {}
        invalid_paths = []
        if isinstance(profiles, dict):
            for agent_id, profile in profiles.items():
                if not isinstance(profile, dict):
                    continue
                expected = (QWEN_WORKING / "workspaces" / agent_id).resolve()
                configured = profile.get("workspace_dir")
                if not isinstance(configured, str) or Path(configured).resolve() != expected:
                    invalid_paths.append(agent_id)
        report(
            "OK" if not invalid_paths else "ERROR",
            "persisted agent workspace paths"
            + (f": {', '.join(invalid_paths)}" if invalid_paths else ""),
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        report("ERROR", f"cannot validate persisted workspace paths: {exc}")
    console_index = QWENPAW / "console" / "dist" / "index.html"
    report(
        "OK" if console_index.is_file() else "WARN",
        f"standalone App Console bundle: {console_index}",
    )
    for key, expected_kind in (
        ("AMAP_MCP_SERVER", "file"),
        ("AMAP_CONFIG_FILE", "file"),
        ("AI_DRIVE_MCP_SERVER", "file"),
        ("LENSGO_CROWD_PROJECT_ROOT", "directory"),
        ("HOTEL_BOOKING_ENV_FILE", "file"),
    ):
        path = env_path(env, key)
        exists = bool(
            path
            and (path.is_dir() if expected_kind == "directory" else path.is_file())
        )
        report("OK" if exists else "WARN", f"{key}: {path or 'not configured'}")
    try:
        lensgo_ws_port, lensgo_http_port = lensgo_ports()
    except (OSError, ValueError, TypeError, tomllib.TOMLDecodeError) as exc:
        report("ERROR", f"cannot read LensGo ports from {LENSGO_CONFIG}: {exc}")
        lensgo_ws_port, lensgo_http_port = 18765, 18000
    for host, port, label in (
        ("127.0.0.1", int(env_value(env, "QWENPAW_PORT", "18088")), "QwenPaw"),
        ("127.0.0.1", lensgo_ws_port, "LensGo WebSocket"),
        ("127.0.0.1", lensgo_http_port, "LensGo HTTP/Bridge"),
    ):
        report("OK" if port_available(host, port) else "WARN", f"{label} port {port} available")
    report("OK" if shutil.which("git") else "WARN", "git executable")
    report("OK" if shutil.which("npm") else "WARN", "npm executable (optional console build)")
    report(
        "OK" if importlib.util.find_spec("webview") else "WARN",
        "pywebview (required by the standalone App)",
    )
    print(f"\nDoctor completed: {errors} error(s).")
    return 1 if errors else 0


def stop_processes(processes: list[subprocess.Popen[bytes]]) -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 8
    for process in processes:
        if process.poll() is not None:
            continue
        remaining = max(0.0, deadline - time.monotonic())
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            process.kill()


def start(args: argparse.Namespace) -> int:
    env = integrated_env()
    if not venv_python().is_file() or not venv_qwenpaw().is_file():
        print("Run bootstrap first; integrated .venv is missing.", file=sys.stderr)
        return 2
    if not (QWEN_WORKING / "config.json").is_file():
        print("Run bootstrap first; integrated QwenPaw workspace is missing.", file=sys.stderr)
        return 2

    qwen_port = int(env_value(env, "QWENPAW_PORT", "18088"))
    qwen_host = env_value(env, "QWENPAW_HOST", "127.0.0.1")
    agent_id = env_value(env, "QWENPAW_AGENT_ID", "lensgo-travel-director")
    processes: list[subprocess.Popen[bytes]] = []
    commands: list[tuple[str, list[str], Path]] = []
    if not args.glasses_only:
        commands.append(
            (
                "QwenPaw",
                [str(venv_qwenpaw()), "app", "--host", qwen_host, "--port", str(qwen_port)],
                QWENPAW,
            )
        )
    if not args.qwen_only:
        commands.append(
            (
                "LensGo",
                [
                    str(venv_python()),
                    "-m",
                    "glasses.server",
                    "--config",
                    str(LENSGO_CONFIG),
                    "--qwenpaw-base-url",
                    f"http://127.0.0.1:{qwen_port}",
                    "--qwenpaw-agent-id",
                    agent_id,
                ],
                GLASSES,
            )
        )

    if not commands:
        print("Choose at most one of --qwen-only and --glasses-only.", file=sys.stderr)
        return 2

    for name, command, cwd in commands:
        print(f"[start] {name}: {subprocess.list2cmdline(command)}", flush=True)
        processes.append(subprocess.Popen(command, cwd=cwd, env=env))
        time.sleep(0.5)
        if processes[-1].poll() is not None:
            stop_processes(processes)
            return processes[-1].returncode or 1

    print("[start] services are running; press Ctrl+C to stop this process group")
    try:
        while True:
            for process in processes:
                code = process.poll()
                if code is not None:
                    print(f"[start] child process exited with code {code}", file=sys.stderr)
                    return code
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[start] stopping...")
        return 0
    finally:
        stop_processes(processes)


def _show_app_error(message: str) -> None:
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, "LensGo App", 0x10)
            return
        except Exception:
            pass
    print(message, file=sys.stderr)


def app(_args: argparse.Namespace) -> int:
    """Run both services and host the existing Console in a native window."""
    if not venv_python().is_file() or not venv_qwenpaw().is_file():
        _show_app_error("请先运行 scripts\\bootstrap.ps1 初始化项目环境。")
        return 2
    if not (QWEN_WORKING / "config.json").is_file():
        _show_app_error("集成工作区尚未初始化，请先运行 bootstrap。")
        return 2
    console_index = QWENPAW / "console" / "dist" / "index.html"
    if not console_index.is_file():
        _show_app_error(
            "尚未构建可视化界面。请先运行 "
            "scripts\\bootstrap.ps1 --build-console。"
        )
        return 2
    try:
        import webview
    except ImportError:
        _show_app_error("缺少 pywebview。请重新运行 bootstrap 安装 App 依赖。")
        return 2

    env = integrated_env()
    qwen_port = int(env_value(env, "QWENPAW_PORT", "18088"))
    qwen_host = env_value(env, "QWENPAW_HOST", "127.0.0.1")
    probe_host = "127.0.0.1" if qwen_host in ("0.0.0.0", "::") else qwen_host
    if not port_available(probe_host, qwen_port):
        _show_app_error(f"QwenPaw 端口 {qwen_port} 已被占用。请先关闭占用该端口的程序。")
        return 2
    try:
        lensgo_ws_port, lensgo_http_port = lensgo_ports()
    except (OSError, ValueError, TypeError, tomllib.TOMLDecodeError) as exc:
        _show_app_error(f"无法读取 LensGo 端口配置：{exc}")
        return 2
    for port, label in (
        (lensgo_ws_port, "LensGo WebSocket"),
        (lensgo_http_port, "LensGo HTTP"),
    ):
        if not port_available("127.0.0.1", port):
            _show_app_error(f"{label} 端口 {port} 已被占用。请先关闭占用该端口的程序。")
            return 2

    agent_id = env_value(env, "QWENPAW_AGENT_ID", "lensgo-travel-director")
    commands = (
        (
            "qwenpaw",
            [str(venv_qwenpaw()), "app", "--host", qwen_host, "--port", str(qwen_port)],
            QWENPAW,
        ),
        (
            "lensgo",
            [
                str(venv_python()),
                "-m",
                "glasses.server",
                "--config",
                str(LENSGO_CONFIG),
                "--qwenpaw-base-url",
                f"http://127.0.0.1:{qwen_port}",
                "--qwenpaw-agent-id",
                agent_id,
            ],
            GLASSES,
        ),
    )
    log_dir = RUNTIME / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    processes: list[subprocess.Popen[bytes]] = []
    log_handles = []
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        for name, command, cwd in commands:
            handle = (log_dir / f"{name}-app.log").open("ab")
            log_handles.append(handle)
            processes.append(
                subprocess.Popen(
                    command,
                    cwd=cwd,
                    env=env,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    creationflags=creationflags,
                )
            )

        url = f"http://{probe_host}:{qwen_port}"
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            failed = next((p for p in processes if p.poll() is not None), None)
            if failed is not None:
                _show_app_error(
                    f"服务启动失败（退出码 {failed.returncode}）。"
                    f"请查看 {log_dir} 中的 App 日志。"
                )
                return failed.returncode or 1
            if check_http(url, timeout=1.0):
                break
            time.sleep(0.4)
        else:
            _show_app_error(f"QwenPaw 启动超时。请查看 {log_dir} 中的 App 日志。")
            return 1

        webview.create_window(
            "LensGo 澳门旅行助手",
            url,
            width=1440,
            height=900,
            min_size=(1024, 700),
            text_select=True,
        )
        webview.start(
            private_mode=False,
            storage_path=str((QWEN_WORKING / "app_webview").resolve()),
        )
        return 0
    finally:
        stop_processes(processes)
        for handle in log_handles:
            handle.close()


def test_all(args: argparse.Namespace) -> int:
    python = venv_python() if venv_python().is_file() else Path(sys.executable)
    run([python, "-m", "unittest", "discover", "-s", ROOT / "tests", "-v"])
    if args.layout_only:
        return 0
    run([python, "-m", "pytest", GLASSES / "tests"], cwd=GLASSES)
    run([python, "-m", "pytest", QWENPAW / "tests"], cwd=QWENPAW)
    return 0


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(
        description="LensGo × QwenPaw non-destructive integration orchestrator"
    )
    sub = top.add_subparsers(dest="command", required=True)
    doctor_parser = sub.add_parser("doctor", help="check modules, tools and optional services")
    doctor_parser.set_defaults(handler=doctor)

    bootstrap_parser = sub.add_parser("bootstrap", help="initialize the integrated runtime")
    bootstrap_parser.add_argument("--skip-install", action="store_true")
    bootstrap_parser.add_argument("--build-console", action="store_true")
    bootstrap_parser.set_defaults(handler=bootstrap)

    start_parser = sub.add_parser("start", help="run QwenPaw and LensGo together")
    mode = start_parser.add_mutually_exclusive_group()
    mode.add_argument("--qwen-only", action="store_true")
    mode.add_argument("--glasses-only", action="store_true")
    start_parser.set_defaults(handler=start)

    app_parser = sub.add_parser("app", help="run the integrated standalone desktop App")
    app_parser.set_defaults(handler=app)

    test_parser = sub.add_parser("test", help="run integrated and module tests")
    test_parser.add_argument("--layout-only", action="store_true")
    test_parser.set_defaults(handler=test_all)
    return top


def main() -> int:
    args = parser().parse_args()
    try:
        return int(args.handler(args))
    except subprocess.CalledProcessError as exc:
        return int(exc.returncode or 1)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
