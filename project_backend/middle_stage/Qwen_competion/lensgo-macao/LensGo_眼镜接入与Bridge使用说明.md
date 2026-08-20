# LensGo Macao 眼镜接入与 Bridge 使用说明

本文档说明 LensGo 项目中 QwenPaw、官方眼镜联调服务、数据 Bridge、Telegram Bridge 和 FRP 公网映射的用途、启动方式与接口。

> 安全提示：不要把 QwenPaw API Key、Telegram Bot Token、Bridge Token 提交到 Git、发到聊天或写入截图。

## 1. 系统架构

```text
AI 眼镜（麦克风、摄像头、扬声器）
        ↕ 蓝牙/官方协议
开发版眼镜 APP
        ↕ WebSocket + HTTP
glasses-server（官方联调服务端）
        ├── QwenPaw：AI 对话、图片与视频分析
        ├── 数据 Bridge：暴露上下行镜像事件
        └── Telegram Bridge：将镜像发送到 Telegram
```

AI 眼镜本身不直接连接服务器。开发版 APP 负责：

- 接收眼镜麦克风输入并进行语音识别；
- 将识别文字、图片或视频发送给 `glasses-server`；
- 接收服务器返回的 `SCChat` 文字；
- 将文字进行 TTS，再通过眼镜播放。

当前官方协议不向服务器提供原始麦克风音频。Bridge 能看到的是 APP 识别后的文字、拍摄图片、上传视频和服务器下行消息。

## 2. 目录与组件

项目根目录：

```text
/home/lkzhang/qwen_comp
```

主要文件：

| 文件或目录 | 用途 |
|---|---|
| `run_all.sh` | 一键启动 QwenPaw、眼镜服务和两个 Bridge |
| `run_qwenpaw.sh` | 单独启动 QwenPaw |
| `.env.bridge` | Bridge 与 Telegram 私密配置，不提交 Git |
| `logs/` | 一键启动产生的运行日志 |
| `ai_glasses_debug/` | 主办方提供的正式联调服务端与测试客户端 |
| `ai_glasses_debug/config.toml` | 眼镜服务、QwenPaw 和 Bridge 配置 |

服务说明：

| 服务 | 用途 | 本地端口 |
|---|---|---:|
| QwenPaw | Agent 和模型调用 | `18088` |
| 眼镜 WebSocket | APP 双向通信 | `18765` |
| 眼镜 HTTP/Bridge | 视频上传、媒体和 Bridge API | `18866` |
| 旧自研 Gateway | 自研 HTTP/WS 接口，非官方 APP 主路径 | `8000` |

## 3. 私密配置

首次使用：

```bash
cd /home/lkzhang/qwen_comp
cp .env.bridge.example .env.bridge
nano .env.bridge
```

格式：

```bash
GLASSES_BRIDGE_TOKEN="替换为随机Token"
TELEGRAM_BOT_TOKEN="替换为BotFather提供的Token"
TELEGRAM_CHAT_ID="替换为用户或群组Chat ID"
```

生成 Bridge Token：

```bash
openssl rand -hex 32
```

如果暂时不使用 Telegram：

```bash
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
```

### 获取 Telegram Chat ID

1. 在 Telegram 打开 Bot，发送 `/start` 和一条普通消息。
2. 加载环境变量并请求更新：

```bash
cd /home/lkzhang/qwen_comp
set -a
source .env.bridge
set +a
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```

3. 查找响应中的：

```json
{"chat":{"id":123456789}}
```

群组 Chat ID 通常是负数。若 Bot Token 曾公开，应立即在 BotFather 撤销并重新生成。

## 4. 一键启动

```bash
cd /home/lkzhang/qwen_comp
./run_all.sh
```

脚本会：

