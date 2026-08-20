# LensGo Macao：要求 1、2

## 一键启动全部服务

```bash
cd /home/lkzhang/qwen_comp
cp .env.bridge.example .env.bridge
nano .env.bridge
chmod +x run_all.sh
./run_all.sh
```

脚本会依次启动或复用 QwenPaw，然后启动官方眼镜服务端；数据 Bridge 与 Telegram Bridge 会随眼镜服务端一起启动。按 `Ctrl+C` 可关闭由脚本启动的进程。

## 1. QwenPaw Agent

项目使用隔离环境 `.venv`，QwenPaw 的数据放在项目内 `.qwenpaw/`。启动后：

```bash
cd /home/lkzhang/qwen_comp
./run_qwenpaw.sh
```

控制台：`http://127.0.0.1:18088/`。本机 `8088` 已被其他进程占用，因此项目默认改用 `18088`。已实测比赛 Key 对应的 **Aliyun Token Plan (International)**，默认模型为 `qwen3.6-plus`。Key 保存在被 Git 忽略的 QwenPaw secret 目录，不会写进源码。

Agent API 测试：

```bash
curl -N -X POST http://127.0.0.1:18088/api/console/chat \
  -H 'Content-Type: application/json' \
  -d '{"input":[{"role":"user","content":[{"type":"text","text":"请回复：LensGo API 测试成功"}]}],"session_id":"lensgo-test"}'
```

## 2. 智能眼镜网关

```bash
cd /home/lkzhang/qwen_comp
./run_gateway.sh
```

接口：

- API 文档：`http://<服务器IP>:8000/docs`
- HTTP 上传：`POST http://<服务器IP>:8000/api/v1/glasses/upload`
- WebSocket：`ws://<服务器IP>:8000/ws/v1/glasses/<device_id>`
- 健康检查：`GET http://<服务器IP>:8000/health`

当前服务器检测到的局域网地址为 `10.119.67.77`，因此同一网络内可先尝试：

- HTTP：`http://10.119.67.77:8000/api/v1/glasses/upload`
- WebSocket：`ws://10.119.67.77:8000/ws/v1/glasses/<device_id>`
- API 文档：`http://10.119.67.77:8000/docs`

上传示例：

```bash
curl -X POST http://127.0.0.1:8000/api/v1/glasses/upload \
  -F 'device_id=glasses-001' \
  -F 'latitude=22.1932' -F 'longitude=113.5380' \
  -F 'language=zh-Hant' -F 'image=@photo.jpg'
```

WebSocket 协议：连接后先发 JSON 元数据，再发送一条二进制图片帧：

```json
{"type":"frame.metadata","content_type":"image/jpeg","language":"zh-Hant","location":{"latitude":22.1932,"longitude":113.5380}}
```

服务回复 `frame.ready` 后发送 JPEG 二进制；保存成功回复 `frame.accepted` 和 `upload_id`。支持 JPEG、PNG、WebP，默认上限 10 MB。

> `0.0.0.0` 是监听地址，不是客户端链接。眼镜与服务器在同一局域网时，客户端应使用服务器实际局域网 IP；若要公网访问，还需域名、TLS（`https/wss`）及路由器或云安全组配置。
