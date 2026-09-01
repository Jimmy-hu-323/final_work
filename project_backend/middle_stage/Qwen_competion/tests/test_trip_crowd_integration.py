from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MOBILE = ROOT / "qwen_compitition" / "console" / "src" / "mobile-local"
ANDROID = (
    ROOT
    / "qwen_compitition"
    / "console"
    / "src-tauri"
    / "gen"
    / "android"
    / "app"
    / "src"
    / "main"
)
TAURI = ROOT / "qwen_compitition" / "console" / "src-tauri"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_trip_page_requires_explicit_activation_and_offers_replanning():
    source = read(MOBILE / "MobileLocalApp.tsx")
    assert "确认开始这份行程" in source
    assert "允许定位并开始" in source
    assert "接下来想去哪里" in source
    assert "先自由走走" in source
    assert "showNextStopReminder" not in source
    assert "locateDepartureOrigin(position" in source
    assert "replanTrip(selected.id)" in source
    assert "watchPosition" in read(MOBILE / "tripGuideRuntime.ts")
    assert 'status: "active"' in source
    assert "requestInitialTripPosition()" not in source
    assert 'departurePendingTripRef.current = active?.id || ""' in source
    assert "行程已开始，正在后台获取手机位置" in source


def test_chat_navigation_uses_one_time_location_and_private_post_body():
    source = read(MOBILE / "MobileLocalApp.tsx")
    runtime = read(MOBILE / "runtime.ts")
    rust = read(TAURI / "src" / "mobile_runtime.rs")
    permissions = read(TAURI / "permissions" / "mobile-runtime.toml")
    assert "parseChatNavigationIntent(text)" in source
    assert "requestChatNavigationPosition()" in source
    assert "position.accuracy > 250" in source
    assert "fetchChatNavigation(" in source
    assert 'invoke<ChatNavigationResponse>("mobile_chat_navigation"' in runtime
    assert 'qwenpaw_endpoint(&settings, "/api/travel-planner/navigation")' in rust
    assert "reqwest::Method::POST" in rust
    assert '"mobile_chat_navigation"' in permissions


def test_crowd_client_uses_publisher_contract_and_stale_guard():
    source = read(MOBILE / "tripJourney.ts")
    assert "/api/density/latest?city_id=macau&level=poi&include_empty=1" in source
    assert "CROWD_STALE_MINUTES = 30" in source
    assert "reading: null" in source
    assert "wgs84ToGcj02" in source
    assert "reorderRemainingStops" in source
    assert "todayRemaining" in source


def test_android_has_location_permissions_and_native_trip_alert_bridge():
    manifest = read(ANDROID / "AndroidManifest.xml")
    assert "android.permission.ACCESS_COARSE_LOCATION" in manifest
    assert "android.permission.ACCESS_FINE_LOCATION" in manifest
    bridge = read(
        ANDROID
        / "java"
        / "io"
        / "lensgo"
        / "macao"
        / "mobile"
        / "local"
        / "LensGoTripBridge.kt"
    )
    assert "@JavascriptInterface" in bridge
    assert "TextToSpeech" in bridge
    assert "NotificationCompat" in bridge
    assert "LocationManager" in bridge
    assert "startLocationUpdates" in bridge
    assert "LOCATION_PERMISSION_REQUEST" in bridge
    assert "LensGo 行程与客流提醒" in bridge


def test_android_build_and_ide_cache_are_redirected_to_d_drive():
    build_script = read(ROOT / "scripts" / "build_android.ps1")
    studio_script = read(ROOT / "scripts" / "start_android_studio_d.ps1")
    properties = read(ROOT / "scripts" / "android-studio-d.properties")
    assert r"D:\Android_studio\LensGoCache" in build_script
    assert "ANDROID_SDK_ROOT" in build_script
    assert r"D:\Android_studio\LensGoCache" in studio_script
    assert "idea.system.path=D:/Android_studio/LensGoCache/studio/system" in properties
    assert "Creation symbolic link is not allowed" in build_script
    assert ":app:assembleArm64Debug" in build_script


def test_mobile_runtime_commands_are_allowed_by_mobile_capability():
    capability = read(TAURI / "capabilities" / "mobile.json")
    permission = read(TAURI / "permissions" / "mobile-runtime.toml")
    assert '"mobile-runtime"' in capability
    for command in (
        "mobile_load_settings",
        "mobile_save_settings",
        "mobile_test_provider",
        "mobile_chat",
        "mobile_analyze_image",
        "mobile_generate_image",
        "mobile_test_qwenpaw",
        "mobile_qwenpaw_chat",
        "mobile_trip_guide_origin",
        "mobile_trip_guide_nearby",
        "mobile_upload_cloud_photo",
        "mobile_delete_cloud_photo",
    ):
        assert command in permission


def test_qwenpaw_chat_keeps_local_data_behind_explicit_permissions():
    app = read(MOBILE / "MobileLocalApp.tsx")
    runtime = read(MOBILE / "runtime.ts")
    qwenpaw = read(MOBILE / "qwenpaw.ts")
    assert "shareTripsWithAgent" in app
    assert 'albumSyncMode: "off"' in runtime
    assert "localOnlyPhotosAreExcluded" in app
    assert "cloudFileId" in app
    assert "streamQwenPawChat" in app
    assert "lensgo-qwenpaw-event" in qwenpaw
    assert "子 Agent" in qwenpaw


def test_trip_cards_are_collapsible_and_route_map_is_restored():
    app = read(MOBILE / "MobileLocalApp.tsx")
    route_map = read(MOBILE / "TripRouteMap.tsx")
    styles = read(MOBILE / "mobileLocal.module.less")
    assert "expandedTripId" in app
    assert "TripRouteMap" in app
    assert "L.polyline" in route_map
    assert "当前离线" in route_map
    assert ".tripMapMarker_next" in styles


def test_cloud_album_has_private_qwenpaw_fallback():
    router = read(
        ROOT
        / "qwen_compitition"
        / "src"
        / "qwenpaw"
        / "app"
        / "routers"
        / "travel_planner.py"
    )
    assert "lensgo-cloud-album" in router
    assert "qwenpaw-local-fallback" in router
    assert "_store_local_album_photo" in router
    assert "_delete_local_album_photo" in router


def test_mobile_backend_start_script_keeps_runtime_on_d_drive():
    script = read(ROOT / "scripts" / "start_lensgo_mobile_backend.ps1")
    assert r"D:\Android_studio\LensGoCache" in script
    assert "QWENPAW_WORKING_DIR" in script
    assert "LENSGO_CROWD_PROJECT_ROOT" in script
    assert "crowd-mobile.out.log" in script
    assert 'reverse "tcp:$QwenPawPort"' in script
    assert 'reverse "tcp:$CrowdPort"' in script


def test_qwenpaw_has_read_only_publish_crowd_mcp():
    orchestrator = read(ROOT / "scripts" / "integrated.py")
    server = read(ROOT / "scripts" / "mcp" / "lensgo_crowd_server.py")
    env_example = read(ROOT / ".env.integrated.example")
    assert "lensgo-crowd.yaml" in orchestrator
    assert "lensgo_latest_crowd" in orchestrator
    assert "lensgo_place_crowd" in orchestrator
    assert "/api/density/latest" in server
    assert "Authorization" in server
    assert "@mcp.tool()" in server
    assert '"is_stale"' in server
    assert "LENSGO_CROWD_STALE_MINUTES" in server
    assert "LENSGO_CROWD_BASE_URL=http://127.0.0.1:18099" in env_example
