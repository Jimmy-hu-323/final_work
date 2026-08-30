"""Loopback-only Android location demo controller. Python standard library only."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
APP_PACKAGE = "io.lensgo.macao.mobile.local"
# Approximate WGS84 demonstration points from the public project seed_data.py.
# Hotel labels describe a nearby starting area, not a verified indoor position.
PRESETS = [
    {"id": "outside", "name": "景点外 · 演示起点", "latitude": 22.185, "longitude": 113.53, "group": "半岛", "hint": "先在这里点击 App 的开始旅程"},
    {"id": "stpaul", "name": "大三巴牌坊", "latitude": 22.1977, "longitude": 113.5408, "group": "半岛", "hint": "切换后停留约 30 秒，观察自动导览"},
    {"id": "senado", "name": "议事亭前地", "latitude": 22.1935, "longitude": 113.5397, "group": "半岛", "hint": "不必按路线顺序，可直接前往"},
]
for preset_id, name, lat, lng, group in [
    ("grand-lisboa", "新葡京附近", 22.1892, 113.5433, "酒店出发"),
    ("venetian", "威尼斯人附近", 22.1459, 113.5595, "酒店出发"),
    ("parisian", "巴黎人附近", 22.1425, 113.5645, "酒店出发"),
    ("londoner", "伦敦人附近", 22.1450, 113.5620, "酒店出发"),
    ("galaxy", "银河综合渡假城附近", 22.1490, 113.5555, "酒店出发"),
    ("mount-fortress", "大炮台", 22.1971, 113.5418, "半岛"),
    ("macau-museum", "澳门博物馆", 22.1968, 113.5415, "半岛"),
    ("st-dominic", "玫瑰堂", 22.1943, 113.5399, "半岛"),
    ("municipal", "市政署大楼", 22.1930, 113.5392, "半岛"),
    ("ama-temple", "妈阁庙", 22.1863, 113.5312, "半岛"),
    ("macau-tower", "澳门旅游塔", 22.1799, 113.5367, "半岛"),
    ("guia", "东望洋灯塔", 22.1965, 113.5495, "半岛"),
    ("lou-lim-ioc", "卢廉若公园", 22.1993, 113.5476, "半岛"),
    ("fisherman", "渔人码头", 22.1946, 113.5556, "半岛"),
    ("science", "澳门科学馆", 22.1893, 113.5507, "半岛"),
    ("taipa-houses", "龙环葡韵", 22.1548, 113.5599, "氹仔路氹"),
    ("carmo", "嘉模圣母堂", 22.1552, 113.5590, "氹仔路氹"),
    ("university", "澳门大学", 22.1300, 113.5450, "氹仔路氹"),
    ("hac-sa", "黑沙海滩", 22.1148, 113.5620, "路环"),
    ("cheoc-van", "竹湾海滩", 22.1150, 113.5555, "路环"),
    ("st-francis", "圣方济各圣堂", 22.1178, 113.5645, "路环"),
    ("lord-stow", "安德鲁饼店", 22.1175, 113.5648, "路环"),
]:
    PRESETS.append({"id": preset_id, "name": name, "latitude": lat, "longitude": lng,
                    "group": group, "hint": "酒店附近 · 用于演示出发地识别" if group == "酒店出发"
                    else f"{group} · 保持定位约 30 秒观察手机"})


class DemoError(Exception):
    pass


class MockProviderMissing(DemoError):
    """Only this known recoverable condition permits re-registering our source."""
    pass


def number(value, low, high):
    if isinstance(value, bool):
        raise DemoError("坐标必须是有效数字")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise DemoError("请填写有效的经纬度") from None
    if not math.isfinite(result) or not low <= result <= high:
        raise DemoError("经纬度超出有效范围")
    return result


def wgs_to_gcj(lat, lng):
    if not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271):
        return lat, lng
    x, y, pi = lng - 105, lat - 35, math.pi
    a = -100 + 2*x + 3*y + .2*y*y + .1*x*y + .2*math.sqrt(abs(x))
    b = 300 + x + 2*y + .1*x*x + .1*x*y + .1*math.sqrt(abs(x))
    common = (20*math.sin(6*x*pi) + 20*math.sin(2*x*pi))*2/3
    a += common + (20*math.sin(y*pi)+40*math.sin(y*pi/3))*2/3 + (160*math.sin(y*pi/12)+320*math.sin(y*pi/30))*2/3
    b += common + (20*math.sin(x*pi)+40*math.sin(x*pi/3))*2/3 + (150*math.sin(x*pi/12)+300*math.sin(x*pi/30))*2/3
    rad = lat*pi/180
    magic = 1 - .006693421622965943 * math.sin(rad)**2
    return (lat + a*180/((6378245*(1-.006693421622965943)/(magic*math.sqrt(magic)))*pi),
            lng + b*180/(6378245/math.sqrt(magic)*math.cos(rad)*pi))


def target_from(data):
    preset = next((p for p in PRESETS if p["id"] == data.get("preset")), None)
    if data.get("preset") and not preset:
        raise DemoError("未知的景点预设")
    source = preset or data
    lat, lng = number(source.get("latitude"), -90, 90), number(source.get("longitude"), -180, 180)
    coordinate = "wgs84" if preset else data.get("coordinate", "wgs84")
    if coordinate not in ("wgs84", "gcj02"):
        raise DemoError("请选择 WGS84 或 GCJ02 坐标系")
    if coordinate == "gcj02":
        wanted_lat, wanted_lng = lat, lng
        for _ in range(8):
            converted_lat, converted_lng = wgs_to_gcj(lat, lng)
            lat += wanted_lat-converted_lat
            lng += wanted_lng-converted_lng
    number(lat, -90, 90)
    number(lng, -180, 180)
    map_lat, map_lng = wgs_to_gcj(lat, lng)
    return {"latitude": lat, "longitude": lng, "mapLatitude": map_lat, "mapLongitude": map_lng,
            "name": str(source.get("name") or "自定义位置")[:48], "preset": preset["id"] if preset else None}


def find_adb(explicit=None):
    candidates = [explicit, os.getenv("ADB_PATH"), shutil.which("adb")]
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.getenv(name):
            candidates.append(str(Path(os.environ[name]) / "platform-tools" / "adb.exe"))
    if os.getenv("LOCALAPPDATA"):
        candidates.append(str(Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk/platform-tools/adb.exe"))
    return next((str(Path(p).resolve()) for p in candidates if p and Path(p).is_file()), None)


class Adb:
    def __init__(self, path):
        self.path = path

    def run(self, args):
        if not self.path:
            raise DemoError("未找到 ADB，请用 --adb 指定 Android SDK 中的 adb.exe")
        try:
            result = subprocess.run([self.path, *args], shell=False, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=8,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired):
            raise DemoError("ADB 无响应，请检查 USB 连接并重试恢复定位") from None
        output = result.stdout + result.stderr
        if result.returncode or "Exception occurred" in output or "SecurityException" in output:
            if "not a test provider" in output:
                raise MockProviderMissing("手机模拟位置源已失效")
            raise DemoError("手机未接受 ADB 指令，请检查 USB 授权、连接和开发者选项")
        return result.stdout.strip()

    def shell(self, serial, *args):
        return self.run(["-s", serial, "shell", *args])

    def devices(self):
        result = []
        for line in self.run(["devices", "-l"]).splitlines():
            parts = line.split()
            if len(parts) < 2 or parts[1] not in ("device", "unauthorized", "offline"):
                continue
            model = next((p.split(":", 1)[1] for p in parts if p.startswith("model:")), "Android 手机")
            result.append({"serial": parts[0], "state": parts[1], "model": model.replace("_", " ")})
        return result


class Controller:
    INTERVAL = 5
    LEASE = 90
    MAX_SESSION = 30*60

    def __init__(self, adb, journal, clock=time.time):
        self.adb, self.journal, self.clock = adb, Path(journal), clock
        self.lock = threading.RLock()
        self.session = None
        self.active = False
        self.last_error = ""
        self.events = []
        self.devices_cache = []
        self.devices_time = 0
        self.last_heartbeat = 0
        self.last_attempt = 0
        self.recovery_times = []
        try:
            saved = json.loads(self.journal.read_text(encoding="utf-8"))
            if not isinstance(saved, dict) or not re.fullmatch(r"[A-Za-z0-9_.:\-]+", saved.get("serial", "")) or saved.get("mode") not in ("default", "allow", "deny", "ignore", "foreground", "errored"):
                raise ValueError()
            self.session = saved
            self.last_error = "上次控制未正常结束，请连接原手机并点击恢复真实定位"
        except FileNotFoundError:
            pass
        except (ValueError, OSError):
            raise DemoError("恢复记录损坏，请先检查 .runtime/session.json；为安全起见未启动控制") from None

    def event(self, text):
        self.events = [{"time": self.clock(), "text": text}, *self.events][:12]

    def save(self):
        self.journal.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.journal.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.session, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.journal)

    def devices(self, refresh=False):
        if refresh or not self.devices_time or self.clock()-self.devices_time > 5:
            self.devices_cache = self.adb.devices()
            self.devices_time = self.clock()
        return self.devices_cache

    def check_device(self, serial):
        if not isinstance(serial, str) or not re.fullmatch(r"[A-Za-z0-9_.:\-]+", serial):
            raise DemoError("请先选择连接的手机")
        if not any(d["serial"] == serial and d["state"] == "device" for d in self.devices(True)):
            raise DemoError("手机未连接或未授权，请在手机上允许 USB 调试")

    def status(self):
        with self.lock:
            connection_error = ""
            try:
                devices = self.devices()
            except DemoError as exc:
                devices, connection_error = [], str(exc)
            session = self.session
            return {"service": "lensgo-location-demo", "adbAvailable": bool(self.adb.path),
                    "devices": devices, "active": self.active, "needsRestore": bool(session),
                    "serial": session["serial"] if session else None,
                    "target": session.get("target") if session else None,
                    "samples": session.get("samples", 0) if session else 0,
                    "elapsed": max(0, int(self.clock()-session.get("pointAt", self.clock()))) if self.active else 0,
                    "lastSentAt": session.get("lastSentAt") if session else None,
                    "recoveries": session.get("recoveries", 0) if session else 0,
                    "error": self.last_error or connection_error, "events": self.events,
                    "interval": self.INTERVAL, "lease": self.LEASE}

    def start(self, data):
        target = target_from(data)
        with self.lock:
            if self.session:
                raise DemoError("请先恢复当前手机的真实定位，再开始新的控制")
            serial = data.get("serial")
            self.check_device(serial)
            if self.adb.shell(serial, "cmd", "location", "is-location-enabled") != "true":
                raise DemoError("请先在手机上开启系统定位；控制台不会擅自改变定位开关")
            operations = self.adb.shell(serial, "appops", "get", "com.android.shell", "android:mock_location")
            match = re.search(r"MOCK_LOCATION:\s*(default|allow|deny|ignore|foreground|errored)", operations)
            mode = match.group(1) if match else "default"
            other = self.adb.shell(serial, "appops", "query-op", "android:mock_location", "allow")
            if mode == "allow" or any(line.strip() and not line.startswith("No operations") for line in other.splitlines()):
                raise DemoError("已有模拟定位授权被其他工具使用。请先在原工具中结束模拟，再使用此控制台")
            now = self.clock()
            self.session = {"serial": serial, "mode": mode, "providerTouched": False,
                            "target": target, "startedAt": now, "pointAt": now, "samples": 0,
                            "recoveries": 0}
            self.recovery_times = []
            self.save()  # Journal BEFORE any phone mutation; crashes remain recoverable.
            try:
                self.adb.shell(serial, "appops", "set", "com.android.shell", "android:mock_location", "allow")
                self.session["providerTouched"] = True
                self.save()
                self.adb.shell(serial, "cmd", "location", "providers", "add-test-provider", "network", "--requiresNetwork")
                self.adb.shell(serial, "cmd", "location", "providers", "set-test-provider-enabled", "network", "true")
                self.send()
                self.active = True
                self.last_heartbeat = now
                self.last_error = ""
                self.event("开始系统模拟定位 · " + target["name"])
            except (DemoError, OSError) as exc:
                try:
                    self.restore()
                except DemoError:
                    pass
                raise DemoError(str(exc) if isinstance(exc, DemoError) else "无法保存恢复记录，已尝试恢复手机") from None

    def check_mock_access(self):
        serial = self.session["serial"]
        mode = self.adb.shell(serial, "appops", "get", "com.android.shell", "android:mock_location")
        if not re.search(r"MOCK_LOCATION:\s*allow\b", mode):
            # Never re-grant a permission revoked by the user or system.
            raise DemoError("模拟定位授权已取消，已停止发送；请恢复后重新确认")
        owners = self.adb.shell(serial, "appops", "query-op", "android:mock_location", "allow")
        if any(line.strip() and line.strip() != "com.android.shell" and not line.startswith("No operations")
               for line in owners.splitlines()):
            raise DemoError("其他模拟工具已取得授权，已停止发送，避免覆盖它的位置")

    def recover_provider(self):
        self.check_device(self.session["serial"])
        self.check_mock_access()
        if self.adb.shell(self.session["serial"], "cmd", "location", "is-location-enabled") != "true":
            raise DemoError("系统定位已关闭，已停止发送，不会擅自开启")
        now = self.clock()
        self.recovery_times = [at for at in self.recovery_times if now-at < 60]
        if len(self.recovery_times) >= 3:
            raise DemoError("模拟位置源反复失效（一分钟内三次重连），已停止；请检查手机模拟定位设置")
        self.recovery_times.append(now)
        self.session["recoveries"] = self.session.get("recoveries", 0)+1
        self.session["pointAt"] = now  # Interrupted dwell must not look continuous in the UI.
        self.save()
        self.adb.shell(self.session["serial"], "cmd", "location", "providers", "add-test-provider", "network", "--requiresNetwork")
        self.adb.shell(self.session["serial"], "cmd", "location", "providers", "set-test-provider-enabled", "network", "true")

    def send(self):
        self.check_mock_access()
        session = self.session
        target = session["target"]
        args = ("cmd", "location", "providers", "set-test-provider-location", "network",
                "--location", f'{target["latitude"]:.7f},{target["longitude"]:.7f}', "--accuracy", "5")
        try:
            self.adb.shell(session["serial"], *args)
        except MockProviderMissing:
            self.recover_provider()
            self.adb.shell(session["serial"], *args)  # Exactly one retry, no recursive loop.
            self.event(f"模拟位置源失效，已安全重连并继续发送（累计 {session['recoveries']} 次）")
        session["lastSentAt"] = self.clock()
        session["samples"] += 1

    def point(self, data):
        target = target_from(data)
        with self.lock:
            if not self.active:
                raise DemoError("请先开始定位控制")
            self.session["target"] = target
            self.session["pointAt"] = self.clock()
            self.last_heartbeat = self.clock()
            self.save()
            try:
                self.send()
                self.event("位置切换 · " + target["name"])
            except (DemoError, OSError) as exc:
                self.active = False
                reason = str(exc) if isinstance(exc, DemoError) else "无法保存恢复记录"
                self.last_error = reason + "；请点击恢复真实定位"
                self.last_attempt = self.clock()
                self.event("定位发送中断：" + reason)
                raise DemoError(self.last_error) from None

    def heartbeat(self):
        with self.lock:
            if self.active:
                self.last_heartbeat = self.clock()

    def restore(self, reason="已恢复真实定位，模拟位置源已移除"):
        with self.lock:
            self.active = False
            if not self.session:
                return
            session = self.session
            try:
                self.check_device(session["serial"])
                owners = self.adb.shell(session["serial"], "appops", "query-op", "android:mock_location", "allow")
                if any(line.strip() and line.strip() != "com.android.shell" and not line.startswith("No operations")
                       for line in owners.splitlines()):
                    # A replacement provider may now belong to that tool.
                    raise DemoError("其他模拟工具可能已接管，请先在原工具结束模拟")
                if session.get("providerTouched"):
                    self.adb.shell(session["serial"], "cmd", "location", "providers", "remove-test-provider", "network")
                self.adb.shell(session["serial"], "appops", "set", "com.android.shell", "android:mock_location", session["mode"])
                self.journal.unlink(missing_ok=True)
            except (DemoError, OSError) as exc:
                reason = str(exc) if isinstance(exc, DemoError) else "无法清理本地恢复记录"
                self.last_error = "恢复尚未完成：" + reason + "；恢复记录已保留，请检查连接和模拟授权后重试"
                raise DemoError(self.last_error) from None
            self.session = None
            self.last_error = ""
            self.event(reason)

    def tick(self):
        with self.lock:
            now = self.clock()
            if self.active:
                if now-self.last_heartbeat > self.LEASE or now-self.session["startedAt"] >= self.MAX_SESSION:
                    try:
                        self.restore("演示会话已超时，已自动恢复真实定位")
                    except DemoError:
                        self.last_attempt = now
                    return
                if now-self.session.get("lastSentAt", 0) >= self.INTERVAL:
                    try:
                        self.send()
                    except (DemoError, OSError) as exc:
                        self.active = False
                        reason = str(exc) if isinstance(exc, DemoError) else "无法保存恢复记录"
                        self.last_error = reason + "；正在等待恢复"
                        self.last_attempt = now
                        self.event("定位发送中断：" + reason)
            elif self.session and now-self.last_attempt > 10:
                self.last_attempt = now
                try:
                    self.restore("模拟已停止，自动恢复真实定位完成")
                except DemoError:
                    pass

    def launch_app(self, serial):
        with self.lock:
            self.check_device(serial)
            self.adb.shell(serial, "am", "start", "-n", APP_PACKAGE + "/.MainActivity")
            self.event("已请求打开 LensGo 澳门旅游助手（本地版）")


class DemoServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, controller):
        super().__init__(("127.0.0.1", port), Handler)
        self.controller = controller
        self.csrf = secrets.token_urlsafe(32)
        self.authorities = {f"127.0.0.1:{self.server_port}", f"localhost:{self.server_port}"}
        self.origins = {"http://" + authority for authority in self.authorities}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log request bodies, coordinates, credentials or ADB output.

    def reply(self, status, data, content_type="application/json; charset=utf-8"):
        body = json.dumps(data, ensure_ascii=False).encode() if not isinstance(data, bytes) else data
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def host_ok(self):
        if self.headers.get("Host") not in self.server.authorities:
            self.reply(403, {"error": "只允许通过本机地址访问"})
            return False
        return True

    def do_GET(self):
        if not self.host_ok():
            return
        path = urlsplit(self.path).path
        if path == "/api/status":
            self.reply(200, self.server.controller.status())
        elif path == "/api/bootstrap":
            self.reply(200, {"csrf": self.server.csrf, "presets": PRESETS, "status": self.server.controller.status()})
        elif path in ("/", "/index.html", "/app.js", "/style.css", "/presets.css"):
            name = "index.html" if path == "/" else path[1:]
            types = {"html": "text/html", "js": "text/javascript", "css": "text/css"}
            self.reply(200, (ROOT / "web" / name).read_bytes(), types[name.rsplit(".", 1)[1]] + "; charset=utf-8")
        else:
            self.reply(404, {"error": "未找到此页面"})

    def do_POST(self):
        if not self.host_ok():
            return
        if self.headers.get("Origin") not in self.server.origins or not secrets.compare_digest(self.headers.get("X-Demo-CSRF", ""), self.server.csrf):
            return self.reply(403, {"error": "控制请求校验失败，请刷新本机控制页"})
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, {"error": "仅接受 JSON 控制请求"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError()
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            return self.reply(400, {"error": "请求格式错误或过大"})
        controller = self.server.controller
        try:
            if self.path == "/api/preview":
                self.reply(200, {"target": target_from(data)})
                return
            elif self.path == "/api/start":
                controller.start(data)
            elif self.path == "/api/point":
                controller.point(data)
            elif self.path == "/api/restore":
                controller.restore()
            elif self.path == "/api/heartbeat":
                controller.heartbeat()
            elif self.path == "/api/open-app":
                controller.launch_app(data.get("serial"))
            elif self.path == "/api/shutdown":
                controller.restore()
                self.reply(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            else:
                return self.reply(404, {"error": "未知控制指令"})
            self.reply(200, controller.status())
        except DemoError as exc:
            self.reply(409, {"error": str(exc), "status": controller.status()})
        except OSError:
            self.reply(500, {"error": "控制台无法保存恢复记录，请检查目录权限并恢复手机定位"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18120)
    parser.add_argument("--adb")
    args = parser.parse_args()
    controller = Controller(Adb(find_adb(args.adb)), ROOT / ".runtime/session.json")
    server = DemoServer(args.port, controller)
    done = threading.Event()

    def worker():
        while not done.wait(1):
            controller.tick()

    threading.Thread(target=worker, daemon=True).start()
    print(f"LensGo location demo: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=.3)
    except KeyboardInterrupt:
        pass
    finally:
        done.set()
        try:
            controller.restore()
        except DemoError:
            print("Restore pending. Reconnect the phone and restart this controller.", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
