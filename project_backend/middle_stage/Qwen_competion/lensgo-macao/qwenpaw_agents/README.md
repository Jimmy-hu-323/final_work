# LensGo QwenPaw Agents（公开配置）

这里保存可安全提交的 Agent 定义。运行时 `agent.json`、Token、模型密钥、聊天历史和私有记忆不进入仓库。

```bash
export QWENPAW_WORKING_DIR=/path/to/.qwenpaw
qwenpaw agents create --name "LensGo Travel Director" --agent-id lensgo-travel-director --description "澳门旅行陪伴、用户意图与幸福时刻编排主 Agent" --language zh --template default --provider-id aliyun-tokenplan-intl --model-id qwen3.7-plus --skill multi_agent_collaboration
qwenpaw agents create --name "LensGo Vision Curator" --agent-id lensgo-vision-curator --description "旅行图片视频理解、拍照建议与重要时刻视觉判断" --language zh --template default --provider-id aliyun-tokenplan-intl --model-id qwen3.7-plus
qwenpaw agents create --name "LensGo Memory Keeper" --agent-id lensgo-memory-keeper --description "用户身份、旅程、幸福时刻和共享记忆整理专家" --language zh --template default --provider-id aliyun-tokenplan-intl --model-id qwen3.7-plus
qwenpaw agents create --name "LensGo Media Archivist" --agent-id lensgo-media-archivist --description "图片视频去重、生命周期、隐私和归档策略专家" --language zh --template default --provider-id aliyun-tokenplan-intl --model-id qwen3.7-plus
qwenpaw agents create --name "LensGo Pose Coach" --agent-id lensgo-pose-coach --description "旅行拍照姿势设计、动作分解与参考图提示词专家" --language zh --template default --provider-id aliyun-tokenplan-intl --model-id qwen3.7-plus
```

创建后，把对应子目录的 `AGENTS.md`、`SOUL.md` 放入各 Agent workspace。主 Agent 需要 `multi_agent_collaboration` Skill。

共享记忆当前由 `glasses/server/lensgo_memory.py` 注入统一 `LensGoContext`。它是 SQLite Router 适配层，不是独立 MCP Server；未来可保持数据模型不变并封装成 MCP。
