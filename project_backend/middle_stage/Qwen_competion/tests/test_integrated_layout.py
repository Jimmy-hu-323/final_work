from __future__ import annotations

import json
import sys
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class IntegratedLayoutTests(unittest.TestCase):
    def test_both_original_modules_are_present(self) -> None:
        expected = [
            ROOT / "lensgo-macao" / "gateway" / "app.py",
            ROOT / "lensgo-macao" / "ai_glasses_debug" / "glasses" / "server" / "app.py",
            ROOT / "qwen_compitition" / "src" / "qwenpaw" / "app" / "_app.py",
            ROOT / "qwen_compitition" / "console" / "src" / "pages" / "TravelPlanner" / "index.tsx",
        ]
        for path in expected:
            with self.subTest(path=path):
                self.assertTrue(path.is_file(), path)

    def test_integrated_ports_and_agent_match(self) -> None:
        with (ROOT / "config" / "lensgo.integrated.toml").open("rb") as handle:
            config = tomllib.load(handle)
        self.assertEqual(config["server"]["port"], 18765)
        self.assertEqual(config["server"]["http_port"], 18000)
        self.assertEqual(config["qwenpaw"]["base_url"], "http://127.0.0.1:18088")
        self.assertEqual(config["qwenpaw"]["agent_id"], "lensgo-travel-director")

        orchestrator = (ROOT / "scripts" / "integrated.py").read_text(encoding="utf-8")
        self.assertIn("lensgo_ports()", orchestrator)
        self.assertNotIn('(18866, "LensGo HTTP")', orchestrator)

        console = ROOT / "qwen_compitition" / "console"
        vite_config = (console / "vite.config.ts").read_text(encoding="utf-8")
        self.assertIn('"http://127.0.0.1:18088"', vite_config)
        for path in (
            console / "src" / "components" / "MobileConnectionGate.tsx",
            console / "src" / "pages" / "LensGoDashboard" / "index.tsx",
        ):
            with self.subTest(path=path):
                self.assertNotIn(":18866", path.read_text(encoding="utf-8"))

    def test_runtime_is_outside_both_modules(self) -> None:
        media = (ROOT / "config" / "../workspace/runtime/lensgo-media").resolve()
        self.assertTrue(media.is_relative_to((ROOT / "workspace").resolve()))
        self.assertFalse(media.is_relative_to((ROOT / "lensgo-macao").resolve()))
        self.assertFalse(media.is_relative_to((ROOT / "qwen_compitition").resolve()))

    def test_persisted_agent_paths_follow_the_current_checkout(self) -> None:
        config_path = ROOT / "workspace" / "qwenpaw" / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        profiles = config["agents"]["profiles"]
        for agent_id, profile in profiles.items():
            expected = (ROOT / "workspace" / "qwenpaw" / "workspaces" / agent_id).resolve()
            with self.subTest(agent=agent_id):
                self.assertEqual(Path(profile["workspace_dir"]).resolve(), expected)
                agent_path = expected / "agent.json"
                if agent_path.is_file():
                    agent = json.loads(agent_path.read_text(encoding="utf-8"))
                    self.assertEqual(Path(agent["workspace_dir"]).resolve(), expected)

    def test_all_prompt_templates_exist(self) -> None:
        base = ROOT / "lensgo-macao" / "qwenpaw_agents"
        for agent_id in (
            "lensgo-travel-director",
            "lensgo-vision-curator",
            "lensgo-memory-keeper",
            "lensgo-media-archivist",
            "lensgo-pose-coach",
        ):
            for name in ("AGENTS.md", "SOUL.md"):
                with self.subTest(agent=agent_id, name=name):
                    self.assertTrue((base / agent_id / name).is_file())

    def test_custom_skills_exist(self) -> None:
        base = ROOT / "qwen_compitition" / "working" / "workspaces" / "default"
        manifest = json.loads((base / "skill.json").read_text(encoding="utf-8"))
        for name in ("macau_trip_planner", "qwenpaw_ai_drive_storage", "lensgo_pose_coach"):
            with self.subTest(skill=name):
                self.assertTrue((base / "skills" / name / "SKILL.md").is_file())
                self.assertIn(name, manifest["skills"])

    def test_standalone_app_and_pose_tool_are_wired(self) -> None:
        expected = (
            ROOT / "scripts" / "app.ps1",
            ROOT / "启动 LensGo App.vbs",
            ROOT
            / "qwen_compitition"
            / "src"
            / "qwenpaw"
            / "agents"
            / "tools"
            / "pose_image.py",
        )
        for path in expected:
            with self.subTest(path=path):
                self.assertTrue(path.is_file(), path)
        orchestrator = (ROOT / "scripts" / "integrated.py").read_text(encoding="utf-8")
        self.assertIn('sub.add_parser("app"', orchestrator)
        self.assertIn('"lensgo-pose-coach"', orchestrator)

    def test_unified_mobile_app_is_wired(self) -> None:
        expected = (
            ROOT / "scripts" / "build_android.ps1",
            ROOT / "docs" / "MOBILE_APP.md",
            ROOT
            / "qwen_compitition"
            / "console"
            / "src"
            / "pages"
            / "LensGoDashboard"
            / "index.tsx",
            ROOT
            / "qwen_compitition"
            / "console"
            / "src-tauri"
            / "tauri.android.conf.json",
        )
        for path in expected:
            with self.subTest(path=path):
                self.assertTrue(path.is_file(), path)
        routes = (
            ROOT
            / "qwen_compitition"
            / "console"
            / "src"
            / "layouts"
            / "registry"
            / "builtinRoutes.tsx"
        ).read_text(encoding="utf-8")
        self.assertIn('path: "/lensgo"', routes)

    def test_mobile_local_runtime_is_wired(self) -> None:
        console = ROOT / "qwen_compitition" / "console"
        expected = (
            ROOT / "docs" / "MOBILE_LOCAL.md",
            console / "src" / "mobile-local" / "MobileLocalApp.tsx",
            console / "src" / "mobile-local" / "runtime.ts",
            console / "src-tauri" / "src" / "mobile_runtime.rs",
            console
            / "src-tauri"
            / "gen"
            / "android"
            / "app"
            / "src"
            / "main"
            / "java"
            / "io"
            / "lensgo"
            / "macao"
            / "mobile"
            / "local"
            / "LensGoRuntimeService.kt",
        )
        for path in expected:
            with self.subTest(path=path):
                self.assertTrue(path.is_file(), path)

        app_source = (console / "src" / "App.tsx").read_text(encoding="utf-8")
        entry_source = (console / "src" / "main.tsx").read_text(encoding="utf-8")
        native_source = (console / "src-tauri" / "src" / "lib.rs").read_text(
            encoding="utf-8"
        )
        runtime_source = (
            console / "src-tauri" / "src" / "mobile_runtime.rs"
        ).read_text(encoding="utf-8")
        android_config = json.loads(
            (console / "src-tauri" / "tauri.android.conf.json").read_text(
                encoding="utf-8"
            )
        )

        self.assertIn("if (MOBILE)", app_source)
        self.assertIn("<MobileLocalApp />", app_source)
        self.assertIn('import("./mobileMain")', entry_source)
        self.assertIn('import("./desktopMain")', entry_source)
        self.assertIn("mobile_runtime::mobile_chat", native_source)
        self.assertIn("mobile_runtime::mobile_analyze_image", native_source)
        self.assertIn("mobile_runtime::mobile_generate_image", native_source)
        self.assertIn("/chat/completions", runtime_source)
        self.assertIn("/images/generations", runtime_source)
        self.assertEqual(android_config["version"], "0.0.1")
        self.assertEqual(
            android_config["identifier"], "io.lensgo.macao.mobile.local"
        )

    def test_supported_python(self) -> None:
        self.assertGreaterEqual(sys.version_info[:2], (3, 11))
        self.assertLess(sys.version_info[:2], (3, 14))


if __name__ == "__main__":
    unittest.main()
