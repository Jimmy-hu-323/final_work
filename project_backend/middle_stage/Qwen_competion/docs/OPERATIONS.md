# 运行、验证与故障排查

## 1. 环境检查

```powershell
python .\scripts\integrated.py doctor
```

`ERROR` 是一体化基础条件缺失；`WARN` 通常是尚未配置的外部 MCP、Token 或尚未执行 bootstrap。

## 2. 初始化

```powershell
Copy-Item .env.integrated.example .env.integrated
notepad .env.integrated
.\scripts\bootstrap.ps1
```

bootstrap 会创建外层 `.venv`、以 editable 方式安装两个 Python 模块、初始化统一 QwenPaw 工作区、创建四个 LensGo Agent，并把澳门行程和 AI Drive Skill 合并到主 Agent。重复运行是安全的。

脚本化初始化会接受 QwenPaw CLI 展示的本地运行安全声明，并在统一工作区写入匿名遥测退出标记；不会提交遥测。

外部 MCP 路径未填写时会跳过对应 Driver。补齐 `.env.integrated` 后再次运行 bootstrap 即可。

## 3. 启动

```powershell
.\scripts\start.ps1
```

启动器在前台托管两个进程；按 `Ctrl+C` 会同时结束本次启动的 QwenPaw 和 LensGo。不会停止用户在别处启动的同名服务。

可单独启动：

```powershell
python .\scripts\integrated.py start --qwen-only
python .\scripts\integrated.py start --glasses-only
```

## 4. 验证

```powershell
python .\scripts\integrated.py test
```

这会运行外层布局测试、LensGo 测试和 QwenPaw 测试。完整 QwenPaw 测试量较大；只做一体化静态验证时：

```powershell
python -m unittest discover -s tests -v
```

服务启动后可检查：

```powershell
Invoke-WebRequest http://127.0.0.1:18088/
Invoke-WebRequest http://127.0.0.1:18000/api/bridge/events `
  -Headers @{ Authorization = "Bearer $env:GLASSES_BRIDGE_TOKEN" }
```

## 5. 常见问题

### QwenPaw 初始化提示模型未配置

确认 `.env.integrated` 中 `QWENPAW_PROVIDER_ID` 与 `QWENPAW_MODEL_ID` 对应本机 QwenPaw 可用 Provider。必要时先按 QwenPaw 原文档配置模型，再重跑 bootstrap。

### AMap / AI Drive Skill 存在但工具不可用

这两个 MCP 服务不在当前仓库中。填写 `AMAP_MCP_SERVER`、`AMAP_CONFIG_FILE`、`AI_DRIVE_MCP_SERVER` 和 `AI_DRIVE_BASE_URL`，确保路径存在，再重跑 bootstrap。

### 8000 端口冲突

AI Drive 默认使用 8000，LensGo 旧 Gateway 也默认使用 8000。统一启动器不启动旧 Gateway；如必须同时运行，请用原 Gateway 的 Uvicorn 参数改到其他端口。

### TravelPlanner 页面没有最新行程

检查：

`workspace/qwenpaw/workspaces/default/media/travel_maps/latest-itinerary.json`

主 Agent 与 default Agent 生成的 AMap Driver 都把输出指向这个目录。

### Telegram 未启动

原 LensGo 配置保持 Telegram 功能开启，但缺 Token/Chat ID 时原逻辑会安全跳过。填写 `.env.integrated` 后重启即可。

## 6. 回退

外层整合没有迁移子仓库文件。需要回到原运行方式时，停止统一启动器，然后分别按 `lensgo-macao/README.md` 和 `qwen_compitition/README.md` 操作即可。不要删除 `workspace/`，其中可能包含会话、媒体和旅行记忆。
