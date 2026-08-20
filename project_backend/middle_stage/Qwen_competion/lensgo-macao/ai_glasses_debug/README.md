# AI 眼镜 QwenPaw 联调（Python）

本仓库由大赛承办单位 **博维智慧科技有限公司** 提供，用于 **AI 眼镜** 赛事场景下，**开发版 APP** 与 **QwenPaw** 的联调接入。

**联调服务端**（`glasses-server`）接收 **开发版 APP** 发来的 WebSocket/HTTP 协议请求，转发至参赛者自行部署的 **QwenPaw**，并将流式结果转换为 `SCChat` 等消息回推给 APP。**AI 眼镜**为硬件外设，在 APP 播放语音或采集图像/音视频时使用，**不直接**连接 `glasses-server`。

## 角色说明

| 角色 | 说明 | 谁提供 / 谁部署 |
|------|------|-----------------|
| **联调服务端** `glasses-server` | 协议转发层，对接 QwenPaw | 本仓库源码，**参赛者**配置并启动 |
| **开发版 APP** | **协议客户端**，通过 WS/HTTP 连接联调服务端 | **博维智慧**提供 |
| **AI 眼镜** | 硬件外设，供 APP 播放、采集时使用 | **博维智慧**提供（硬件） |
| **QwenPaw** | 大模型与 Agent 能力 | **参赛者**自行安装、启动 |
| **协议模拟工具** `glasses-client` | 命令行模拟 APP 协议行为，仅自测用 | 本仓库附带，**非**比赛正式客户端 |

## 参赛者交付物说明

以下由 **博维智慧科技有限公司** 向参赛者提供：

| 交付物 | 说明 |
|--------|------|
| **本仓库源码** | 联调服务端（`glasses-server`）+ 可选协议模拟工具（`glasses-client`） |
| **开发版 APP** | 协议客户端，已实现与服务端的对接；连接地址、Token 等见**接入与联调指南** |
| **AI 眼镜** | 硬件；按**接入与联调指南**与 APP 配对，用于播放与采集 |
| **接入与联调指南** | APP 连服务端、眼镜配对、业务流程等（博维智慧提供） |

## 目录

