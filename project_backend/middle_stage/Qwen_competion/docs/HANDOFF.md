# LensGo × QwenPaw 统一 App 技术交接

最后更新：2026-07-24  
桌面项目：`C:\Users\zhang\Desktop\Project\Qwen_competion`

## 0. 接手者先读

这是当前唯一应优先阅读的状态摘要，后续章节保存设计与验证细节。

### 0.1 当前完成度

| 范围 | 当前结论 |
|---|---|
| 两个原仓库 | 完整保留为两个独立 Git 仓库；当前都有未提交的集成改动，禁止 `reset --hard` 或覆盖工作树 |
| 外层一体化工作区 | 已完成统一配置、bootstrap、doctor、start、desktop app、test 与 Android build 入口 |
| 统一 Web/桌面界面 | 已完成 LensGo 控制中心和原 QwenPaw 对话、旅程、相册、设置的统一导航 |
| Android App | arm64 Debug APK 已构建、安装并在 Samsung SM-A5360 真机运行；包名 `io.lensgo.macao.mobile` |
| 眼镜连接 | 小舟 AI App 已经通过 USB reverse 连接 LensGo WebSocket/HTTP；眼镜图片和 Agent TTS 已真实通过 |
| LLM | 阿里云 Token Plan 国际版自定义 Provider 已真实返回 HTTP 200；活动模型为 `qwen3.7-plus` |
| 姿势生图 | OpenRouter `openai/gpt-image-1` 已生成约 3 MB PNG；QwenPaw 会话显示通过 |
| Telegram | Bot 鉴权、真实 Chat ID、文字和图片投递均已单独通过 |
| 完整眼镜语音链 | 尚未通过；唯一当前阻塞是小舟 App 的阿里云 NLS 语音凭证仍为占位文字，NLS 返回 HTTP 403 / 144003 |
| AMap / AI Drive | 可选外部依赖仍未配置；因此真实地图和 AI Drive 相册尚未最终验收 |

### 0.2 下一位接手者第一件事

不要继续改模型、Bridge 或 Android 网络。先让用户在小舟 App 的
`我的 → 阿里云语音配置` 填入真实的智能语音交互 NLS `AppKey`、RAM
`AccessKey ID` 和 `AccessKey Secret`。这三项不是 Token Plan 的 `sk-...`
大模型 Key。填好后：

1. 确认 USB 仍连接并执行 `adb reverse --list`；
2. 确认 18088、18765、18000 均在监听；
3. 对眼镜说“我在大三巴前应该摆什么姿势？给我一张参考图。”；
4. Bridge 应先出现 `upstream text`，然后出现 Agent 路由和 downstream image；
5. 同时检查眼镜 TTS、Android LensGo 面板和 Telegram 图片。

如果仍失败，先看小舟 App `VoiceASR` / `iDST::NLS` 日志，不要把拍照事件
`askType=2` 误当成语音文字事件 `askType=1`。

### 0.3 当前文件真相

- 项目根目录不是把两个仓库 squash 后的新 Git 仓库，而是外层编排目录。
- `lensgo-macao/` 当前基线提交：`80e65486b1100d04b3230ec39f684b87ce1de265`。
- `qwen_compitition/` 当前基线提交：`c17175333c8b8094e9342c8b49ea3744665b95ce`。
- 两个仓库中的修改均属于本轮集成成果或用户已有内容，不要擅自丢弃。
- 真实凭证只在本机 `.env.integrated`、QwenPaw 工作区或手机 App 中；文档不得写入明文密钥。
- Android SDK/NDK、JDK、Rust、MSVC、缓存、日志、APK、真机截图和辅助脚本都集中在项目根目录 `tmp/`，可整体清理但当前仍用于复现构建。
- 面向整体理解的配套文档为 `docs/项目详细说明.md`。

## 1. 当前结论

两个原仓库仍作为独立模块保留，没有删除、移动或重命名原功能。现在新增的是一层增量集成：