1. 读取 `.env.bridge`；
2. 检查必需配置；
3. 启动或复用 QwenPaw；
4. 等待 QwenPaw 健康检查通过；
5. 启动 `glasses-server`；
6. 同时启用数据 Bridge 与 Telegram Bridge；
7. 将详细日志写入 `logs/`。

正常输出类似：

```text
启动 QwenPaw…… 完成
启动眼镜服务与 Bridge…… 完成

LensGo 已启动：
  眼镜 WebSocket : ws://127.0.0.1:18765/chat
  视频上传       : http://127.0.0.1:18866/api/chat/resources/upload
  Bridge 历史    : http://127.0.0.1:18866/api/bridge/events
  Bridge 实时 WS : ws://127.0.0.1:18866/api/bridge/ws
  Telegram 镜像  : 已连接
```

按 `Ctrl+C` 关闭由脚本启动的服务。如果 QwenPaw 原本已运行，脚本会复用它且不会在退出时误杀。

日志位置：

```text
/home/lkzhang/qwen_comp/logs/qwenpaw.log
/home/lkzhang/qwen_comp/logs/glasses-server.log
```

查看眼镜服务日志：

```bash
tail -f /home/lkzhang/qwen_comp/logs/glasses-server.log
```

检查 Telegram：

```bash
rg '\[telegram\]' /home/lkzhang/qwen_comp/logs/glasses-server.log
```

## 5. 开发版 APP 接口

### 5.1 WebSocket

公网地址：

```text
ws://47.82.123.50:18765/chat
```

连接 Header：

| Header | 说明 |
|---|---|
| `access_token` | JWT，payload 必须包含 `userId` |
| `device_id` | APP/眼镜逻辑设备编号 |

WebSocket 是双向连接：

```text
APP → 服务端：文字、图片、控制消息
服务端 → APP：回复文字、拍照意图、结束指令和错误
```

APP 上行文字：

```json
{
  "type": "CSChatWordImage",
  "data": {
    "askType": 1,
    "content": "请介绍澳门大三巴"
  }
}
```

APP 上行图片：

```json
{
  "type": "CSChatWordImage",
  "data": {
    "askType": 2,
    "image": "data:image/jpeg;base64,..."
  }
}
```

服务端下行文字：

```json
{
  "type": "SCChat",
  "data": {
    "askType": 2,
    "type": "response",
    "isEnd": true,
    "message": "图片中是澳门大三巴牌坊。"
  }
}
```

APP 收到 `SCChat.data.message` 后负责 TTS 和眼镜播放。

服务端下行拍照意图：

```json
{
  "type": "SCIntentMessage",
  "data": {
    "state": true,
    "message": "请拍照上传图片",
    "type": "IdentifyObjects"
  }
}
```

### 5.2 askType

| askType | 用途 | 传输方式 |
|---:|---|---|
| `1` | 文字问答 | WebSocket |
| `2` | 主动图片识别 | WebSocket Base64/Data URL |
| `3` | 意图触发后的拍照识别 | WebSocket Base64/Data URL |
| `4` | 视频分析 | WebSocket 通知 + HTTP 上传 |

### 5.3 视频 HTTP 上传

公网地址：

```text
POST http://47.82.123.50:18866/api/chat/resources/upload
```

要求：

- `multipart/form-data`；
- 文件字段名为 `file`；
- Header `Authorization: Bearer <JWT>`；
- Header `device_id` 必须与在线 WebSocket 一致；
- 上传结果通过原 WebSocket 异步返回。

## 6. QwenPaw

本地控制台：

```text
http://127.0.0.1:18088/
```

公网控制台：

```text
http://47.82.123.50:18088/
```

Agent API：

```text
POST http://127.0.0.1:18088/api/console/chat
```

眼镜服务配置位于 `ai_glasses_debug/config.toml`：

```toml
[qwenpaw]
base_url = "http://127.0.0.1:18088"
agent_id = "default"
timeout_s = 300
```

同机 localhost 访问时，当前配置无需额外 QwenPaw Web Authorization。

