# 统一运行工作区

此目录只存放运行期数据，不替代任何源码模块。

- `qwenpaw/`：统一 QwenPaw 配置、Agent 工作区、Skill、Driver、会话与媒体。
- `runtime/lensgo-media/`：眼镜上传的图片/视频。
- `runtime/data/lensgo_memory.db`：LensGo 旅行记忆数据库（由原逻辑自动创建）。
- `logs/`：统一启动器日志目录。

除本说明外，运行期内容均已由外层 `.gitignore` 排除。备份项目时，请按业务隐私要求单独备份或加密本目录。