- QwenPaw 原 React Console 成为统一界面的基础；
- 新增真正的 `LensGo 控制中心`，显示 Bridge、眼镜事件、设备、媒体、Pose 图片和 Telegram 状态；
- 原 QwenPaw 对话、旅行规划、旅行相册、设置页面全部保留并进入统一导航；
- 桌面继续支持浏览器和原有 Windows/Tauri/pywebview 入口；
- Android 使用 Tauri v2 打包同一套响应式界面，手机只做客户端，Python、Agent、模型和媒体服务运行在电脑或云服务器；
- Pose Coach 的“理解姿势 → 生成参考图 → 可视化面板 + Telegram”链路继续保留。

这不是“把 QwenPaw 网页单独塞进壳里”。统一 App 的 React 前端同时直接调用 QwenPaw API 和 LensGo Bridge API/WebSocket。

## 2. 最终架构

```text
LensGo 眼镜 ───────┐
Telegram ──────────┼── LensGo 服务 :18765 / :18000
                   │      ├─ EventBridge
                   │      ├─ 媒体与最新图片
                   │      └─ Telegram Mirror
                   │
三星 Android App ──┼── HTTPS/WSS + Token ── 电脑或云服务器
桌面 App / Web ────┘                         ├─ QwenPaw :18088
                                           ├─ LensGo :18000
                                             └─ 模型 / Agent / 图片生成
```

Android 端不运行 Python sidecar。这样可避免 Android 后台进程、Python 依赖、模型内存和文件系统兼容问题，也方便后续通过服务器升级 Agent 而无需频繁更新 APK。

## 3. 统一 App 界面

手机底部固定五个入口：

1. `LensGo`：Bridge 在线状态、实时事件流、设备数、事件数、QwenPaw、Telegram、最新眼镜画面/姿势图。
2. `对话`：原 QwenPaw Chat，也是 Pose Coach 的主要自然语言入口。
3. `旅程`：原旅行规划可视化页面。
4. `相册`：原旅行相册和上传功能。
5. `设置`：原模型、Provider、Agent 等设置。

手机宽度隐藏桌面侧栏，使用底部导航；桌面和平板继续使用原侧栏。Android 首次启动显示连接页，配置 QwenPaw URL、LensGo URL 和 Bridge Token。URL 保存在本地，Bridge Token 只保留在 `sessionStorage`，关闭 App 后清除。

真实 Galaxy S9+ 规格浏览器联调结果：LensGo 在线、实时流已连接、QwenPaw 可达、五个移动导航存在；对话、旅程、相册路由均能进入。

## 4. 关键代码位置

### QwenPaw Console / Android

```text
qwen_compitition/console/src/pages/LensGoDashboard/
qwen_compitition/console/src/layouts/MobileNavigation/
qwen_compitition/console/src/components/MobileConnectionGate.tsx
qwen_compitition/console/src/api/lensgo.ts
qwen_compitition/console/src/api/config.ts
qwen_compitition/console/src/App.tsx
qwen_compitition/console/vite.config.ts
qwen_compitition/console/src-tauri/tauri.android.conf.json
qwen_compitition/console/src-tauri/capabilities/mobile.json
qwen_compitition/console/src-tauri/src/lib.rs
qwen_compitition/console/src-tauri/Cargo.toml
```

### LensGo Bridge

```text
lensgo-macao/ai_glasses_debug/glasses/server/data_bridge.py
lensgo-macao/ai_glasses_debug/glasses/server/app.py
lensgo-macao/ai_glasses_debug/glasses/server/qwenpaw_bridge.py
```

新增了带 Token 的状态接口、跨域中间件、实时事件/媒体读取，以及生成 Pose 图片对应的 Bridge 媒体 URL。WebSocket 浏览器客户端通过查询 Token 鉴权；公网必须使用 WSS，避免 Token 经明文网络传输。

### 外层工作区

```text
scripts/integrated.py
scripts/build_android.ps1
docs/MOBILE_APP.md
.env.integrated.example
tests/test_integrated_layout.py
```

## 5. 姿势生成链路

