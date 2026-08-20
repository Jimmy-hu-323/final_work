# LensGo × QwenPaw 真实外部 API 联调结果

日期：2026-07-23

## OpenRouter 图片生成

结果：**通过**。

- 本机 `OPENROUTER_API_KEY` 已被检测并使用，密钥没有复制或输出；
- OpenRouter 图片模型发现接口返回 `openai/gpt-image-1` 可用；
- 项目已新增 `POSE_IMAGE_PROVIDER=openrouter`；
- OpenRouter 使用 `POST https://openrouter.ai/api/v1/images`，与传统 OpenAI-compatible `/images/generations` 分开处理；
- OpenRouter 专用适配单元测试：5 passed；
- 真实请求成功返回 Base64 PNG；
- 图片通过 PNG 类型、非空内容和 20 MB 上限校验；
- 文件已落入 QwenPaw 统一工作区。

测试图片：`OpenRouter_GPT_Image_Pose_Test.png`

![OpenRouter gpt-image-1 姿势参考图](OpenRouter_GPT_Image_Pose_Test.png)

当前项目配置：

```dotenv
POSE_IMAGE_PROVIDER=openrouter
POSE_IMAGE_BASE_URL=https://openrouter.ai/api/v1
POSE_IMAGE_MODEL=openai/gpt-image-1
POSE_IMAGE_SIZE=1024x1024
```

`POSE_IMAGE_API_KEY` 保持为空，运行时读取本机 `OPENROUTER_API_KEY`。

官方接口说明：[OpenRouter Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

## Telegram

结果：**通过**。

- `TELEGRAM_BOT_TOKEN` 真实 `getMe` 鉴权成功；
- 用户发送 `/start` 后，`getUpdates` 成功识别真实用户会话；
- `sendMessage` 真实文字投递成功；
- `sendPhoto` 成功投递 OpenRouter 生成的姿势参考图；
- 正确 Chat ID 已同步回配置表、主通道和状态通道的本地环境配置；
- Token 与 Chat ID 均未写入报告或提交 Git。

## 大语言模型

结果：**通过**。

- QwenPaw 内置阿里 Provider 与模型列表已读取；
- 用户确认该 Key 属于新版阿里云 Token Plan 国际版，需使用自定义 Provider；
- 采用 OpenAI 兼容 Base URL：
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`；
- `/models` 真实请求返回 HTTP 200，并确认存在 `qwen3.7-plus`；
- `qwen3.7-plus` 的 `/chat/completions` 真实请求返回 HTTP 200；
- 已选用自定义 Provider `aliyun-tokenplan-intl-custom`；
- 全局活动模型和 5 个 LensGo Agent 均指向
  `aliyun-tokenplan-intl-custom/qwen3.7-plus`。

先前标准 DashScope 与 Coding Plan 地址的 401 是 Provider 类型和端点不匹配，
不是当前 Token 失效。Anthropic 兼容端点暂未启用，因为 QwenPaw 现有 Agent
链路使用 OpenAI 兼容接口即可直接接入。

## 已写入配置

以下内容已经安全写入 `.env.integrated`，但没有在报告中显示密钥：

- 自动生成的 `GLASSES_BRIDGE_TOKEN`；
- Telegram 主通道和状态通道字段；
- OpenRouter Pose 图片配置；
- Android/Tauri CORS；
- 局域网 `QWENPAW_HOST=0.0.0.0`。

## 当前外部核心链路状态

- 阿里 Token Plan 国际版大模型：通过；
- OpenRouter 姿势图片生成：通过；
- Telegram 鉴权、文字和图片投递：通过。

下一阶段可启动统一服务，执行完整的“App/眼镜提问 → Agent 分析姿势 → 生图
→ App 面板 + Telegram”全链路验收。
