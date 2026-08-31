"""Trip deletion billing proxy contract tests; no network or user data."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


PATH = Path(__file__).resolve().parents[1] / "qwen_compitition/src/qwenpaw/app/routers/travel_planner.py"
spec = importlib.util.spec_from_file_location("trip_deletion_endpoint", PATH)
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class TripDeletionProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_atomic_bill_delete_with_encoded_trip_id(self):
        response = {"trip_id": "澳门 weekend", "removed": 3}
        gateway = AsyncMock(return_value=response)
        with patch.object(planner, "_hotel_service_call", gateway):
            result = await planner.delete_trip_expenses("  澳门 weekend  ")

        self.assertEqual(result, response)
        gateway.assert_awaited_once_with(
            "DELETE",
            "/api/v1/trip-expenses?trip_id=%E6%BE%B3%E9%97%A8%20weekend",
        )

    async def test_rejects_blank_trip_without_calling_billing_service(self):
        gateway = AsyncMock()
        with patch.object(planner, "_hotel_service_call", gateway):
            with self.assertRaises(HTTPException) as error:
                await planner.delete_trip_expenses("   ")

        self.assertEqual(error.exception.status_code, 400)
        gateway.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