```text
用户通过眼镜 / Telegram / App 提问姿势
  → lensgo-travel-director 判断场景
  → 咨询 lensgo-pose-coach
  → 输出动作、构图、安全提醒和生图 Prompt
  → generate_pose_reference 调用图片模型
  → send_file_to_user 回到当前 QwenPaw 会话
  → LensGo on_media / EventBridge
  → 统一控制中心显示最新图
  → TelegramMirror.sendPhoto
```

图片模型、媒体落盘或 Telegram 失败时会降级为文字建议，不中断原有文字/TTS、旅行、记忆和媒体功能。

## 6. 配置与启动

电脑本地启动：

```powershell
cd C:\Users\zhang\Desktop\Project\Qwen_competion
.\.venv\Scripts\python.exe .\scripts\integrated.py doctor
.\scripts\start.ps1
```

Windows 兼容窗口仍可双击：

```text
启动 LensGo App.vbs
```

局域网 Android 联调至少需要：

```dotenv
QWENPAW_HOST=0.0.0.0
QWENPAW_CORS_ORIGINS=http://tauri.localhost,https://tauri.localhost,tauri://localhost
LENSGO_CORS_ORIGINS=*
GLASSES_BRIDGE_TOKEN=足够长的随机值
```

局域网直连时，手机连接地址必须使用电脑真实局域网 IP，不能用
`127.0.0.1`。若使用 USB 调试并执行 `adb reverse`，手机端则应使用
`127.0.0.1`，由 ADB 将端口回环到电脑。公网不得直接暴露明文端口，
必须使用 HTTPS/WSS、QwenPaw 登录鉴权和受控反向代理。

Android 9 及以上默认限制发行包使用明文 HTTP。正式 APK/AAB 应连接 HTTPS/WSS；局域网 Debug APK 如需 HTTP，只在生成后的 Debug Manifest 临时允许 cleartext traffic，不要把该设置带进公开发行包。

## 7. Android 构建状态

Android 源码、移动构建、Tauri 配置和打包脚本均已完成。为满足“配套内容集中在项目 `tmp/`”的要求，便携构建链已经安装在项目临时目录，而不是散落到系统目录：

- JDK 17.0.19：`tmp/android-build-tools/jdk17-extracted`；
- Android SDK Platform / Build Tools 35、36：`tmp/android-build-tools/android-sdk`；
- Android NDK r27c：`tmp/android-build-tools/android-sdk/ndk/27.2.12479018`；
- Rust/Cargo 与 Android target：`tmp/android-build-tools/rust`；
- MSVC 构建组件：`tmp/vs`；
- Gradle/Cargo 缓存：`tmp/android-build`。

Tauri Android 初始化和 arm64 Debug 构建已经真实通过。Windows 未启用全局开发者模式，因此构建时仅使用一次提升权限的进程完成 Tauri 所需符号链接，没有修改全局开发者模式。可复现命令仍为：

```powershell
cd C:\Users\zhang\Desktop\Project\Qwen_competion
.\scripts\build_android.ps1 -Initialize -DebugBuild
```

正式 AAB：

```powershell
.\scripts\build_android.ps1 -Aab
```

