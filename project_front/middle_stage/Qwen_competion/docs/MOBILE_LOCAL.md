# LensGo 手机本地版（v0.0.0）

## 产品边界

Android App 的核心功能不再依赖电脑或云端 QwenPaw 服务。手机仅需联网访问用户在“设置”中配置的模型 API：

```text
LensGo Android App
  ├─ Rust 本地运行时
  │   ├─ Provider 配置与 API Key（Android 应用私有目录）
  │   ├─ OpenAI-compatible 文字模型请求
  │   └─ OpenAI-compatible 图片生成请求
  ├─ 本地对话与旅行记忆（应用本地存储）
  ├─ 本地行程与启用状态（应用本地存储）
  ├─ 手机定位 → 行程景点匹配 → 下一站客流提醒
  ├─ data_publish 客流 API（局域网）
  ├─ Android 通知与原生 TTS（蓝牙眼镜/手机扬声器）
  └─ 本地相册（IndexedDB / Android WebView 应用空间）
```

桌面构建仍使用原 QwenPaw/Python 后端，手机本地模式通过 `MOBILE` 构建标记隔离，不改变桌面入口。

Android 启动后会运行低优先级前台服务并显示“LensGo 本地模式”通知，用于在用户临时切换相机或其他 App 时保持本地运行时可用。Android 仍可能按系统的后台时限或省电策略停止服务；重新打开 LensGo 会自动恢复。

本地版使用独立 Android 应用 ID `io.lensgo.macao.mobile.local`，显示名称为“LensGo 澳门旅游助手（本地版）”，可与旧版 `io.lensgo.macao.mobile` 同时安装。两个版本拥有各自独立的数据和设置，卸载其中一个不会删除另一个的数据。

## 手机设置

首次启动进入“设置”，至少填写：

- API Base URL：OpenAI-compatible 地址，填写到 `/v1`；
- API Key；
- 模型名称。

可选填写图片 API 地址、图片 API Key 和图片模型。若图片地址或 Key 留空，会复用文字模型的配置。

API Key 不会回传到 React 页面，也不会显示在设置页。Rust 原生层将其写入 Android 应用私有目录，并直接发起 HTTPS 请求。卸载 App 会删除这些本地配置。

“实时客流服务”填写 `data_publish` 所在电脑的局域网地址，例如
`http://10.9.88.6:18099`。Android 模拟器也可使用 `http://10.0.2.2:18099`。
真机与电脑必须在同一可互访网络；发布器的 `CROWD_HOST` 必须是 `0.0.0.0`。
如发布器设置了 `CROWD_READ_TOKEN`，同时在此处填写读取令牌。

## 行程开启与实时提醒

生成行程只代表“保存了一份规划”，不会立即读取位置。用户必须在所选行程卡片上
点击“确认开始行程”，阅读用途说明并授权定位后，行程才进入 `active` 状态。

进行中的行程会：

1. Android 首次开始时请求系统定位权限，通过原生 GPS 持续读取坐标（网页预览回退到 Web Geolocation），并将 WGS-84 转换为发布器使用的 GCJ-02；
2. 判断用户已到达行程中的哪个景点；
3. 从 `/api/density/latest?city_id=macau&level=poi&include_empty=1` 读取下一站人数；
4. 通过 Android 通知、App 弹窗和原生 TTS 提醒；
5. 询问“按客流调整”或“不用，继续”；
6. 用户确认调整时，只重排当天尚未游览的景点，不修改已完成部分和后续日期。

客流读数超过 30 分钟会明确显示“已过期”，没有读数时显示“暂无数据”；两种情况
都不会伪装成实时人数；当天景点全部没有新鲜读数时会保留原顺序。原生 TTS 使用 Android 当前媒体输出，蓝牙眼镜连接为媒体
设备时从眼镜播报，否则从手机扬声器播放。

## 当前兼容范围

- 文字模型：`POST /chat/completions`；
- 图片模型：`POST /images/generations`，支持 `b64_json` 或 URL 响应；
- 单张生成图片最大 20 MB；
- Release 构建只接受 HTTPS；Debug 构建允许 HTTP 供本机调试。

不同供应商若不提供 OpenAI-compatible 图片接口，需要增加专用适配器。

## 本地数据

- 对话最多保留最近 200 条消息；
- 行程最多保留 30 份；
- 旅行记忆最多保留 12000 字；
- 相册图片保存在 Android WebView 的应用私有 IndexedDB。

清除 App 数据或卸载 App 会清除上述数据。正式发布前应增加用户主动导出/导入和加密备份功能。

## 构建

```powershell
.\scripts\build_android.ps1 -DebugBuild
```

Android SDK、Gradle、Android Studio 配置与临时文件、Rust/Cargo 安装与 target、
npm 构建缓存默认写入 `D:\Android_studio\LensGoCache`。用同样缓存位置打开
Android Studio：

```powershell
.\scripts\start_android_studio_d.ps1
```

项目源码仍位于 G 盘；IDE 的 config/system/plugins/log 和 Android SDK 均使用 D 盘。

Git 发布标签和项目版本为 `v0.0.0`；Android 不接受 `0.0.0` 安装包版本，因此 APK 的 `versionName` 使用最低合法值 `0.0.1`，`versionCode` 从 1 开始。

移动构建使用独立的 `tsconfig.mobile.json`，只检查手机本地入口和本地运行时；桌面 QwenPaw 模块继续由原 `tsconfig.app.json` 检查。这样手机包不会因为桌面专属插件而扩大依赖图。
