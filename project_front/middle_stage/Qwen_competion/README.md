# Qwen_competion 前端

这里保存 LensGo/QwenPaw 的可维护前端副本，目录结构尽量保持原项目相对路径：

```text
Qwen_competion/
├─ qwen_compitition/
│  ├─ console/                    React + Vite + Tauri 前端
│  └─ scripts/pack-tauri/         console 构建引用的辅助脚本
├─ scripts/                       Android 构建与 Android Studio 启动脚本
└─ docs/                          手机端与统一 App 说明
```

## 主要入口

- Web 控制台：`qwen_compitition/console/src/main.tsx`
- LensGo 手机本地版：`qwen_compitition/console/src/mobile-local/`
- Tauri/Rust：`qwen_compitition/console/src-tauri/src/`
- Android 产品源码：`qwen_compitition/console/src-tauri/gen/android/`

## 常用命令

在 `qwen_compitition/console` 中执行：

```powershell
npm ci
npm run build
npm run build:mobile
npm run test:run
```

Android 构建需要 Rust、Tauri CLI、Android SDK/JDK，并依赖项目根下的 `scripts/build_android.ps1`。

## 后端依赖

手机本地版只负责显示和本地存储，推理、账单与人流数据仍由后端提供。USB 调试通常映射：

```text
18088  QwenPaw
18099  data_publish
18110  hotel_book（通常经 QwenPaw 代理）
18765  LensGo WebSocket
18000  LensGo HTTP/Bridge
```

本副本未包含依赖目录、构建产物、签名文件、SDK 本机路径或任何密钥。

