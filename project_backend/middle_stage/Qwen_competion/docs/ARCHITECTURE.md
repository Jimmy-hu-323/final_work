# 一体化架构

## 边界

本次整合采用外层编排，不把两个仓库物理揉成一个源码树：

- LensGo 保持设备协议与媒体入口的唯一实现。
- QwenPaw 保持 Agent、Skill、Driver、模型、渠道和控制台的唯一实现。
- 外层只提供配置、工作区和生命周期编排。

这能保留两个仓库的 Git 历史与单独运行能力，也避免复制实现产生双版本逻辑。

## 主链路

```text
AI 眼镜 / 联调客户端
  │ WebSocket / HTTP
  ▼
LensGo glasses-server :18765 / :18000
  ├─ 协议、鉴权、媒体存储
  ├─ LensGo SQLite 旅行记忆
  ├─ 数据 Bridge / Telegram Bridge
  └─ X-Agent-Id: lensgo-travel-director
             │ HTTP + SSE
             ▼
QwenPaw :18088
  ├─ lensgo-travel-director（主编排）
  ├─ lensgo-vision-curator（视觉）
  ├─ lensgo-memory-keeper（记忆）
  ├─ lensgo-media-archivist（归档）
  ├─ macau_trip_planner Skill → AMap MCP
  ├─ qwenpaw_ai_drive_storage Skill → AI Drive MCP
  └─ TravelPlanner / TravelAlbum 控制台
```

## 数据归属

| 数据 | 统一位置 | 生产者/消费者 |
|---|---|---|
| QwenPaw 配置与会话 | `workspace/qwenpaw/` | QwenPaw |
| 各 Agent Prompt | `workspace/qwenpaw/workspaces/<agent>/` | bootstrap 从 LensGo Prompt 模板缺失复制 |
| 澳门行程 JSON/地图 | `workspace/qwenpaw/workspaces/default/media/travel_maps/` | AMap MCP / TravelPlanner UI |
| AI Drive 待归档媒体 | `workspace/qwenpaw/workspaces/default/media/` | QwenPaw / AI Drive MCP |
| 眼镜媒体 | `workspace/runtime/lensgo-media/` | LensGo |
| 旅行记忆 SQLite | `workspace/runtime/data/lensgo_memory.db` | LensGo |

行程输出固定到 `default` 工作区，是因为当前 TravelPlanner 后端按该路径读取 `latest-itinerary.json`。主 Agent 的 AMap Driver 同样指向此目录，从而把 LensGo 对话结果和控制台显示接到同一份数据上。

## 端口策略

| 服务 | 端口 |
|---|---:|
| QwenPaw | 18088 |
| LensGo WebSocket | 18765 |
| LensGo HTTP / Bridge | 18000 |
| 外部 AI Drive（默认） | 8000 |

旧 `gateway/app.py` 默认也是 8000，因此不纳入默认一体化启动。它仍保留并可单独配置端口运行。

## 无损策略

所有整合写入均发生在外层或 `workspace/`。bootstrap 使用存在性检查、内容比对和 JSON 缺失项合并；新建 Agent 的框架默认 Prompt 会立即替换为 LensGo 仓库提供的模板，已存在 Agent 的任何同名冲突则保留用户文件。两个源码仓库只会在用户主动选择安装依赖或构建前端时产生标准安装/构建产物，业务源码不会被重写。
