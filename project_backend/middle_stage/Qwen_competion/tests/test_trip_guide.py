"""Guide-only POI contract tests; no network, keys or user workspace required."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import mock_open, patch

from fastapi import HTTPException

PATH = Path(__file__).resolve().parents[1] / "qwen_compitition/src/qwenpaw/app/routers/travel_planner.py"
spec = importlib.util.spec_from_file_location("trip_guide_endpoint", PATH)
guide = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guide)


class GuideNearbyTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_configuration_is_explicit_and_does_not_call_map(self):
        with patch.object(guide, "_guide_amap_key", return_value=""), patch.object(guide, "_fetch_guide_pois") as fetch:
            result = await guide.get_guide_nearby({"latitude": 22.19, "longitude": 113.54, "kind": "food"})
        self.assertFalse(result["available"])
        self.assertIn("未配置", result["reason"])
        fetch.assert_not_called()

    async def test_validates_coordinates_and_kind_before_any_network(self):
        for data in [
            {"latitude": float("nan"), "longitude": 113, "kind": "food"},
            {"latitude": 91, "longitude": 113, "kind": "food"},
            {"latitude": 22, "longitude": True, "kind": "photo"},
            {"latitude": 22, "longitude": 113, "kind": "hotel"},
        ]:
            with self.assertRaises(HTTPException) as error:
                await guide.get_guide_nearby(data)
            self.assertEqual(error.exception.status_code, 400)

    async def test_ratings_distance_deduplication_and_missing_values(self):
        pois = [
            {"id": "a", "name": "Near", "location": "113.54,22.19", "distance": "100", "biz_ext": {"rating": "4.3"}},
            {"id": "b", "name": "Rated", "location": "113.54,22.19", "distance": "400", "biz_ext": {"rating": "4.9"}},
            {"id": "c", "name": "Unrated", "location": "113.54,22.19", "distance": "20", "biz_ext": {"rating": []}, "address": []},
            {"id": "d", "name": "Too far", "location": "113.54,22.19", "distance": "5000"},
            {"id": "e", "name": "Invalid", "location": "NaN,22.19", "distance": "2"},
        ]
        with patch.object(guide, "_guide_amap_key", return_value="test-only"), patch.object(guide, "_fetch_guide_pois", return_value={"status": "1", "pois": pois + pois}):
            result = await guide.get_guide_nearby({"latitude": 22.19, "longitude": 113.54, "kind": "photo"})
        self.assertTrue(result["available"])
        self.assertEqual([p["id"] for p in result["items"]], ["b", "a", "c"])
        self.assertIsNone(result["items"][-1]["rating"])
        self.assertEqual(result["items"][-1]["address"], "")

    async def test_upstream_failure_never_leaks_key_or_url(self):
        with patch.object(guide, "_guide_amap_key", return_value="private-test-key"), patch.object(guide, "_fetch_guide_pois", side_effect=RuntimeError("https://example.test?key=private-test-key")):
            result = await guide.get_guide_nearby({"latitude": 22.19, "longitude": 113.54, "kind": "food"})
        self.assertFalse(result["available"])
        self.assertNotIn("private-test-key", str(result))


class GuideOriginTests(unittest.IsolatedAsyncioTestCase):
    async def test_nearest_hotel_is_only_identified_as_nearby(self):
        payload = {"status": "1", "regeocode": {"pois": [
            {"name": "景点", "distance": "150", "type": "风景名胜"},
            {"name": "演示酒店", "distance": "12", "type": "住宿服务;酒店"},
        ]}}
        with patch.object(guide, "_guide_amap_key", return_value="test"), patch.object(guide, "_fetch_guide_origin", return_value=payload):
            result = await guide.get_guide_origin({"latitude": 22.19, "longitude": 113.54})
        self.assertEqual(result["kind"], "hotel")
        self.assertEqual(result["label"], "你目前在演示酒店附近")

    async def test_invalid_coordinates_do_not_reach_map(self):
        with patch.object(guide, "_fetch_guide_origin") as fetch:
            for lat, lng in [(True, 113), (float("nan"), 113), (22, 181), (91, 113)]:
                with self.assertRaises(HTTPException):
                    await guide.get_guide_origin({"latitude": lat, "longitude": lng})
        fetch.assert_not_called()

    async def test_upstream_failure_is_sanitized(self):
        with patch.object(guide, "_guide_amap_key", return_value="test"), patch.object(guide, "_fetch_guide_origin", side_effect=RuntimeError("secret-url")):
            result = await guide.get_guide_origin({"latitude": 22, "longitude": 113})
        self.assertFalse(result["available"])
        self.assertNotIn("secret-url", str(result))

    def test_missing_values_address_and_distant_pois(self):
        self.assertFalse(guide._guide_origin({"regeocode": {"pois": [], "formatted_address": []}})["available"])
        result = guide._guide_origin({"regeocode": {"pois": [{"name": "远处酒店", "distance": "800"}], "formatted_address": "澳门某街"}})
        self.assertEqual(result["kind"], "address")
        self.assertNotIn("酒店", result["label"])


class GuideKeyReuseTests(unittest.TestCase):
    def test_existing_guide_key_takes_priority_without_reading_crowd_file(self):
        with patch.object(guide, "_amap_key", return_value="test-guide"), patch.object(Path, "open") as read:
            self.assertEqual(guide._guide_amap_key(), "test-guide")
        read.assert_not_called()

    def test_reuses_only_map_fields_without_mutating_environment(self):
        read = mock_open(read_data='OTHER_SECRET=not-for-guide\nAMAP_KEY=fallback\n AMAP_WEB_KEY = "test-crowd"\n')
        with patch.object(guide, "_amap_key", return_value=""), patch.dict(os.environ, {"LENSGO_CROWD_PROJECT_ROOT": "../data_publish"}, clear=True), patch.object(Path, "open", read):
            before = dict(os.environ)
            self.assertEqual(guide._guide_amap_key(), "test-crowd")
            self.assertEqual(dict(os.environ), before)
        read.assert_called_once_with(encoding="utf-8-sig")

    def test_environment_precedence_matches_crowd_service(self):
        with patch.object(guide, "_amap_key", return_value=""), patch.dict(os.environ, {"AMAP_WEB_KEY": "test-env"}, clear=True), patch.object(Path, "open", mock_open(read_data='AMAP_WEB_KEY=test-file\n')):
            self.assertEqual(guide._guide_amap_key(), "test-env")

    def test_missing_or_unreadable_shared_file_is_safe(self):
        with patch.object(guide, "_amap_key", return_value=""), patch.dict(os.environ, {}, clear=True), patch.object(Path, "open", side_effect=OSError("private-path-not-for-response")):
            self.assertEqual(guide._guide_amap_key(), "")


if __name__ == "__main__":
    unittest.main()
