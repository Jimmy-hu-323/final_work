"""联调测试客户端。"""

from glasses.client.config import client_config_from_args, parse_args
from glasses.client.ws_client import run_client


def main() -> None:
    import asyncio

    args = parse_args()
    cfg = client_config_from_args(args)
    asyncio.run(run_client(cfg))


__all__ = ["main"]
