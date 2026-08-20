#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLASSES_DIR="$ROOT_DIR/ai_glasses_debug"
ENV_FILE="${LENS_GO_ENV_FILE:-$ROOT_DIR/.env.bridge}"
QWENPAW_HEALTH_URL="${QWENPAW_HEALTH_URL:-http://127.0.0.1:18088/api/version}"
LOG_DIR="${LENS_GO_LOG_DIR:-$ROOT_DIR/logs}"
QWENPAW_LOG="$LOG_DIR/qwenpaw.log"
GLASSES_LOG="$LOG_DIR/glasses-server.log"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ ! -x "$ROOT_DIR/run_qwenpaw.sh" ]]; then
  echo "错误：找不到可执行文件 $ROOT_DIR/run_qwenpaw.sh" >&2
  exit 1
fi

if [[ ! -x "$GLASSES_DIR/.venv/bin/glasses-server" ]]; then
  echo "错误：眼镜服务端尚未安装。请先执行：" >&2
  echo "  cd $GLASSES_DIR && python -m venv .venv && .venv/bin/python -m pip install -e '.[dev]'" >&2
  exit 1
fi

if [[ -z "${GLASSES_BRIDGE_TOKEN:-}" ]]; then
  echo "错误：未设置 GLASSES_BRIDGE_TOKEN。" >&2
  echo "请复制 $ROOT_DIR/.env.bridge.example 为 $ROOT_DIR/.env.bridge 并填写。" >&2
  exit 1
fi

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -z "${TELEGRAM_CHAT_ID:-}" ]] || \
   [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "错误：TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHAT_ID 必须同时设置或同时留空。" >&2
  exit 1
fi
if [[ -n "${TELEGRAM_STATUS_BOT_TOKEN:-}" && -z "${TELEGRAM_STATUS_CHAT_ID:-}" ]] || \
   [[ -z "${TELEGRAM_STATUS_BOT_TOKEN:-}" && -n "${TELEGRAM_STATUS_CHAT_ID:-}" ]]; then
  echo "错误：TELEGRAM_STATUS_BOT_TOKEN 与 TELEGRAM_STATUS_CHAT_ID 必须同时设置或同时留空。" >&2
  exit 1
fi

managed_pids=()
mkdir -p "$LOG_DIR"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if ((${#managed_pids[@]})); then
    echo
    echo "正在关闭 LensGo 服务……"
    kill -TERM "${managed_pids[@]}" 2>/dev/null || true
    wait "${managed_pids[@]}" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

if curl --silent --show-error --fail --max-time 2 "$QWENPAW_HEALTH_URL" >/dev/null 2>&1; then
  echo "QwenPaw 已在运行，直接复用：$QWENPAW_HEALTH_URL"
else
  echo -n "启动 QwenPaw…… "
  : >"$QWENPAW_LOG"
  "$ROOT_DIR/run_qwenpaw.sh" >"$QWENPAW_LOG" 2>&1 &
  qwenpaw_pid=$!
  managed_pids+=("$qwenpaw_pid")

  qwenpaw_ready=false
  for _ in {1..60}; do
    if ! kill -0 "$qwenpaw_pid" 2>/dev/null; then
      echo "失败" >&2
      tail -n 20 "$QWENPAW_LOG" >&2
      exit 1
    fi
    if curl --silent --show-error --fail --max-time 2 "$QWENPAW_HEALTH_URL" >/dev/null 2>&1; then
      qwenpaw_ready=true
      break
    fi
    sleep 1
  done
  if [[ "$qwenpaw_ready" != true ]]; then
    echo "超时" >&2
    tail -n 20 "$QWENPAW_LOG" >&2
    exit 1
  fi
  echo "完成"
fi

echo -n "启动眼镜服务与 Bridge…… "
: >"$GLASSES_LOG"
(
  cd "$GLASSES_DIR"
  exec .venv/bin/glasses-server --config "$GLASSES_DIR/config.toml"
) >"$GLASSES_LOG" 2>&1 &
glasses_pid=$!
managed_pids+=("$glasses_pid")

bridge_ready=false
for _ in {1..15}; do
  if ! kill -0 "$glasses_pid" 2>/dev/null; then
    echo "失败" >&2
    tail -n 30 "$GLASSES_LOG" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 2 \
    -H "Authorization: Bearer $GLASSES_BRIDGE_TOKEN" \
    http://127.0.0.1:18866/api/bridge/events >/dev/null 2>&1; then
    bridge_ready=true
    break
  fi
  sleep 1
done
if [[ "$bridge_ready" != true ]]; then
  echo "超时" >&2
  tail -n 30 "$GLASSES_LOG" >&2
  exit 1
fi
echo "完成"

echo
echo "LensGo 已启动："
echo "  眼镜 WebSocket : ws://127.0.0.1:18765/chat"
echo "  视频上传       : http://127.0.0.1:18866/api/chat/resources/upload"
echo "  Bridge 历史    : http://127.0.0.1:18866/api/bridge/events"
echo "  Bridge 实时 WS : ws://127.0.0.1:18866/api/bridge/ws"
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  telegram_status=""
  for _ in {1..15}; do
    telegram_status="$(rg '\[telegram:ambassador\] ((read-only|interactive) mirror started|mirror disabled)' "$GLASSES_LOG" | tail -n 1 || true)"
    [[ -n "$telegram_status" ]] && break
    if ! kill -0 "$glasses_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [[ "$telegram_status" == *"mirror started"* ]]; then
    echo "  LensGo 大使 Bot : 已连接（chat_id=$TELEGRAM_CHAT_ID）"
  else
    echo "  LensGo 大使 Bot : 连接失败，请查看 $GLASSES_LOG"
    [[ -n "$telegram_status" ]] && echo "    ${telegram_status##* | }"
  fi
else
  echo "  LensGo 大使 Bot : 未配置，当前禁用"
fi
if [[ -n "${TELEGRAM_STATUS_BOT_TOKEN:-}" ]]; then
  status_bot_line="$(rg '\[telegram:status\] ((read-only|interactive) mirror started|mirror disabled)' "$GLASSES_LOG" | tail -n 1 || true)"
  if [[ "$status_bot_line" == *"mirror started"* ]]; then
    echo "  工作状态 Bot    : 已连接（chat_id=$TELEGRAM_STATUS_CHAT_ID）"
  else
    echo "  工作状态 Bot    : 连接失败，请查看 $GLASSES_LOG"
  fi
else
  echo "  工作状态 Bot    : 未配置，当前禁用"
fi
echo "按 Ctrl+C 关闭本脚本启动的服务。"
echo "详细日志：$LOG_DIR"

if ! wait -n "${managed_pids[@]}"; then
  echo "有服务异常退出；请检查 $LOG_DIR。" >&2
fi
echo "有服务意外退出，正在关闭其余服务。" >&2
exit 1