- [架构说明](#架构说明)
- [参赛者快速上手（推荐）](#参赛者快速上手推荐)
- [功能概览](#功能概览)
- [环境要求](#环境要求)
- [安装依赖](#安装依赖)
- [启动 QwenPaw（参赛者自备）](#启动-qwenpaw参赛者自备)
- [配置并启动联调服务端](#配置并启动联调服务端)
- [协议模拟工具 glasses-client（可选）](#协议模拟工具-glasses-client可选)
- [项目结构](#项目结构)
- [配置文件（TOML）](#配置文件toml)
- [参赛者对接说明](#参赛者对接说明)
- [鉴权与连接](#鉴权与连接)
- [服务端参数](#服务端参数)
- [控制台日志](#控制台日志)
- [常见问题](#常见问题)

## 架构说明

```text
  AI 眼镜（硬件外设）
       ▲
       │  播放语音 / 采集图像·音视频（按需）
       │
开发版 APP（协议客户端，博维智慧提供）
       │  WS: CSChatWordImage  +  HTTP: 上传 mp4
       ▼
glasses-server（本仓库，参赛者配置并启动）
       │  QwenPaw Console API（SSE / upload）
       ▼
     QwenPaw（参赛者自行安装、启动）
```

说明：

- 与 `glasses-server` 通信的是 **开发版 APP**，不是 AI 眼镜直连服务端。
- **AI 眼镜**仅在 APP 需要出声或采集时参与，层级上属于 APP 的外设。
- 仓库内 **`glasses-client`** 模拟的是 **APP 的协议行为**，用于无 APP 环境下的排障，不能替代正式开发版 APP。

## 参赛者快速上手（推荐）

| 步骤 | 谁来做 | 做什么 |
|------|--------|--------|
| 1 | 参赛者 | 按 [QwenPaw 文档](https://qwenpaw.agentscope.io/docs/intro) **自行启动 QwenPaw** |
| 2 | 参赛者 | 安装本仓库：`pip install -e .` |
| 3 | 参赛者 | 编辑根目录 **`config.toml`** 并启动 **联调服务端** |
| 4 | 参赛者 | 打开 **开发版 APP**，按**接入与联调指南**连接联调服务端 |
| 5 | 参赛者 | 按**接入与联调指南**将 **AI 眼镜** 与 APP 配对；需要播放/采集时再使用眼镜 |

**参赛者在本仓库侧通常只需配置两项**（连 QwenPaw）：

```bash
# 编辑 config.toml 的 [qwenpaw].base_url 与 [qwenpaw].agent_id
glasses-server
```

修改配置后：**保存 `config.toml` → 重启 `glasses-server`**。

**开发版 APP** 连接服务端所需的 WS 地址、Token、`device_id` 等，以**接入与联调指南**为准，不在本 README 重复。

若 APP 与联调服务端不在同一台机器，需保证网络可达（例如同一局域网，APP 中填运行 `glasses-server` 的电脑 **局域网 IP**，勿填 `127.0.0.1`）。

## 功能概览

以下能力均由 **开发版 APP** 经协议触发，服务端转发 QwenPaw 后回推 APP（语音经 APP 播放到 AI 眼镜）：

| 能力 | 说明 |
|------|------|
| 文字问答 | `askType=1`，文本 `content` |
| 图片识物 | `askType=2`，`image` 为 Base64 / data URL |
| 意图识物流程 | 命中关键词后 `SCIntentMessage`，APP 再发 `askType=3` |
| 视频分析 | `askType=4`：HTTP 上传 mp4，经 WS 流式回推 `SCChat(askType=4)` |
| 媒体落盘 | 服务端将图片/视频写入 `tmp_media/`；`GET /media/...` 本地取回 |

## 环境要求

- Python **3.10+**（运行联调服务端）
- 参赛者本机已安装并可用的 **QwenPaw**
- **开发版 APP** 与 **AI 眼镜**（博维智慧提供）
- 本仓库依赖：`websockets`、`aiohttp`（`pip install -e .`）

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
python3 -m pip install -e .
```

开发/自测：`pip install -e ".[dev]"`。

## 启动 QwenPaw（参赛者自备）

QwenPaw **由参赛者自行下载、安装并启动**，本仓库不包含 QwenPaw。

1. 参考 [QwenPaw 官方文档](https://qwenpaw.agentscope.io/docs/intro) 完成安装与启动。
2. 记下访问地址（常见为 `http://127.0.0.1:8088`）及 Console 中的 **Agent / X-Agent-Id**。
3. 联调前确认 QwenPaw 可正常对话。

跨机联调时若 `glasses-server` 与 QwenPaw 不在同一台机器，或 Docker 端口只绑定了 `127.0.0.1`，见 [常见问题 2. Docker 跨机访问：端口映射](#2-docker-跨机访问端口映射)。

### QwenPaw Web 登录认证（可选）与联调服务端的 Token

QwenPaw 可选启用 Web 登录认证（`QWENPAW_AUTH_ENABLED=true`）。启用后：

- 若 `glasses-server` 访问 QwenPaw 走的是 `http://127.0.0.1:8088`（localhost），通常**无需**额外提供 `Authorization`（QwenPaw 文档说明 localhost 自动免认证）。
- 若 `glasses-server` 访问 QwenPaw 走的是局域网 IP / 域名 / 公网地址（即“远程访问”），则需要在请求头携带 `Authorization: Bearer <token>`。

获取 Token（在 QwenPaw 侧）：

- 登录获取 token：`POST /api/auth/login`
- 首次使用可注册管理员（单用户模式）：`POST /api/auth/register`

在本仓库（`glasses-server`）侧，通过 `config.toml` 的 **`[qwenpaw.auth].enabled`** 显式开关是否向 QwenPaw 携带认证信息：

| `enabled` | 行为 |
|-----------|------|
| `false`（默认） | 不发送 `Authorization`（适合本机 localhost 且 QwenPaw 免认证） |
| `true` | 必须配置 token **或** username+password，否则启动失败 |

`enabled=true` 时**二选一**（token 非空时优先于用户名密码）：

- **方式 A**：手动 token

```toml
[qwenpaw.auth]
enabled = true
token = "<YOUR_TOKEN>"
```

- **方式 B**：用户名/密码自动登录（token 留空）

```toml
[qwenpaw.auth]
enabled = true
username = "admin"
password = "admin123"
expires_in_s = 0
```

- **方式 A（手动 token）**：token 仅在本次运行有效；若 QwenPaw 返回 `401/403`，请重新获取 token，更新 `config.toml` 后**重启** `glasses-server`。
- **方式 B（用户名/密码）**：启动时用账号密码登录，token 保存在内存；若返回 `401/403` 会**自动重新登录一次**；仍失败请检查账号密码。重启服务会再次登录。

#### 自检：本地免认证 vs 远程需认证（QwenPaw 侧）

以下命令直接请求 QwenPaw（不是请求 `glasses-server`），用于确认认证是否生效。

1) 检查 QwenPaw 服务是否可用：

```bash
curl http://127.0.0.1:8088/api/version
```

2) 若你从 localhost 访问（示例为本机），通常无需 `Authorization`：

```bash
curl -X POST http://127.0.0.1:8088/api/console/chat \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: default" \
  -d '{"input":[{"role":"user","content":[{"type":"text","text":"你好"}]}],"channel":"console"}'
```

3) 若你从远程访问（将 host 换成局域网 IP/域名），请先登录获取 token，再携带 `Authorization`：

```bash
curl -X POST http://<QWENPAW_HOST>:8088/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

curl -X POST http://<QWENPAW_HOST>:8088/api/console/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "X-Agent-Id: default" \
  -d '{"input":[{"role":"user","content":[{"type":"text","text":"你好"}]}],"channel":"console"}'
```

## 配置并启动联调服务端

默认监听：WebSocket `8765`（路径 `/chat`）、HTTP `8866`（视频上传）。

```bash
# 编辑 config.toml 的 [qwenpaw].base_url 与 [qwenpaw].agent_id
glasses-server
```

修改配置后：**保存 `config.toml` → 重启 `glasses-server`**。

也可使用模块方式启动：`python3 -m glasses.server`

启动成功后，使用 **开发版 APP** 按**接入与联调指南**连接；需要时再配合 **AI 眼镜** 完成播放与采集。

### 服务端配置项（参赛者关注）

在根目录 **`config.toml`** 中修改（保存后重启 `glasses-server`）：

| 配置项 | `config.toml` 路径 | 默认 | 说明                                           |
|--------|-------------------|------|----------------------------------------------|
| QwenPaw 地址 | `[qwenpaw].base_url` | `http://127.0.0.1:8088` | 非本机/非默认端口时必改                                 |
| Agent ID | `[qwenpaw].agent_id` | `default` | 与 Console 不一致时必改                             |
| 启用 QwenPaw Web 认证 | `[qwenpaw.auth].enabled` | `false` | QwenPaw 开启认证且非 localhost 访问时设为 `true`        |
| Web 认证令牌（可选） | `[qwenpaw.auth].token` | 空 | `enabled=true` 时二选一；非空则优先使用                  |
| Web 认证用户名（可选） | `[qwenpaw.auth].username` | 空 | `enabled=true` 且未填 token 时，与 password 配合自动登录 |
| Web 认证密码（可选） | `[qwenpaw.auth].password` | 空 | 同上                                           |
| Web 认证 token 有效期（可选） | `[qwenpaw.auth].expires_in_s` | `0` | 仅在自动登录时使用；0 表示永久令牌                           |
| 视频提示词（可选） | `[qwenpaw].video_prompt` | 内置默认文案 | 视频分析 askType=4                               |
| 图片提示词（可选） | `[qwenpaw].image_prompt` | 内置默认文案 | askType=2/3 共用                               |
| 转发超时 | `[qwenpaw].timeout_s` | `300` | 视频等慢任务可加大                                    |
| WS 端口 | `[server].port` | `8765` | 端口占用时                                        |
| HTTP 端口 | `[server].http_port` | `8866` | 端口占用时                                        |

## 协议模拟工具 glasses-client（可选）

`glasses-client` 是仓库内的 **命令行协议模拟工具**，行为上模拟 **开发版 APP** 向 `glasses-server` 发消息，**不是**正式比赛客户端，也 **不代表** AI 眼镜硬件。

适用场景：暂无 APP、仅验证服务端与 QwenPaw 链路。

```bash
glasses-client --ask-type 1 --content "你好"
```

`glasses-client` 同样读取根目录 **`config.toml`** 的 `[client]` 段（与开发版 APP 配置无关）。

## 项目结构

```
ai_glasses_debug/
├── config.toml             # 参赛者配置文件（直接编辑）
├── pyproject.toml
├── glasses/
│   ├── common/             # 协议与日志
│   ├── qwenpaw/            # QwenPaw HTTP + SSE
│   ├── server/             # 联调服务端（glasses-server）
│   └── client/             # 协议模拟工具（glasses-client，可选）
├── tests/
├── demo/                   # glasses-client 自测用示例图/视频
└── tmp_media/              # 服务端落盘媒体（可删）
```

安装后可执行：`glasses-server`、`glasses-client`。

## 参赛者对接说明

### 路径 A：本仓库联调服务端 + 官方 APP（比赛主路径）

- **开发版 APP** 与 **AI 眼镜**由博维智慧提供；**协议客户端侧无需参赛者实现**。
- 参赛者使用本仓库 **`glasses-server`** 作为协议转发层，对接自备 **QwenPaw**。
- 参赛者职责：
  1. **自备 QwenPaw** 并启动；
  2. **配置并启动** `glasses-server`（编辑 `config.toml` 的 `[qwenpaw]` 配置）；
  3. 按**接入与联调指南**配置 **开发版 APP** 连接联调服务端；
  4. 按**接入与联调指南**将 **AI 眼镜** 与 APP 配对，在需要播放/采集时使用眼镜。

### 路径 B：自研协议服务端（不用本仓库 `glasses-server`）

- **开发版 APP** 仍由博维智慧提供，参赛者无需自研客户端或替代 APP。
- 若参赛者不使用本仓库 `glasses-server`，须**自行实现 AI 服务端**：接收 APP 的 WebSocket/HTTP 请求，按**AI 眼镜开发版接入与联调指南**约定的报文与业务流程处理并回推。
- 联调阶段可先用本仓库 `glasses-server` 对照协议行为；自研服务端排障时，可用仓库内 `glasses-client` **模拟 APP 发请求**（可选）。

服务端须实现的协议要点（完整定义见**接入与联调指南**）：

| 项 | 要求 |
|----|------|
| WS 路径 | `/chat` |
| WS Header | 校验 `access_token`（JWT，payload 含 `userId`）、`device_id` |
| 上行 | 处理 `CSChatWordImage`（`askType` 1/2/3/4） |
| 下行 | 推送 `SCChat`（`isEnd` 表本轮是否结束）、`SCIntentMessage`、`SCFinishAIMessage`、`SCError` |
| 视频 | 提供 `POST /api/chat/resources/upload`；Header 须含 `device_id`（与对应 WS 连接一致）；结果经 WS 异步回推 `SCChat(askType=4)` |
| TTS | 长回复建议分片 `SCChat(isEnd=false)`，末条 `isEnd=true`，供 APP 流式播报 |

联调模式下 JWT **不验签**（仅解析 `userId`）；生产环境须自行验签与鉴权。

## 鉴权与连接

### WebSocket Header（开发版 APP → 联调服务端）

| Header | 说明 |
|--------|------|
| `access_token` | JWT（payload 含 `userId`） |
| `device_id` | 逻辑设备 ID，非空；视频 HTTP 上传须与当前 WS 连接一致 |

具体 Token、`device_id` 以**接入与联调指南**为准。

### 服务端 token 策略（三选一）

- **默认**：非空 token 且能解析 `userId` 即放行。
- **白名单**：`--token-allowlist tokenA,tokenB`
- **正则**：`--token-regex "^test_\\w+$"`

## 协议模拟工具用法（可选）

以下命令均指 **`glasses-client`**，用于模拟 APP，非开发版 APP 使用方式。

### 文字（askType=1）

```bash
glasses-client --ask-type 1 --content "你好，介绍你自己。"
```

### 图片（askType=2）

```bash
glasses-client --ask-type 2 --image-file ./demo/demo.png
```

### 意图流程

```bash
glasses-client --ask-type 1 --content "帮我看看面前是什么" --intent-image-file ./demo/demo.png
```

### 交互模式

```bash
glasses-client --interactive
```

| 输入 | 行为 |
|------|------|
| 普通一行 | `askType=1` |
| `/img <path>` | `askType=2` |
| `/video <mp4>` | HTTP 上传，等待 `SCChat(4)` |
| `/quit` | 退出 |

### 视频上传（HTTP）约定

| 服务 | 默认地址 |
|------|----------|
| WebSocket | `ws://127.0.0.1:8765/chat` |
| HTTP 上传 | `http://127.0.0.1:8866/api/chat/resources/upload` |

- **POST** `/api/chat/resources/upload`，字段 `file`（mp4）
- **Header**：`Authorization: Bearer <token>`、`device_id`（与 WS 一致）
- **GET** `/media/{user_id}/{filename}`：本地取文件，**无鉴权**，勿用于生产暴露

## 服务端参数

`glasses-server --help` 查看完整参数；常用项见上文「服务端配置项」。

## 控制台日志

时间戳格式：`YYYY-MM-DD HH:MM:SS.mmm`（`glasses.common.logging_util`）。默认对 `data.image` 仅打印长度。

## 数据 Bridge 与 Telegram Agent

本项目增加了一个只读事件层，不改变原有 APP/QwenPaw 协议。它镜像设备上线/离线、上行文字/图片/视频，以及服务器下行的 `SCChat`、`SCIntentMessage`、`SCError` 等消息。

启动前设置 Bridge 访问令牌：

```bash
export GLASSES_BRIDGE_TOKEN="请换成高强度随机值"
```

读取最近事件：

```bash
curl http://127.0.0.1:18866/api/bridge/events \
  -H "Authorization: Bearer $GLASSES_BRIDGE_TOKEN"
```

实时事件 WebSocket：

```text
ws://127.0.0.1:18866/api/bridge/ws
Authorization: Bearer <GLASSES_BRIDGE_TOKEN>
```

图片和视频事件包含带鉴权的相对 `bridge_media_url`。下载时同样携带 `Authorization: Bearer <GLASSES_BRIDGE_TOKEN>`。Bridge JSON 不暴露服务器绝对文件路径，也不包含 APP 的 JWT。

启用 Telegram 双向 Agent，需要先通过 BotFather 创建 Bot，然后设置：

```bash
export TELEGRAM_BOT_TOKEN="123456:bot-token"
export TELEGRAM_CHAT_ID="123456789"
glasses-server
```

Telegram 会收到 APP 上行文字、图片、视频和服务器下行文字。直接向 Bot 发送文字时，该文字会进入当前在线眼镜设备的 QwenPaw 会话；Agent 回答会通过 `SCChat` 回传 APP，并同时显示在 Telegram。

Telegram 命令：

```text
/devices            查看在线设备
/use <device_id>    选择目标设备
/status             查看当前设备
/help               查看帮助
```

## 常见问题

| # | 主题 |
|---|------|
| 1 | [QwenPaw 连不上 / 服务端无回复](#1-qwenpaw-连不上--服务端无回复) |
| 2 | [Docker 跨机访问：端口映射](#2-docker-跨机访问端口映射) |
| 3 | [开发版 APP 连不上联调服务端](#3-开发版-app-连不上联调服务端) |
| 4 | [AI 眼镜无声音 / 无法采集](#4-ai-眼镜无声音--无法采集) |
| 5 | [HTTP 上传成功但 WS 无 `SCChat`](#5-http-上传成功但-ws-无-scchat) |
| 6 | [连接断开：token / userId](#6-连接断开token--userid) |
| 7 | [`tmp_media` 越来越大](#7-tmp_media-越来越大) |
| 8 | [Windows venv Permission denied](#8-windows-venv-permission-denied) |

### 1. QwenPaw 连不上 / 服务端无回复

1. 确认已**自行启动** QwenPaw。  
2. 检查 `config.toml` 中 `[qwenpaw].base_url`、`[qwenpaw].agent_id`。  
3. 查看 `glasses-server` 控制台 `[qwenpaw]` 日志。  
4. 根据报错区分两类问题（**与是否开启 Web 认证无关的是第 1 类**）：  
   - **连不上 / 拒绝连接**（如 `curl: (7)`、`Cannot connect to host`、`远程计算机拒绝网络连接`）→ 网络或 Docker 端口未对局域网开放，见 [2. Docker 跨机访问](#2-docker-跨机访问端口映射)。  
   - **已能连上但 HTTP 401/403** → 多为 QwenPaw 开启 Web 认证且 `base_url` 使用局域网 IP，需配置 `[qwenpaw.auth]`，见 [QwenPaw Web 登录认证](#qwenpaw-web-登录认证可选与联调服务端的-token)。

### 2. Docker 跨机访问：端口映射

当 **`glasses-server` 与 QwenPaw 不在同一台机器**，且 `config.toml` 中 `[qwenpaw].base_url` 填的是 QwenPaw 所在机器的**局域网 IP**（如 `http://192.168.x.x:8088`）时，必须先保证该 IP 的 **8088 端口在 TCP 层可达**。这与 QwenPaw 是否开启 Web 认证**无关**——未开认证时端口不通同样会报连接失败。

**典型原因（Docker）**：`docker ps` 显示 `127.0.0.1:8088->8088/tcp` 时，8088 **只监听在本机回环**，其他机器无法访问。本机 `curl http://127.0.0.1:8088/api/version` 正常，但在 `glasses-server` 所在机器上 `curl http://<QwenPaw局域网IP>:8088/api/version` 失败。

**处理**：将`127.0.0.1:8088:8088` 改为 `8088:8088` ，重新发布端口，绑定到所有网卡

**验证**（在运行 `glasses-server` 的那台机器上执行）：

```bash
curl http://<QWENPAW_HOST>:8088/api/version
```

通过后，确认 `config.toml` 中 `base_url` 与上述 IP 一致，并**重启 `glasses-server`**。

### 3. 开发版 APP 连不上联调服务端

1. 确认 `glasses-server` 已启动。  
2. APP 中服务端地址是否指向正确主机（跨机时用**局域网 IP**，勿用 `127.0.0.1`）。  
3. 对照**接入与联调指南**中的 WS 路径（`/chat`）、端口与 Token。

### 4. AI 眼镜无声音 / 无法采集

此类问题一般在 **APP 与 AI 眼镜** 的配对与权限，请查**接入与联调指南**或博维智慧技术支持；与 `glasses-server`、QwenPaw 配置无直接关系（除非 APP 未连上服务端导致无下行）。

### 5. HTTP 上传成功但 WS 无 `SCChat`

上传 Header 须带 **`device_id`**，且与当前 APP 的 WS 连接一致；该 `device_id` 的 WS 须保持在线。

### 6. 连接断开：token / userId

`access_token` 须能解析出 `userId`；`device_id` 必填（见**接入与联调指南**）。

### 7. `tmp_media` 越来越大

服务端不自动清理，可手动删除 `tmp_media/`。

### 8. Windows venv Permission denied

将项目移到可写目录，或 `py -m pip install -e .` 不使用 venv。
