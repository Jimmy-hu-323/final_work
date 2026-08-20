"""将 QwenPaw SSE 增量合并为 TTS 友好分片。"""

from __future__ import annotations

import re
from typing import Any, Optional

from glasses.common.protocol import sc_chat


class TtsChunker:
    _SENT_END_RE = re.compile(r"[。！？!?…]+[”’）)]*$")

    def __init__(self, *, min_chars: int = 18, max_chars: int = 80) -> None:
        self._buf: str = ""
        self._min_chars = int(min_chars)
        self._max_chars = int(max_chars)

    def push(self, s: str) -> list[str]:
        if not s:
            return []
        self._buf += s
        return self._drain(force=False)

    def flush(self) -> list[str]:
        return self._drain(force=True)

    def _drain(self, *, force: bool) -> list[str]:
        out: list[str] = []
        while self._buf:
            cut = self._find_cut(force=force)
            if cut is None:
                break
            part = self._buf[:cut]
            self._buf = self._buf[cut:]
            part = part.strip(" \t\f\v")
            if part.strip("\n"):
                out.append(part)
            if not force:
                break
        return out

    def _find_cut(self, *, force: bool) -> Optional[int]:
        s = self._buf
        if force:
            return len(s)

        if len(s) >= self._max_chars:
            window = s[: self._max_chars]
            idx = window.rfind("\n")
            if idx != -1:
                return idx + 1
            m = list(self._SENT_END_RE.finditer(window))
            if m:
                return m[-1].end()
            return self._max_chars

        if "\n\n" in s:
            return s.find("\n\n") + 2

        if len(s) < self._min_chars:
            return None

        nl = s.find("\n")
        if nl != -1:
            return nl + 1
        m = self._SENT_END_RE.search(s)
        if m:
            return m.end()
        return None


async def forward_sse_as_tts_chunks(
    *,
    ask_type: int,
    sse_iter: Any,
    send: Any,
) -> None:
    chunker = TtsChunker()
    async for piece, is_end in sse_iter:
        for part in chunker.push(piece):
            await send(sc_chat(ask_type, part, is_end=False))
        if is_end:
            tail = chunker.flush()
            if tail:
                for part in tail[:-1]:
                    await send(sc_chat(ask_type, part, is_end=False))
                await send(sc_chat(ask_type, tail[-1], is_end=True))
            else:
                await send(sc_chat(ask_type, "", is_end=True))
            return
