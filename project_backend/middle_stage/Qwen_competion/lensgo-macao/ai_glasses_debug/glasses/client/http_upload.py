"""HTTP mp4 上传到联调服务端。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aiohttp import ClientSession, FormData

from glasses.common.logging_util import json_dumps


async def upload_mp4(
    http_upload_url: str,
    token: str,
    path: str,
    *,
    device_id: str,
) -> dict[str, Any]:
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    if p.suffix.lower() != ".mp4":
        raise ValueError(f"仅支持 .mp4：{p.name}")

    form = FormData()
    form.add_field("file", p.open("rb"), filename=p.name, content_type="video/mp4")
    headers = {
        "Authorization": f"Bearer {token}",
        "device_id": device_id,
    }
    async with ClientSession() as session:
        async with session.post(http_upload_url, data=form, headers=headers) as resp:
            text = await resp.text()
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                raise RuntimeError(f"HTTP 返回非 JSON（status={resp.status}）：{text[:500]}")
            if resp.status >= 400:
                raise RuntimeError(f"HTTP 上传失败（status={resp.status}）：{json_dumps(data)}")
            return data
