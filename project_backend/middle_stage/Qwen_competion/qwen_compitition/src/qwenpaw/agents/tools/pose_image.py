# -*- coding: utf-8 -*-
"""Generate a local pose reference image with a configured image model."""

from __future__ import annotations

import base64
import binascii
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from agentscope.message import DataBlock, TextBlock, ToolResultState, URLSource
from agentscope.tool import ToolChunk

from ...config.context import get_current_workspace_dir
from ...constant import WORKING_DIR
from ...runtime.tool_registry import tool_descriptor
from .file_io import _path_to_file_url


_MAX_PROMPT_CHARS = 2000
_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_SIZE_RE = re.compile(r"^(?P<w>\d{3,4})[x*](?P<h>\d{3,4})$")
_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
)


class PoseImageError(RuntimeError):
    """Expected, user-facing image generation failure."""


def _error(message: str) -> ToolChunk:
    return ToolChunk(
        is_last=True,
        state=ToolResultState.SUCCESS,
        content=[TextBlock(text=f"Pose reference generation failed: {message}")],
    )


def _provider() -> str:
    value = os.getenv("POSE_IMAGE_PROVIDER", "dashscope").strip().lower()
    aliases = {
        "dashscope": "dashscope",
        "wan": "dashscope",
        "wanx": "dashscope",
        "openai": "openai",
        "openai-compatible": "openai",
        "openai_compatible": "openai",
        "openrouter": "openrouter",
    }
    if value not in aliases:
        raise PoseImageError(
            "POSE_IMAGE_PROVIDER must be dashscope, openai-compatible, or openrouter.",
        )
    return aliases[value]


def _api_key(provider: str) -> str:
    candidates = ["POSE_IMAGE_API_KEY"]
    provider_key = {
        "dashscope": "DASHSCOPE_API_KEY",
        "openai": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
    }[provider]
    candidates.append(provider_key)
    for name in candidates:
        value = os.getenv(name, "").strip()
        if value:
            return value
    raise PoseImageError(
        "No image API key is configured. Set POSE_IMAGE_API_KEY.",
    )


def _base_url() -> str:
    value = os.getenv("POSE_IMAGE_BASE_URL", "").strip().rstrip("/")
    if not value:
        raise PoseImageError(
            "POSE_IMAGE_BASE_URL is required because image endpoints are "
            "region-specific.",
        )
    parsed = urlparse(value)
    is_loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and is_loopback
    ):
        raise PoseImageError(
            "POSE_IMAGE_BASE_URL must use HTTPS (HTTP is allowed for "
            "loopback only).",
        )
    return value


def _size(raw: str, provider: str) -> str:
    value = (
        raw.strip()
        or os.getenv("POSE_IMAGE_SIZE", "").strip()
        or ("1280*1280" if provider == "dashscope" else "1024x1024")
    )
    match = _SIZE_RE.fullmatch(value)
    if match is None:
        raise PoseImageError("Image size must look like 1280*1280 or 1024x1024.")
    separator = "*" if provider == "dashscope" else "x"
    return f"{match.group('w')}{separator}{match.group('h')}"


def _timeout() -> float:
    raw = os.getenv("POSE_IMAGE_TIMEOUT_SECONDS", "180").strip()
    try:
        value = float(raw)
    except ValueError as exc:
        raise PoseImageError("POSE_IMAGE_TIMEOUT_SECONDS must be numeric.") from exc
    return max(10.0, min(value, 600.0))


async def _post_json(
    url: str,
    *,
    api_key: str,
    payload: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.post(url, headers=headers, json=payload)
    if response.status_code >= 400:
        detail = response.text[:500].replace(api_key, "[redacted]")
        raise PoseImageError(
            f"Image API returned HTTP {response.status_code}: {detail}",
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise PoseImageError("Image API returned invalid JSON.") from exc
    if not isinstance(body, dict):
        raise PoseImageError("Image API returned an unexpected response.")
    return body


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _extract_image_result(body: dict[str, Any]) -> tuple[str, str]:
    for item in _walk(body):
        encoded = item.get("b64_json")
        if isinstance(encoded, str) and encoded.strip():
            return ("base64", encoded.strip())
        if item.get("type") == "image":
            image = item.get("image") or item.get("url")
            if isinstance(image, str) and image.strip():
                return ("url", image.strip())
        url = item.get("url")
        if isinstance(url, str) and url.startswith(("https://", "http://")):
            return ("url", url)
    message = body.get("message") or body.get("code") or "no image in response"
    raise PoseImageError(f"Image API completed without an image: {message}")


async def _download_image(url: str, timeout: float) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise PoseImageError("Image API returned an invalid image URL.")
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url)
    if response.status_code >= 400:
        raise PoseImageError(
            f"Generated image download returned HTTP {response.status_code}.",
        )
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0]
    if content_type and not content_type.startswith("image/"):
        raise PoseImageError("Generated result is not an image.")
    return response.content


