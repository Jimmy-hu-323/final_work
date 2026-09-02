from __future__ import annotations

import unittest
import uuid
from pathlib import Path

from app import db
from app.store import Store, ValidationError


def local_db_path() -> Path:
    return Path(__file__).resolve().parent / f"test-bus-{uuid.uuid4().hex}.db"


def remove_test_db(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()


class BusStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = local_db_path()
        db.init_db(self.db_path)
        self.store = Store(self.db_path)
        self.store.seed_bus()

    def tearDown(self) -> None:
        remove_test_db(self.db_path)

    def test_seed_is_idempotent_and_routes_have_ordered_stops(self) -> None:
        second = self.store.seed_bus()
        self.assertEqual(second["routes"], 0)
        self.assertEqual(second["stops"], 0)

        payload = self.store.list_bus_routes()
        self.assertEqual(payload["source"], "mock")
        self.assertGreaterEqual(payload["count"], 3)
        for route in payload["items"]:
            self.assertGreaterEqual(route["stop_count"], 4)
            self.assertEqual(
                [stop["stop_sequence"] for stop in route["stops"]],
                list(range(route["stop_count"])),
            )

    def test_publish_vehicle_enriches_next_stop_and_arrival(self) -> None:
        route = self.store.list_bus_routes()["items"][0]
        result = self.store.publish_bus_vehicle(
            {
                "vehicle_id": "demo-01",
                "route_id": route["route_id"],
                "current_stop_sequence": 1,
                "progress": 0.5,
                "status": "running",
                "occupancy_level": 3,
                "delay_minutes": 2,
                "speed_kmh": 24,
            }
        )
        self.assertEqual(result["route_no"], route["route_no"])
        self.assertEqual(result["current_stop"]["stop_sequence"], 1)
        self.assertEqual(result["next_stop"]["stop_sequence"], 2)
        self.assertGreaterEqual(result["eta_to_next_stop_minutes"], 2)
        self.assertEqual(result["source"], "mock")

        target = route["stops"][3]
        arrivals = self.store.bus_arrivals(target["stop_id"], route_id=route["route_id"])
        self.assertEqual(arrivals["count"], 1)
        self.assertEqual(arrivals["items"][0]["vehicle_id"], "demo-01")
        self.assertEqual(arrivals["items"][0]["stops_away"], 2)
        self.assertGreater(arrivals["items"][0]["eta_minutes"], 0)

    def test_vehicle_upsert_keeps_one_current_row_and_history(self) -> None:
        route = self.store.list_bus_routes()["items"][0]
        base = {
            "vehicle_id": "demo-upsert",
            "route_id": route["route_id"],
            "current_stop_sequence": 0,
            "progress": 0,
            "status": "at_stop",
            "occupancy_level": 1,
            "delay_minutes": 0,
            "speed_kmh": 0,
        }
        self.store.publish_bus_vehicle(base)
        self.store.publish_bus_vehicle({**base, "progress": 0.4, "status": "running", "speed_kmh": 20})
        latest = self.store.list_bus_vehicles(route_id=route["route_id"])
        self.assertEqual(latest["count"], 1)
        self.assertAlmostEqual(latest["items"][0]["progress"], 0.4)

        with db.connect(self.db_path) as connection:
            current_count = connection.execute("SELECT COUNT(*) FROM bus_vehicles").fetchone()[0]
            history_count = connection.execute("SELECT COUNT(*) FROM bus_vehicle_readings").fetchone()[0]
        self.assertEqual(current_count, 1)
        self.assertEqual(history_count, 2)

    def test_invalid_vehicle_data_is_rejected(self) -> None:
        route = self.store.list_bus_routes()["items"][0]
        with self.assertRaises(ValidationError):
            self.store.publish_bus_vehicle(
                {
                    "vehicle_id": "demo-invalid",
                    "route_id": route["route_id"],
                    "current_stop_sequence": 999,
                    "progress": 0,
                }
            )
        with self.assertRaises(ValidationError):
            self.store.publish_bus_vehicle(
                {
                    "vehicle_id": "demo-invalid",
                    "route_id": route["route_id"],
                    "current_stop_sequence": 0,
                    "progress": 1.5,
                }
            )


if __name__ == "__main__":
    unittest.main()