## 7. 数据 Bridge

数据 Bridge 是只读事件镜像，不改变 APP 与 QwenPaw 的原始行为。

镜像事件包括：

- 设备上线和离线；
- APP 上行文字；
- APP/眼镜拍摄图片；
- APP 上传视频；
- 服务器下行 `SCChat`；
- `SCIntentMessage`、`SCFinishAIMessage`、`SCError`。

Bridge 不暴露：

- APP JWT；
- QwenPaw API Key；
- Telegram Bot Token；
- 服务器绝对媒体路径；
- 原始麦克风音频。

### 7.1 最近事件接口

公网地址：

```text
GET http://47.82.123.50:18866/api/bridge/events
```

鉴权：

```text
Authorization: Bearer <GLASSES_BRIDGE_TOKEN>
```

测试：

```bash
cd /home/lkzhang/qwen_comp
set -a
source .env.bridge
set +a

curl http://127.0.0.1:18866/api/bridge/events \
  -H "Authorization: Bearer $GLASSES_BRIDGE_TOKEN"
```

可使用 `?limit=50` 控制返回数量，最大 500。

### 7.2 实时事件 WebSocket

公网地址：

```text
ws://47.82.123.50:18866/api/bridge/ws
```

连接时同样携带：

```text
Authorization: Bearer <GLASSES_BRIDGE_TOKEN>
```

事件示例：

```json
{
  "event_id": "...",
  "timestamp": 1784390000.0,
  "direction": "upstream",
  "event_type": "image",
  "user_id": "99089019768",
  "device_id": "2C:BE:EB:54:45:41",
  "data": {
    "ask_type": 2,
    "bytes": 52831,
    "bridge_media_url": "/api/bridge/media/99089019768/img_xxx.jpg"
  }
}
```

方向说明：

| direction | 含义 |
|---|---|
| `upstream` | APP/眼镜发给服务器 |
| `downstream` | 服务器发给 APP/眼镜 |
| `system` | 上线、离线等系统事件 |

### 7.3 鉴权媒体下载

图片和视频事件带有 `bridge_media_url`。下载时仍需 Bridge Token：

```bash
curl "http://47.82.123.50:18866/api/bridge/media/<user_id>/<filename>" \
  -H "Authorization: Bearer $GLASSES_BRIDGE_TOKEN" \
  -o output-file
```

## 8. Telegram Bridge

Telegram Bridge 同时提供镜像和双向 Agent 交互。它订阅数据 Bridge，并且只接受 `.env.bridge` 中 `TELEGRAM_CHAT_ID` 指定会话的入站文字。

Telegram 可显示：

- 眼镜语音经 APP 识别后的文字；
- 图片和视频；
- QwenPaw 返回 APP 的文字；
- 设备上下线；
- 意图、结束和错误消息。

Telegram 向 Bot 发送普通文字时：

```text
Telegram → 当前选中的在线设备会话 → QwenPaw Agent
                                      ↓
Telegram ← 完整回答 ← SCChat ← APP（显示并 TTS 播放到眼镜）
```

单个设备在线时自动选择。多个设备在线时使用：

```text
/devices            查看在线设备
/use <device_id>    选择设备
/status             查看当前设备
/help               查看帮助
```

Telegram 当前仍不能：

- 获取原始麦克风录音；
- 将原始 Telegram 音频直接写入眼镜；
- 直接控制眼镜硬件。

为避免刷屏：

- Qwen 的多个 TTS 分片会聚合；
- 等 `isEnd=true` 后只发送一条完整回答；
- 三秒内完全相同的事件只发送一次；
- 图片和视频各发送一次。

启动成功日志：

```text
[telegram] interactive mirror started chat_id=...
```

## 9. FRP 公网映射

本机运行的是 `frpc` 客户端，配置：

```text
/opt/frp/frpc.ini
```

需要的主要映射：

