# LensGo 姿势教练与参考图

## 用户体验

用户可以通过眼镜、Telegram 或可视化面板说：

> 我在大三巴前应该摆什么姿势？给我一张参考图。

主会话会先咨询 `lensgo-pose-coach`，再由 `lensgo-travel-director` 调用 `generate_pose_reference`。文字动作指令继续走原来的眼镜文字/TTS 链路；参考图由 QwenPaw Console 显示，同时经 LensGo EventBridge 交给现有 Telegram Mirror。

生图服务未配置、超时或返回无效图片时，系统只跳过参考图，仍给出文字姿势建议，不影响旅行、视觉、记忆和媒体归档等现有功能。

## 配置

复制 `.env.integrated.example` 为 `.env.integrated`，至少填写：

```dotenv
POSE_IMAGE_PROVIDER=dashscope
POSE_IMAGE_API_KEY=你的密钥
POSE_IMAGE_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1
POSE_IMAGE_MODEL=wan2.6-t2i
```

DashScope 密钥与地址必须属于同一区域。中国内地地址为
`https://dashscope.aliyuncs.com/api/v1`；国际地址为
`https://dashscope-intl.aliyuncs.com/api/v1`。

也支持 OpenAI-compatible 图片接口：

```dotenv
POSE_IMAGE_PROVIDER=openai-compatible
POSE_IMAGE_API_KEY=你的密钥
POSE_IMAGE_BASE_URL=https://你的服务地址/v1
POSE_IMAGE_MODEL=gpt-image-1
POSE_IMAGE_SIZE=1024x1024
```

OpenRouter 使用专用的统一图片接口，而不是传统的
`/images/generations`。配置如下：

```dotenv
POSE_IMAGE_PROVIDER=openrouter
# 已在本机设置 OPENROUTER_API_KEY 时，POSE_IMAGE_API_KEY 可以留空
POSE_IMAGE_API_KEY=
POSE_IMAGE_BASE_URL=https://openrouter.ai/api/v1
POSE_IMAGE_MODEL=openai/gpt-image-1
POSE_IMAGE_SIZE=1024x1024
```

适配器会调用 `POST /api/v1/images`，并从响应的 `b64_json` 中保存
PNG/JPEG/WebP。发送参数以 OpenRouter 模型发现接口声明的能力为准，
避免把未声明支持的尺寸或格式参数强行传给模型。

`POSE_IMAGE_BASE_URL` 必须使用 HTTPS；仅本机回环地址允许 HTTP。生成结果只接受 PNG、JPEG 或 WebP，最大 20 MB。

## 独立 App

首次运行：

```powershell
Copy-Item .env.integrated.example .env.integrated
.\scripts\bootstrap.ps1 --build-console
```

之后双击项目根目录的 `启动 LensGo App.vbs`。它会：

1. 在后台启动 QwenPaw 与 LensGo；
2. 用独立桌面窗口承载现有 QwenPaw 可视化界面，不打开系统浏览器；
3. 将日志写入 `workspace/logs/qwenpaw-app.log` 和 `workspace/logs/lensgo-app.log`；
4. 关闭 App 窗口时，只停止本次 App 启动的两个子进程。

命令行等价入口：

```powershell
.\.venv\Scripts\python.exe .\scripts\integrated.py app
```

## 投递条件

- 可视化面板：QwenPaw 的 `send_file_to_user` 会在同一聊天中显示参考图。
- Telegram：需要原项目现有的 Telegram Bridge 已启用并配置 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID`。
- 眼镜：仍接收简短文字/TTS 动作口令；当前眼镜协议不强制直接显示图片，图片在 App 与 Telegram 查看。