def _decode_image(encoded: str) -> bytes:
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PoseImageError("Image API returned invalid Base64 data.") from exc


def _validate_image(data: bytes) -> tuple[str, str]:
    if not data:
        raise PoseImageError("Generated image is empty.")
    if len(data) > _MAX_IMAGE_BYTES:
        raise PoseImageError("Generated image exceeds the 20 MB safety limit.")
    for magic, extension, media_type in _IMAGE_MAGIC:
        if data.startswith(magic):
            return extension, media_type
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp"
    raise PoseImageError("Generated result is not PNG, JPEG, or WebP.")


def _output_path(extension: str) -> Path:
    workspace = get_current_workspace_dir() or WORKING_DIR
    directory = Path(workspace) / "generated" / "pose_references"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"pose-reference-{uuid4().hex}{extension}"


async def _generate(
    *,
    provider: str,
    prompt: str,
    negative_prompt: str,
    size: str,
) -> tuple[bytes, str]:
    api_key = _api_key(provider)
    base_url = _base_url()
    timeout = _timeout()
    if provider == "dashscope":
        model = os.getenv("POSE_IMAGE_MODEL", "wan2.6-t2i").strip()
        endpoint = (
            base_url
            + "/services/aigc/multimodal-generation/generation"
        )
        payload = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [{"text": prompt}],
                    },
                ],
            },
            "parameters": {
                "negative_prompt": negative_prompt,
                "prompt_extend": True,
                "watermark": False,
                "n": 1,
                "size": size,
            },
        }
    elif provider == "openai":
        model = os.getenv("POSE_IMAGE_MODEL", "gpt-image-1").strip()
        endpoint = base_url + "/images/generations"
        payload = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": size,
        }
    else:
        model = os.getenv(
            "POSE_IMAGE_MODEL",
            "openai/gpt-image-1",
        ).strip()
        endpoint = base_url + "/images"
        payload = {
            "model": model,
            "prompt": prompt,
            "n": 1,
        }

    body = await _post_json(
        endpoint,
        api_key=api_key,
        payload=payload,
        timeout=timeout,
    )
    kind, value = _extract_image_result(body)
    data = (
        _decode_image(value)
        if kind == "base64"
        else await _download_image(value, timeout)
    )
    return data, model


@tool_descriptor(
    requires_skills=("lensgo_pose_coach",),
    requires_sandbox=("file_write",),
    async_execution=True,
)
async def generate_pose_reference(
    prompt: str,
    pose_name: str = "",
    negative_prompt: str = "",
    size: str = "",
) -> ToolChunk:
    """Generate one pose reference image and save it in the Agent workspace.

    Args:
        prompt: Detailed visual prompt describing body pose, framing, scene,
            lighting, clothing neutrality, and camera angle.
        pose_name: Short human-readable pose name used in the result message.
        negative_prompt: Optional elements the image should avoid.
        size: Optional image dimensions, for example 1280*1280.

    Returns:
        A tool result containing the generated image and its local file path.
        Call ``send_file_to_user`` with that path so every user channel sees
        the image.
    """
    normalized_prompt = str(prompt or "").strip()
    if not normalized_prompt:
        return _error("prompt is required.")
    if len(normalized_prompt) > _MAX_PROMPT_CHARS:
        return _error(f"prompt exceeds {_MAX_PROMPT_CHARS} characters.")
    try:
        provider = _provider()
        image_size = _size(size, provider)
        data, model = await _generate(
            provider=provider,
            prompt=normalized_prompt,
            negative_prompt=str(negative_prompt or "").strip(),
            size=image_size,
        )
        extension, media_type = _validate_image(data)
        target = _output_path(extension)
        target.write_bytes(data)
        file_url = _path_to_file_url(str(target))
        label = str(pose_name or "").strip() or "pose reference"
        return ToolChunk(
            is_last=True,
            state=ToolResultState.SUCCESS,
            content=[
                DataBlock(
                    source=URLSource(url=file_url, media_type=media_type),
                    name=target.name,
                ),
                TextBlock(
                    text=(
                        f"Generated {label} with {provider}/{model}.\n"
                        f"file_path: {target}\n"
                        "Call send_file_to_user with this exact file_path."
                    ),
                ),
            ],
        )
    except PoseImageError as exc:
        return _error(str(exc))
    except (OSError, httpx.HTTPError) as exc:
        return _error(f"{type(exc).__name__}: {exc}")
