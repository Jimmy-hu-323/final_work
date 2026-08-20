# LensGo 多 Agent 旅行记忆架构

## 当前入口

- 眼镜文字、图片和视频统一路由到 `lensgo-travel-director`。
- LensGo 大使 Bot 的文字复用当前在线眼镜设备会话，也进入同一主 Agent。
- LensGo 大使 Bot 支持发送照片和附言；照片进入同一多模态会话，回答同时返回 Telegram 与眼镜 APP。
- 工作状态 Bot 只显示设备、Router、Agent 协作与错误，不接受生活对话。
- Router 根据认证后的 `userId` 生成不可逆、稳定的 `traveler_id`，不会把原始 userId 暴露给模型作为身份名称。
- 共享状态位于 `ai_glasses_debug/data/lensgo_memory.db`；每个 QwenPaw Agent 仍保留自己的 ReMeLight 私有记忆。

## Agent 分工

| Agent ID | 职责 |
| --- | --- |
| `lensgo-travel-director` | 唯一面向用户，理解意图并生成适合眼镜朗读的旅行表达 |
| `lensgo-vision-curator` | 图片/视频场景、构图、人物互动、隐私及重要性判断 |
| `lensgo-memory-keeper` | 用户偏好、旅程和幸福时刻整理 |
| `lensgo-media-archivist` | 媒体去重、保留期限和隐私策略 |

主 Agent 通过 QwenPaw 的 `chat_with_agent`/`submit_to_agent` 调用专家。专家结果不直接发送到 APP。

## 数据流

1. Router 接收 APP 或 Telegram 消息。
2. 写入一条共享 observation，并注入最近 5 条同用户记录。
3. 发送到旅行主 Agent；主 Agent按需调用专家。
4. 最终自然语言通过 `SCChat` 回传 APP，并由大使 Bot 合并后显示。
5. 内部 `agent.route`、设备状态和错误只进入工作状态 Bot。

## 两个 Telegram Bot

在 `.env.bridge` 中配置：

```bash
# LensGo 大使：生活化对话，可交互
TELEGRAM_BOT_TOKEN="..."
TELEGRAM_CHAT_ID="..."

# LensGo 工作台：状态与协作，只读
TELEGRAM_STATUS_BOT_TOKEN="..."
TELEGRAM_STATUS_CHAT_ID="..."
```

两个 Bot 可以发送到同一个 Telegram 账号的私聊，也可以分别发送到不同群组。Token 必须来自两个不同的 BotFather Bot。

## 接口

- APP WebSocket：`ws://127.0.0.1:18765/chat`
- 视频上传：`http://127.0.0.1:18866/api/chat/resources/upload`
- Bridge 历史：`GET http://127.0.0.1:18866/api/bridge/events`
- Bridge 实时：`ws://127.0.0.1:18866/api/bridge/ws`

Bridge 接口继续使用 `Authorization: Bearer $GLASSES_BRIDGE_TOKEN`。

## 存储边界

官方 APP 是否在手机本地保存，服务端无法控制。服务端当前仍在 `tmp_media` 保存收到的媒体，以支持 QwenPaw 上传和 Telegram 镜像；共享数据库只保存引用和文字观察。后续可增加确认式重要时刻归档和临时媒体定时清理。

## 启动

```bash
cd /home/lkzhang/qwen_comp
./run_all.sh
```

修改 Agent 提示词或 `config.toml` 后需要重启本脚本启动的 glasses-server；不需要重启 frps。