```ini
[lensgo-official-ws]
type = tcp
local_ip = 127.0.0.1
local_port = 18765
remote_port = 18765

[lensgo-official-http]
type = tcp
local_ip = 127.0.0.1
local_port = 18866
remote_port = 18866

[lensgo-qwenpaw]
type = tcp
local_ip = 127.0.0.1
local_port = 18088
remote_port = 18088
```

验证配置：

```bash
/opt/frp/frpc verify -c /opt/frp/frpc.ini
```

应用配置：

```bash
sudo systemctl restart frpc
sudo systemctl status frpc --no-pager
```

公网服务器防火墙或安全组需允许 TCP：

```text
18765
18866
18088
```

## 10. 测试工具

### 10.1 文字问答

```bash
cd /home/lkzhang/qwen_comp/ai_glasses_debug
source .venv/bin/activate
glasses-client --ask-type 1 --content "请介绍澳门大三巴牌坊"
```

### 10.2 图片识别

```bash
glasses-client --ask-type 2 --image-file ./demo/demo.png
```

### 10.3 意图拍照流程

```bash
glasses-client \
  --ask-type 1 \
  --content "帮我看看面前是什么" \
  --intent-image-file ./demo/demo.png
```

### 10.4 交互模式

```bash
glasses-client --interactive
```

交互命令：

```text
普通文字              发送 askType=1
/img ./photo.jpg      发送 askType=2
/video ./video.mp4    上传视频
/quit                 退出
```

## 11. 常见问题

### 11.1 WebSocket 返回 HTTP/1.0 200

客户端连接了错误端口。检查 `config.toml`：

```toml
[client]
ws_url = "ws://127.0.0.1:18765/chat"
http_upload_url = "http://127.0.0.1:18866/api/chat/resources/upload"
```

### 11.2 Telegram 显示 chat not found

- 先向 Bot 发送 `/start`；
- 再发一条普通消息；
- 调用 `getUpdates` 获取真实 `chat.id`；
- 群组 ID 通常为负数；
- 更新 `.env.bridge` 后重启 `run_all.sh`。

### 11.3 Telegram 无镜像

检查：

```bash
rg '\[telegram\]' /home/lkzhang/qwen_comp/logs/glasses-server.log
```

成功状态：

```text
[telegram] interactive mirror started
```

还需确认 APP 已连接 `ws://47.82.123.50:18765/chat` 并确实向服务器发送消息。

### 11.4 Telegram 消息重复

当前实现已经聚合 `SCChat` TTS 分片并进行短时间去重。修改代码后必须重启 `run_all.sh` 才会生效。

### 11.5 Bridge 返回 401

确认已加载环境变量，并携带正确 Header：

```bash
set -a
source /home/lkzhang/qwen_comp/.env.bridge
set +a

curl http://127.0.0.1:18866/api/bridge/events \
  -H "Authorization: Bearer $GLASSES_BRIDGE_TOKEN"
```

### 11.6 QwenPaw unreachable

```bash
curl http://127.0.0.1:18088/api/version
tail -n 100 /home/lkzhang/qwen_comp/logs/qwenpaw.log
```

### 11.7 查看端口

```bash
ss -ltnp | rg ':18088|:18765|:18866'
```

## 12. 最终公网地址汇总

| 用途 | 地址 |
|---|---|
| 眼镜 APP WebSocket | `ws://47.82.123.50:18765/chat` |
| 视频 HTTP 上传 | `http://47.82.123.50:18866/api/chat/resources/upload` |
| Bridge 最近事件 | `http://47.82.123.50:18866/api/bridge/events` |
| Bridge 实时 WebSocket | `ws://47.82.123.50:18866/api/bridge/ws` |
| Bridge 媒体下载 | `http://47.82.123.50:18866/api/bridge/media/<user_id>/<filename>` |
| QwenPaw 控制台 | `http://47.82.123.50:18088/` |
