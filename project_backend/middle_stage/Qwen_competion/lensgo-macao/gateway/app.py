from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", BASE_DIR / "data" / "uploads"))
QWENPAW_URL = os.getenv("QWENPAW_URL", "http://127.0.0.1:18088").rstrip("/")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

app = FastAPI(
    title="LensGo Macao Smart Glasses Gateway",
    version="0.1.0",
    description="HTTP image upload and WebSocket frame ingestion for smart glasses.",
)


def _safe_device_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", value)[:64]
    return cleaned or "unknown"


async def _save_image(data: bytes, content_type: str, device_id: str) -> tuple[str, Path]:
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(415, "Only JPEG, PNG and WebP images are accepted")
    if not data:
        raise HTTPException(400, "Empty image")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Image exceeds {MAX_UPLOAD_BYTES} bytes")
    upload_id = uuid.uuid4().hex
    date_dir = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    target_dir = UPLOAD_DIR / date_dir / _safe_device_id(device_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{upload_id}{ALLOWED_TYPES[content_type]}"
    target.write_bytes(data)
    return upload_id, target


@app.get("/")
async def root() -> dict:
    return {
        "service": "LensGo Macao Smart Glasses Gateway",
        "health": "/health",
        "upload": "/api/v1/glasses/upload",
        "websocket": "/ws/v1/glasses/{device_id}",
        "docs": "/docs",
    }


@app.get("/health")
async def health() -> JSONResponse:
    qwenpaw_ok = False
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            response = await client.get(f"{QWENPAW_URL}/")
            qwenpaw_ok = response.status_code < 500
    except httpx.HTTPError:
        pass
    return JSONResponse(
        {"status": "ok", "qwenpaw": "reachable" if qwenpaw_ok else "unreachable"},
        status_code=200,
    )


@app.post("/api/v1/glasses/upload", status_code=201)
async def upload_image(
    image: UploadFile = File(...),
    device_id: str = Form(...),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    language: str = Form("zh-Hant"),
) -> dict:
    data = await image.read(MAX_UPLOAD_BYTES + 1)
    upload_id, target = await _save_image(data, image.content_type or "", device_id)
    return {
        "type": "upload.accepted",
        "upload_id": upload_id,
        "device_id": device_id,
        "location": {"latitude": latitude, "longitude": longitude},
        "language": language,
        "stored_as": str(target.relative_to(BASE_DIR)),
    }


@app.websocket("/ws/v1/glasses/{device_id}")
async def glasses_socket(websocket: WebSocket, device_id: str) -> None:
    await websocket.accept()
    await websocket.send_json({"type": "connected", "device_id": device_id})
    metadata: dict = {"content_type": "image/jpeg", "language": "zh-Hant"}
    try:
        while True:
            message = await websocket.receive()
            if message.get("text") is not None:
                try:
                    incoming = json.loads(message["text"])
                except json.JSONDecodeError:
                    await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                    continue
                if incoming.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                elif incoming.get("type") == "frame.metadata":
                    metadata = {**metadata, **incoming}
                    await websocket.send_json({"type": "frame.ready"})
                else:
                    await websocket.send_json({"type": "error", "detail": "Unknown message type"})
            elif message.get("bytes") is not None:
                try:
                    upload_id, target = await _save_image(
                        message["bytes"], metadata.get("content_type", "image/jpeg"), device_id
                    )
                    await websocket.send_json({
                        "type": "frame.accepted",
                        "upload_id": upload_id,
                        "stored_as": str(target.relative_to(BASE_DIR)),
                        "location": metadata.get("location"),
                        "language": metadata.get("language", "zh-Hant"),
                    })
                except HTTPException as exc:
                    await websocket.send_json({"type": "error", "detail": exc.detail})
    except WebSocketDisconnect:
        return
