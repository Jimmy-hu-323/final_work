import json

from glasses.server.lensgo_memory import LensGoMemory, context_message


def test_traveler_identity_is_stable_and_user_scoped(tmp_path):
    memory = LensGoMemory(tmp_path / "lensgo.db")
    first = memory.traveler_id("user-a")
    assert first == memory.traveler_id("user-a")
    assert first != memory.traveler_id("user-b")
    assert "user-a" not in first


def test_context_shares_recent_glasses_and_telegram_observations(tmp_path):
    memory = LensGoMemory(tmp_path / "lensgo.db")
    context_message(
        memory, request_id="r1", user_id="u1", device_id="d1",
        source="glasses", modality="text", content="我到大三巴了",
    )
    second = context_message(
        memory, request_id="r2", user_id="u1", device_id="d1",
        source="telegram", modality="text", content="帮我记住",
    )
    payload = json.loads(second.removeprefix("LensGoContext: "))
    assert payload["traveler_id"].startswith("traveler_")
    assert [item["content"] for item in payload["recent_shared_memory"]] == [
        "我到大三巴了", "帮我记住",
    ]