官方依赖清单见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)，Google Play/AAB 流程见 [Tauri Google Play](https://v2.tauri.app/distribute/google-play/)。

已产出的真机调试包：

```text
tmp/apk/LensGo-Macao-Mobile-debug-arm64.apk
package: io.lensgo.macao.mobile
versionName: 1.0
minSdk: 24
targetSdk: 36
ABI: arm64-v8a
SHA-256: 0861899020BAA9837C031E3F08B5308CDB82919265F74667A24224587DADA733
```

## 8. 验证证据

| 范围 | 结果 |
|---|---:|
| QwenPaw Console 全量 Vitest | 130 files，1162 passed |
| 前端改动 ESLint | 0 errors，2 个既有 Fast Refresh warnings |
| 前端配置定向测试 | 11 passed |
| LensGo 全量测试 | 42 passed |
| 外层集成布局测试 | 8 passed，24 subtests |
| QwenPaw Pose 工具既有回归 | 194 passed，1 skipped |
| `npm run build` | passed |
| `npm run build:mobile` | passed |
| `integrated.py doctor` | 0 errors |
| Galaxy S9+ 规格真实浏览器联调 | passed |
| Tauri Android arm64 Debug APK 构建 | passed |
| Samsung SM-A5360 安装与原生启动 | passed |
| 原生 App 五栏导航 | passed |
| 原生 App Bridge / WebSocket / QwenPaw / Telegram 状态 | passed |

联调中旅行规划空数据接口返回 404，页面按预期展示“还没有可展示的旅行行程”；相册 API 返回 502 并显示“AI Drive 图片服务暂时不可用”，原因是外部 AI Drive 没有配置，不是本次集成回归。

## 9. 外部配置状态

- OpenRouter 图片生成：已配置并真实通过；
- Bridge Token：已自动生成并写入本地集成环境；
- Telegram：Bot 鉴权、用户会话发现、文字投递和姿势图片投递均已真实通过；
  正确 Chat ID 已同步到主通道与状态通道配置；
- 阿里活动模型：已按 Token Plan 国际版自定义 Provider 接入，使用
  `aliyun-tokenplan-intl-custom/qwen3.7-plus`；`/models` 和真实对话请求
  均返回 HTTP 200；
- AMAP 与 AI Drive：仍需相应 MCP 服务或配置文件。

界面与本地服务不依赖这些外部凭证即可启动；模型回答、Telegram 双投递、地图
和 AI Drive 相册的最终验收需要对应外部服务可用。

## 10. 后续模型必须遵守

1. 不删除、移动、重命名原页面、Agent、Skill、接口或测试。
2. 不把 Android 改成在手机内运行 Python/QwenPaw；当前正确边界是远程客户端。
3. 不让图片、Bridge 或 Telegram 失败中断文字/TTS 主链。
4. 不放宽本地图片根目录、类型、大小及 HTTPS 安全限制。
5. 不提交 `.env.integrated`、API Key、Bot Token、聊天数据或运行 workspace。
6. 不使用强制依赖升级修复审计问题，除非先完成兼容评估和全量回归。
7. 保持桌面入口兼容；Android 特有逻辑必须继续由 `MOBILE` 和 Tauri 平台配置隔离。
8. ADB、Android SDK/NDK、便携 JDK/Rust、真机截图、临时 APK 和调试日志等
   配套或可清理内容统一放在项目根目录 `tmp/`；不要散落到 Codex 工作区、
   用户目录或两个原模块中。`tmp/` 已加入外层 `.gitignore`。

## 11. 推荐下一步

1. 保持 USB、三个 `adb reverse` 映射和电脑服务运行，对眼镜说一次完整姿势请求，验收“眼镜语音 → Agent → 生图 → 原生 App + Telegram”。
2. 修正 Android 状态栏安全区，使顶部 QwenPaw 标题不与三星状态栏重叠；同时屏蔽移动端无意义的桌面托盘/更新器调用警告。
3. 如需相册功能，补齐 AI Drive 服务；如需地图，补齐 AMAP MCP/配置。
4. 生产部署时配置 HTTPS/WSS、登录、速率限制、持久且安全的凭证方案以及签名 AAB。

## 12. 2026-07-23 外部 API 实测更新

- 新增 `POSE_IMAGE_PROVIDER=openrouter`，使用 OpenRouter 当前专用
  `POST /api/v1/images` 接口；传统 OpenAI-compatible 仍保留原
  `/images/generations` 行为。
- 本机 `OPENROUTER_API_KEY` 已成功调用 `openai/gpt-image-1`，生成并
  校验了一张约 3 MB 的 PNG 姿势参考图。
- QwenPaw 工具层回归更新为 `195 passed, 1 skipped`。
- 更新后的 Telegram Bot Token 已通过真实 `getMe` 鉴权；用户发送 `/start`
  后，系统通过 `getUpdates` 自动识别真实 Chat ID，随后 `sendMessage` 和
  `sendPhoto` 均成功，正确 Chat ID 已写回主通道和状态通道配置。
- 用户确认 Key 属于新版阿里云 Token Plan 国际版，需通过自定义 Provider
  接入。已使用 OpenAI 兼容地址
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`，
  `/models` 返回 HTTP 200 且列出 `qwen3.7-plus`，真实对话也返回 HTTP 200。
  自定义 Provider `aliyun-tokenplan-intl-custom` 已同步到全局活动模型及
  5 个 LensGo Agent。
- 自动生成的 Bridge Token、Telegram 字段、OpenRouter Pose 配置和移动端
  CORS 已写入 `.env.integrated`，所有密钥均未写入本交接文档。

## 13. 2026-07-23 三星真机、USB 与小舟 AI 眼镜实测

- 手机：Samsung SM-A5360，Android 12 / API 31，ADB 序列号仅保留在本机
  调试环境中；USB 调试已授权。
- 便携 ADB 位于项目临时目录：
  `tmp/android-platform-tools/platform-tools/adb.exe`。
- 已建立并验证以下 USB 反向端口：
  - `tcp:18088 -> tcp:18088`（统一 QwenPaw/LensGo 移动界面）；
  - `tcp:18765 -> tcp:18765`（小舟 AI WebSocket）；
  - `tcp:18000 -> tcp:18000`（图片/视频上传与 LensGo Bridge HTTP）。
- 三星 Chrome 打开 `http://127.0.0.1:18088` 后，统一移动界面的五栏导航
  （LensGo、对话、旅程、相册、设置）均可正常显示。LensGo 页面配置
  `http://127.0.0.1:18088`、`http://127.0.0.1:18000` 和 Bridge Token 后，
  已显示 Bridge 在线、实时事件流已连接、QwenPaw 可达、Telegram 已配置。
- 小舟 App 包名为 `com.barcoverse.bci.glasses`，眼镜固件显示
  `1.0.9.68`。APK 只读分析确认它直接包含项目协议 `/chat` 与
  `/api/chat/resources/upload`，不是不兼容的第三方协议。
- 小舟 App 的 `我的` 页面具有 `HttpUrl配置` 和 `AI WebSocket 配置`。
  原值指向校园网地址 `10.9.44.48`，因 Wi-Fi 客户端隔离无法访问电脑；
  真机上现已改为：
  - AI WebSocket：`ws://127.0.0.1:18765/chat`；
  - HttpUrl：`http://127.0.0.1:18000/api/chat/resources/upload`。
- 改完后，Windows 在本地 `18765` 端口观察到来自 ADB 回环的
  `Established` TCP 会话，证明小舟 App 已与电脑上的 LensGo WebSocket
  真实握手成功。
- 在三星 Chrome 的统一 App 中发送了真实姿势请求。Agent 成功给出动作建议，
  调用 OpenRouter `openai/gpt-image-1` 生成约 3.08 MB PNG，并执行
  `send_file_to_user`，图片在 QwenPaw 会话中可用。
- 当前已确认一个集成边界：从 QwenPaw Console 直接发起的聊天不会经过
  LensGo 的 `on_media` 回调，因此该次图片不会自动增加 LensGo 事件数，也
  不会触发 LensGo Telegram Mirror；从小舟眼镜 WebSocket、LensGo HTTP 或
  Telegram 入口发起的请求会经过现有回调。后续若要求“Console 直聊也同步
  LensGo/Telegram”，应新增明确的 QwenPaw -> LensGo 生成媒体投递接口或
  channel hook，不能依赖目录轮询。
- 下一项物理验收：保持 USB 连接和三个服务运行，对眼镜说
  “我在大三巴前应该摆什么姿势？给我一张参考图。”随后检查 Bridge 事件、
  手机 LensGo 面板和 Telegram 图片。ADB reverse 在拔线、重启 ADB 或手机
  重启后可能消失，需重新执行三条 reverse 命令。

## 14. 2026-07-24 Android 原生 App 构建与三星真机验收

- `console/src-tauri/gen/android` 已成功生成；为适配 Tauri Android Gradle
  任务，在 `console/package.json` 补充了 `"tauri": "tauri"` 脚本，原有脚本
  和功能未删除。
- arm64 Debug APK 已成功构建、复制到 `tmp/apk/`，并通过 ADB 安装到
  Samsung SM-A5360；安装结果为 `Success`，启动 Activity 为
  `io.lensgo.macao.mobile/.MainActivity`。
- 这是独立原生 App 容器，不是 Chrome 页面；验收期间窗口焦点持续属于
  `io.lensgo.macao.mobile`。App 内复用了统一 React 可视化界面，以保证桌面、
  Web 与 Android 功能一致。
- 原生 App 的五个入口已逐一真机切换并截图：LensGo、对话、旅程、相册、设置。
  对话页可读取已有姿势会话；旅程页在无数据时正常显示空状态；设置页可看到
  阿里 Token Plan 自定义 Provider；相册页因 AI Drive 未配置显示既有降级状态。
- 通过 USB reverse 使用 `127.0.0.1` 配置后，原生 LensGo 控制中心真机显示：
  Bridge 在线、实时事件流已连接、发现设备 1、最近事件 1、QwenPaw 可达、
  Telegram 已配置、实时同步中。
- 验收截图均在 `tmp/screenshots/`，其中
  `lensgo-native-bridge-configured.png` 是关键全链路在线证据；其余
  `lensgo-native-*-final.png` 是五个原生模块页面证据。
- 当前 APK 是调试包、只包含 `arm64-v8a`，尚未签名为商店发行版。Bridge
  Token 按既有安全设计保存在 `sessionStorage`，App 被完整结束后需要重新输入；
  URL 会保存在 `localStorage`。
- 已知非阻断问题：三星状态栏与页面顶部标题存在少量重叠；移动端仍会尝试调用
  桌面托盘标签/更新检查，Tauri 只记录“不允许”警告，不影响五栏页面、Bridge、
  WebSocket 或 QwenPaw 功能。后续应做移动安全区与平台调用隔离。
- 仍需用户参与的唯一核心物理验收，是实际对眼镜说出姿势请求并观察同一轮结果
  是否同时到达眼镜、LensGo 控制中心与 Telegram。

## 15. 2026-07-24 首次眼镜语音端到端实测

- 用户已在真实眼镜上执行口述测试。小舟 App 日志确认麦克风 LC3 音频持续到达，
  语音识别调用启动与结束，证明眼镜、蓝牙/手机音频链正常。
- 同一轮眼镜拍照按键上传了 85,136 bytes JPEG。LensGo 在 `00:54:16` 收到
  `askType=2` 图片事件，发布 `image`、`agent.route`、`agent.collaboration`，
  Agent 回复随后经小舟 App TTS 播放。
- Android 原生 App 实时事件数从 1 增至 13，并显示眼镜上传的最新照片；截图为
  `tmp/screenshots/lensgo-after-voice-test.png`。这验证了眼镜 → LensGo → Agent
  → 眼镜 TTS 与 LensGo → Android App 实时同步链路。
- 本轮未进入姿势生图。Android 日志给出确定原因：阿里云 NLS 请求返回
  `HTTP 403 Forbidden`、错误码 `144003`，所以没有产生 `askType=1` 文字事件。
- 只读检查小舟 App 的“阿里云语音配置”确认三个字段当前实际值仍是同名占位文字：
  AppKey、AccessKeyId、AccessKeySecret。它们必须替换为真实的阿里云智能语音
  交互项目 AppKey 和 RAM AccessKey 凭证；Token Plan 的大模型 `sk-...` Key
  不能替代 NLS 凭证。
- 凭证补齐后重新口述同一句测试语，预期事件序列应为：`upstream text` →
  `agent.route` → Pose Coach / `generate_pose_reference` → downstream image →
  Android App 最新姿势图 + Telegram `sendPhoto`。
