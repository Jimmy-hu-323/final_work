"""QwenPaw 客户端配置与异常类型。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class QwenPawChatConfig:
    base_url: str = "http://127.0.0.1:8088"
    agent_id: str = "default"
    channel: str = "console"
    timeout_s: float = 300.0


class QwenPawChatError(RuntimeError):
    pass


class QwenPawHttpError(QwenPawChatError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status)
