# LensGo × QwenPaw 澳门旅行智能眼镜一体化项目

本目录是两个现有模块的统一工程入口：

- `lensgo-macao/`：AI 眼镜协议、图片/视频上传、旅行记忆、EventBridge 和 Telegram Bridge。
- `qwen_compitition/`：QwenPaw 多 Agent 运行时、模型与渠道、Skill/Driver、澳门行程和 Web 可视化控制台。

整合遵循“保留原功能、增量集成”的原则。两个子目录仍是独立 Git 仓库；原有源码、历史、启动脚本和功能路径全部保留。QwenPaw Console 现已增加 LensGo 控制中心和手机底部导航，同一套响应式前端可用于浏览器、电脑桌面和三星 Android 客户端。

## 结构

```text
Qwen_competion/
├─ lensgo-macao/                    # LensGo 模块
├─ qwen_compitition/                # QwenPaw 模块
├─ config/lensgo.integrated.toml
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ OPERATIONS.md
│  ├─ POSE_COACH.md
│  └─ HANDOFF.md
├─ scripts/
│  ├─ integrated.py                 # doctor/bootstrap/start/app/test
│  ├─ bootstrap.ps1 / bootstrap.sh
│  ├─ start.ps1 / start.sh
│  ├─ app.ps1                       # Windows 兼容入口
│  └─ build_android.ps1             # Android APK/AAB 构建入口
├─ tests/test_integrated_layout.py
├─ workspace/                       # 统一运行数据，不进入子仓库
├─ .env.integrated.example
└─ 启动 LensGo App.vbs
```

## 快速开始

要求 Python 3.11–3.13。Windows PowerShell：

```powershell
Copy-Item .env.integrated.example .env.integrated
.\scripts\bootstrap.ps1 --build-console
```

后续如需重新构建 Web 控制台：

```powershell
python .\scripts\integrated.py bootstrap --skip-install --build-console
```

之后双击 `启动 LensGo App.vbs` 可使用 Windows 兼容窗口。统一界面现在不只包含 QwenPaw：侧栏和手机导航中的 `LensGo 控制中心` 会显示 Bridge、实时眼镜事件、设备、Telegram 状态、最近画面和姿势参考图。

仍可使用原来的命令行方式：

```powershell
.\scripts\start.ps1
python .\scripts\integrated.py start --qwen-only
python .\scripts\integrated.py start --glasses-only
```

Linux / macOS / WSL：

```bash
cp .env.integrated.example .env.integrated
./scripts/bootstrap.sh
./scripts/start.sh
```

## 三星 Android 客户端

Android App 只运行响应式前端；QwenPaw、LensGo、模型和媒体仍运行在电脑或服务器。首次启动 APK 时输入：

- QwenPaw 地址，例如 `https://agent.example.com` 或局域网 `http://192.168.1.20:18088`；
- LensGo Bridge 地址，例如 `https://lensgo.example.com` 或局域网 `http://192.168.1.20:18000`；
- `GLASSES_BRIDGE_TOKEN`。

公网部署必须使用 HTTPS/WSS、QwenPaw 登录鉴权和可信反向代理。局域网测试时需将 `QWENPAW_HOST` 改为 `0.0.0.0`，并在 Windows 防火墙中只允许受信任的专用网络。

安装 Android Studio、Android SDK、JDK 和 Rust 后构建：

```powershell
.\scripts\build_android.ps1 -Initialize -DebugBuild
```

后续正式构建：

```powershell
.\scripts\build_android.ps1
```

Tauri Android 使用 `console/src-tauri/tauri.android.conf.json`，不会尝试把 Python 后端塞进手机，也不会改变桌面 Tauri 的本地侧车行为。

## 姿势教练

当用户通过眼镜、Telegram 或面板询问拍照姿势时，主 Agent 会咨询 `lensgo-pose-coach`，生成可朗读的动作指令，并按配置调用图片模型生成参考图。参考图显示在当前可视化聊天中，同时复用现有 EventBridge 与 Telegram Mirror 发送至 Telegram。

请在 `.env.integrated` 配置 `POSE_IMAGE_API_KEY`、`POSE_IMAGE_BASE_URL` 等变量。未配置或生图失败时只降级为文字建议，不会中断原有 Agent、语音、旅行和媒体功能。详见 `docs/POSE_COACH.md`。

## 统一运行约定

- QwenPaw：`http://127.0.0.1:18088`
- 眼镜 WebSocket：`ws://127.0.0.1:18765/chat`
- 媒体上传与 Bridge：`http://127.0.0.1:18000`
- QwenPaw 工作区：`workspace/qwenpaw/`
- LensGo 媒体与 SQLite 记忆：`workspace/runtime/lensgo-media/` 及相邻 `data/`
- App 日志：`workspace/logs/`
- 主 Agent：`lensgo-travel-director`

`gateway/app.py` 是保留的旧 FastAPI Gateway，不会被统一启动器默认拉起，因为它默认使用 8000 端口，可能与外部 AI Drive 冲突；需要时仍可按原模块文档单独启动。

## 外部服务

AMap MCP、AI Drive MCP 与 AI Drive 后端并不包含在这两个仓库中。请在 `.env.integrated` 填写真实路径和地址。缺少时 `doctor` 只报告可选项，`bootstrap` 不写入无效 Driver，也不会伪造替代实现。

## 无损保证

统一脚本遵守：

1. 不删除、移动或重命名两个子仓库中的原有文件。
2. Agent 已存在时跳过创建；新建 Agent 的默认 Prompt 才会安装仓库模板。
3. 已有 Agent 的 Prompt、Skill 和 Driver 仅在目标文件缺失时复制。
4. 同名文件内容不一致时保留目标文件并报告冲突。
5. `skill.json` 只合并缺失项，不修改已有启用状态或配置。
6. 外部服务未配置时只警告，不以假实现替代。

运行环境检查：

```powershell
python .\scripts\integrated.py doctor
```

完整运行与故障排查见 `docs/OPERATIONS.md`；姿势功能见 `docs/POSE_COACH.md`；
当前交接状态见 `docs/HANDOFF.md`；整个项目、两个模块、数据流和 Android
架构的系统说明见 `docs/项目详细说明.md`。
