# LensGo 统一 App 与三星 Android 部署

## 产品边界

统一 App 使用 QwenPaw 现有 React Console，并新增 LensGo 控制中心。它不是只嵌入 QwenPaw 页面：LensGo 眼镜、Bridge、媒体和 Telegram 的真实状态与事件会直接显示在同一界面。

Android 采用远程客户端架构：

```text
三星 Android App（Tauri WebView）
          │ HTTPS / WSS + Token
          ▼
电脑或云服务器
  ├─ QwenPaw :18088
  ├─ LensGo Bridge :18866
  └─ 眼镜 WebSocket :18765
```

手机不运行 Python、QwenPaw 或模型进程，因此不会受 Android Python 兼容性、内存和后台进程限制。

## 统一界面

- `LensGo`：服务状态、实时事件、设备数、Telegram、最新画面和姿势参考图。
- `对话`：QwenPaw 主会话、Pose Coach 与生成图片。
- `旅程`：旅行规划。
- `相册`：旅行媒体。
- `设置`：模型与 Provider。

手机宽度下，桌面侧栏自动替换为底部五栏导航；平板和电脑仍使用原侧栏。

## 首次连接

Android 首次启动会显示服务器连接页：

1. QwenPaw 地址：`http://局域网IP:18088` 或公网 HTTPS 域名。
2. LensGo 地址：`http://局域网IP:18866` 或公网 HTTPS 域名。
3. Bridge Token：必须与服务器 `GLASSES_BRIDGE_TOKEN` 一致。

QwenPaw 地址保存在 App 本地设置中。Bridge Token 只写入 `sessionStorage`，关闭 App 后清除。

## 局域网调试

`.env.integrated`：

```dotenv
QWENPAW_HOST=0.0.0.0
QWENPAW_CORS_ORIGINS=http://tauri.localhost,https://tauri.localhost,tauri://localhost
LENSGO_CORS_ORIGINS=*
GLASSES_BRIDGE_TOKEN=一段足够长的随机值
```

必须同时：

- 在 QwenPaw 设置里开启登录鉴权；
- 仅在 Windows“专用网络”防火墙允许 18088、18765、18866；
- 手机与电脑连接同一个可信 Wi-Fi；
- 使用电脑真实局域网 IP，不能使用 `127.0.0.1`。

Android 9 及以上默认限制发行包的明文 HTTP。正式包应使用 HTTPS/WSS；仅做局域网 Debug APK 时，可在 `tauri android init` 生成的 Debug Manifest 中临时允许 cleartext traffic，但不要把这一设置带入公开发行包。

## 公网生产部署

不要把未加密的 18088/18866 直接暴露到公网。建议使用 Caddy/Nginx：

- 为 QwenPaw 和 LensGo 分配 HTTPS 域名；
- 将 WebSocket 升级转发为 WSS；
- 启用 QwenPaw 登录；
- Bridge 始终要求 Bearer Token；
- 限制上传大小、请求速率与来源；
- API Key、Bot Token 只留在服务器。

## 构建 APK/AAB

依赖：Android Studio、Android SDK、JDK 17、Rust stable，以及 Tauri Android 所需 Rust targets。

```powershell
cd C:\Users\zhang\Desktop\Project\Qwen_competion
.\scripts\build_android.ps1 -Initialize -DebugBuild
```

初始化只需一次。正式签名构建：

```powershell
.\scripts\build_android.ps1 -Aab
```

相关文件：

```text
qwen_compitition/console/src-tauri/tauri.android.conf.json
qwen_compitition/console/src-tauri/capabilities/mobile.json
qwen_compitition/console/dist-mobile/
```

Android 配置不会加载桌面 Python sidecar；原桌面 Tauri 与 Windows 兼容启动器仍保留。
