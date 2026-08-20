# AI 眼鏡 QwenPaw 聯調（Python）

> 完整說明請以 [README.md](README.md) 為準（簡體）。

本倉庫由大賽承辦單位 **博維智慧科技有限公司** 提供。

## 角色（簡表）

| 角色 | 說明 |
|------|------|
| **glasses-server** | 聯調服務端，參賽者部署；連 QwenPaw |
| **開發版 APP** | **協議客戶端**，連 `glasses-server`（博維智慧提供） |
| **AI 眼鏡** | 硬體外設；APP 播放/採集時使用，**不直連**服務端 |
| **glasses-client** | 命令行協議模擬工具，模擬 APP，非正式客戶端 |

## 快速開始

```bash
pip install -e .
# 編輯根目錄 config.toml 的 [qwenpaw].base_url 與 [qwenpaw].agent_id
glasses-server
```

修改配置後：**保存 `config.toml` → 重啟 `glasses-server`**。

再用**開發版 APP** 按接入與聯調指南配置 WS/HTTP；**AI 眼鏡**按文檔與 APP 配對。
