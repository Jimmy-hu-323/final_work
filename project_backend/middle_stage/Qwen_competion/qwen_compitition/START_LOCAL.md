# 本机版 QwenPaw 启动说明

这套安装不使用 Docker，与已有容器互不影响。

## 目录

- 源码和独立 Python 环境：`/home/jimmyhu/Desktop/qwen_compitition/qwenpaw-local-latest`
- 独立工作数据、模型配置、聊天记录和 MCP 配置：`qwenpaw-local-latest/working/`
- Web 控制台端口：`8092`

## 启动

在终端运行：

```bash
cd /home/jimmyhu/Desktop/qwen_compitition/qwenpaw-local-latest
QWENPAW_WORKING_DIR="$PWD/working" \
  .venv/bin/qwenpaw app --host 127.0.0.1 --port 8092
```

浏览器访问：

```text
http://127.0.0.1:8092
```

按 `Ctrl+C` 停止服务。

## 首次配置模型

网页打开后，在 **设置 → 模型** 中配置你的模型供应商/API Key，再创建或选择一个默认模型。
安装已完成，但没有为你写入任何模型 API Key。

## 添加 AI Drive MCP

在 **智能体 → MCP → 创建客户端** 中粘贴：

```json
{
  "mcpServers": {
    "ai-drive": {
      "command": "/home/jimmyhu/Desktop/qwen_compitition/qwenpaw-local-latest/.venv/bin/python",
      "args": ["/home/jimmyhu/Desktop/ai-drive-mcp/server.py"],
      "env": {
        "AI_DRIVE_BASE_URL": "http://127.0.0.1:8000",
        "AI_DRIVE_TIMEOUT_SECONDS": "60",
        "QWENPAW_MEDIA_ROOT": "/home/jimmyhu/Desktop/qwen_compitition/qwenpaw-local-latest/working/workspaces/default/media"
      }
    }
  }
}
```

这次是本机原生 QwenPaw，因此 MCP 子进程能直接访问本机的 Python 和
`ai-drive-mcp` 路径，不会出现 Docker 容器路径不可见的问题。

### QwenPaw 主导的文件入库

当前默认工作区已安装 `qwenpaw_ai_drive_storage` Skill。你在 QwenPaw 聊天框上传文件后，
QwenPaw 负责读取、总结、分类并调用 MCP 存入 AI Drive；AI Drive 仅保存原文件与
QwenPaw 返回的路径、摘要、标签和关键点，不会再调用自己的模型、解析或建立向量索引。

修改 MCP 或 Skill 后，重启 QwenPaw 一次以重新加载它们。

## 澳门旅行规划与高德路线图

默认工作区已安装 `macau_trip_planner` Skill 和 `amap-macau` MCP。它采用 TravelAI 首页同样的核心规划流程：先分轮询问天数、住宿/起点、同行人、兴趣与交通偏好，再展示行程确认；确认后才查询高德 POI，按天计算每一段真实路线、每个地点的到达/离开时间、每日总路程/在途时间，并把每天的路线图 PNG 直接发送到 QwenPaw 聊天。

地图密钥只保存在本机的 `/home/jimmyhu/Desktop/amap-mcp/.env`（权限为 `600`），不会写进 MCP 卡片或 Skill。路线图文件会生成在：

```text
working/workspaces/default/media/travel_maps/
```

使用时只需在聊天中输入，例如：

```text
我想去澳门旅游，帮我规划三天两晚的美食和历史路线。
```

### 旅行规划工作台

行程确认并生成后，点击左侧 **聊天** 下方的 **旅行规划**。页面会自动读取最新行程，按天展示地点、到达/离开时间、真实路程和高德路线地图；每 10 秒自动刷新，也可以点击右上角 **刷新行程**。若当前还没有地图，先在 Chat 中完成一次行程确认即可。

### 相册

在左侧 **旅行规划** 下方点击 **相册**，即可查看 AI Drive 中的所有图片。相册按图片 EXIF 的拍摄时间倒序排列；没有拍摄时间的图片会自动按 AI Drive 上传时间排列。图片通过 QwenPaw 安全转发，因此从远程浏览器访问 QwenPaw 时也能正常显示；点击缩略图可查看大图和已有的拍摄信息。右上角 **上传照片** 可一次选择多张图片（单张最大 20 MB）；大图弹窗中的 **删除照片** 会将图片移入 AI Drive 回收站，而非永久删除。

修改地图 MCP、Skill 或密钥后，重启 QwenPaw 一次。高德静态路线图使用 Web 服务 Key；若高德返回 `USERKEY_PLAT_NOMATCH (10009)`，需要在高德控制台新建或提供“Web服务”类型的 Key，不能使用 JS API 类型的 Key。

开始前还需要启动 AI Drive 后端（端口 `8000`）：

```bash
cd /home/jimmyhu/Desktop/ai-drive
docker compose up -d
cd backend
CORS_ORIGINS=http://127.0.0.1:5174,http://localhost:5174 \
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## 更新

在新目录内执行：

```bash
git pull --ff-only
cd console && npm ci && npm run build
cd ..
mkdir -p src/qwenpaw/console
cp -R console/dist/. src/qwenpaw/console/
uv pip install -e .
```

更新后重启 QwenPaw，并在浏览器按 `Ctrl+Shift+R` 刷新页面。
