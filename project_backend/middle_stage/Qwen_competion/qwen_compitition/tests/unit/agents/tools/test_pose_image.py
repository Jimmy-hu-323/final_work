from __future__ import annotations

import base64
from pathlib import Path

import pytest

from qwenpaw.agents.tools import pose_image


_PNG = b"\x89PNG\r\n\x1a\n" + b"pose-image"


@pytest.mark.asyncio
async def test_generate_pose_requires_api_key(monkeypatch):
    monkeypatch.setenv("POSE_IMAGE_PROVIDER", "dashscope")
    monkeypatch.setenv("POSE_IMAGE_BASE_URL", "https://example.test/api/v1")
    monkeypatch.delenv("POSE_IMAGE_API_KEY", raising=False)
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)

    result = await pose_image.generate_pose_reference("a safe standing pose")

    assert "No image API key" in result.content[0].text


@pytest.mark.asyncio
async def test_generate_pose_saves_base64_result(monkeypatch, tmp_path):
    monkeypatch.setenv("POSE_IMAGE_PROVIDER", "openai-compatible")
    monkeypatch.setenv("POSE_IMAGE_API_KEY", "secret")
    monkeypatch.setenv("POSE_IMAGE_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("POSE_IMAGE_MODEL", "image-test")
    monkeypatch.setattr(pose_image, "get_current_workspace_dir", lambda: tmp_path)

    async def fake_post(*_args, **_kwargs):
        return {"data": [{"b64_json": base64.b64encode(_PNG).decode()}]}

    monkeypatch.setattr(pose_image, "_post_json", fake_post)
    result = await pose_image.generate_pose_reference(
        "full-body relaxed travel pose",
        pose_name="轻松侧身",
    )

    text = result.content[-1].text
    assert "file_path:" in text
    generated = list((tmp_path / "generated" / "pose_references").glob("*.png"))
    assert len(generated) == 1
    assert generated[0].read_bytes() == _PNG


@pytest.mark.asyncio
async def test_openrouter_uses_dedicated_images_endpoint(monkeypatch, tmp_path):
    monkeypatch.setenv("POSE_IMAGE_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret")
    monkeypatch.setenv("POSE_IMAGE_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("POSE_IMAGE_MODEL", "openai/gpt-image-1")
    monkeypatch.setattr(pose_image, "get_current_workspace_dir", lambda: tmp_path)
    captured = {}

    async def fake_post(url, **kwargs):
        captured["url"] = url
        captured["payload"] = kwargs["payload"]
        return {"data": [{"b64_json": base64.b64encode(_PNG).decode()}]}

    monkeypatch.setattr(pose_image, "_post_json", fake_post)

    result = await pose_image.generate_pose_reference(
        "full-body Macau travel pose",
        size="1024x1024",
    )

    assert captured["url"] == "https://openrouter.ai/api/v1/images"
    assert captured["payload"] == {
        "model": "openai/gpt-image-1",
        "prompt": "full-body Macau travel pose",
        "n": 1,
    }
    assert "openrouter/openai/gpt-image-1" in result.content[-1].text


def test_rejects_non_image_bytes():
    with pytest.raises(pose_image.PoseImageError):
        pose_image._validate_image(b"not-an-image")


def test_extracts_dashscope_image_url():
    body = {
        "output": {
            "choices": [
                {
                    "message": {
                        "content": [
                            {"type": "image", "image": "https://example.test/pose.png"},
                        ],
                    },
                },
            ],
        },
    }
    assert pose_image._extract_image_result(body) == (
        "url",
        "https://example.test/pose.png",
    )
