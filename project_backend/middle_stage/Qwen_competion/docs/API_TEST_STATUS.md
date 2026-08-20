# LensGo × QwenPaw 外部 API 测试状态

日期：2026-07-23

## 已完成

| 测试 | 结果 |
|---|---|
| QwenPaw `/api/version` | HTTP 200 |
| QwenPaw CORS（`https://tauri.localhost`） | 通过 |
| LensGo Bridge 无 Token 请求 | HTTP 401，符合预期 |
| LensGo Bridge 正确 Token 请求 | HTTP 200 |
| LensGo Bridge CORS | HTTP 204，允许来源返回正常 |
| LensGo Bridge WebSocket 正确 Token | 握手成功，OPEN |
| LensGo Bridge WebSocket 错误 Token | 拒绝连接，符合预期 |
| QwenPaw 到 LensGo 状态检查 | reachable=true |
| Telegram Mirror / 图片分发 / Bridge 定向测试 | 15 passed |
| Pose 图片 API 工具测试 | 4 passed |

测试结束后 18088、18765、18866 均已关闭。一次性测试 Token 没有写入 `.env.integrated`，临时测试脚本已经删除。

## 当前配置缺口

项目根目录：`C:\Users\zhang\Desktop\Project\Qwen_competion\.env.integrated`

```dotenv
# LensGo App / Bridge
GLASSES_BRIDGE_TOKEN=

# 姿势参考图模型
POSE_IMAGE_PROVIDER=
POSE_IMAGE_API_KEY=
POSE_IMAGE_BASE_URL=
POSE_IMAGE_MODEL=
POSE_IMAGE_SIZE=

# Telegram 主消息/图片
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Telegram 状态通知（可与上面使用同一 Bot/Chat）
TELEGRAM_STATUS_BOT_TOKEN=
TELEGRAM_STATUS_CHAT_ID=

# 可选外部功能
AMAP_MCP_SERVER=
AMAP_CONFIG_FILE=
AI_DRIVE_MCP_SERVER=
```

QwenPaw 当前也没有活动模型，Web 登录鉴权处于关闭状态。正式给 Android 或公网使用前必须配置活动模型、开启登录，并使用 HTTPS/WSS。

## 下一轮真实测试顺序

1. 调用 Telegram `getMe` 验证 Bot Token；
2. 向指定 Chat ID 发送一条 LensGo 测试消息；
3. 发送一张测试图片，验证 `sendPhoto`；
4. 调用真实 Pose 图片 API 生成一张参考图；
5. 验证图片同时出现在统一 App 面板和 Telegram；
6. 故意提供一次无效生图请求，验证系统仍返回文字姿势建议。

请不要把 Token 或 API Key 提交到 Git，也不建议直接粘贴到聊天记录。可由用户在本机 `.env.integrated` 中填写；填写完成后再启动联调。

