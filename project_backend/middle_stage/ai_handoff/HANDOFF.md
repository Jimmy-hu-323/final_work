# LensGo / QwenPaw 服务器交接文档

写给下一个接手的 AI。最后更新：2026-08-07 12:50（Asia/Shanghai）。

本文只记录**在这台服务器上工作时你必须先知道的事**，尤其是那些不看文档一定会踩的坑。
不含任何密码、Token、地图 Key —— 需要凭证时向用户索取。

---

## 0. 先读这一节：三条会让你浪费一小时的陷阱

1. **`systemctl` 在这台机器上是坏的，root 也不行。** 见 §3。所有服务现在靠**用户级 transient unit** 托管。
2. **`hotel_book` 的 SSR 仍会让 workerd 段错误，但首页已经改为静态入口绕开 SSR。** 不要删除 `scripts/build-static-entry.mjs`，构建后必须运行它。见 §6.1。
3. **`node_modules` 是从 Windows 拷过来的**，平台二进制缺失、大小写冲突。构建失败先怀疑这个。见 §7.1。

---

## 1. 接入方式

- SSH：`47.82.123.50` 端口 **50221**（不是 22；22 是另一台机器）
- 用户：`jimmyhu`，有 sudo（需要密码，向用户索取）
- 主机名 `E11-3040-A5000`，这台机器在 **frp 客户端之后**，公网 IP 属于另一台跑 frps 的机器

非交互登录时注意：`node` / `npm` / `npx` **不在默认 PATH**，要加
`export PATH=/home/jimmyhu/.local/bin:$PATH`。
`node_modules/.bin/*` 没有执行权限，用 `node ./node_modules/<pkg>/<entry>.js` 直接调。

---

## 2. 服务拓扑

| 服务 | 本地端口 | 代码位置 | 作用 |
|---|---|---|---|
| QwenPaw 主后端 | 18088 | `middle_stage/Qwen_competion/qwen_compitition/` | Agent 编排、travel-planner API、Web 控制台 |
| hotel_book | 18110 | `middle_stage/hotel_book/` | 酒店库存、账单、行程费用（Next.js on Cloudflare Workers + D1）|
| data_publish | 18099 | `middle_stage/data_publish/` | 人流密度数据，有自己的网页 |
| glasses / Bridge | 18765 + 18000 | `Qwen_competion/lensgo-macao/ai_glasses_debug/` | 眼镜 WebSocket + Bridge HTTP |
| Caddy 网关 | 18866 | `/etc/caddy/Caddyfile` | 对外 HTTPS 入口 |
| AI Drive | 8000 | `~/Desktop/ai-drive/` | **没有运行**，见 §6.2 |

### 公网入口（经 frp）

```
http://47.82.123.50:18088/          QwenPaw 控制台 + API（明文）
http://47.82.123.50:18001/          data_publish 网页（明文，经 frp）
http://47.82.123.50:18002/          hotel_book 网页 + API（明文，经 frp）
ws://47.82.123.50:18765/chat        眼镜对话 WebSocket
http://47.82.123.50:18000/api/...   眼镜 Bridge（明文）
https://lensgo.duckdns.org:18866/   Caddy 网关（TLS，证书签给这个域名，用 IP 访问会不匹配）
```

Caddy 在 18866 上的路由（**按顺序**）：

```
/api/bridge*, /api/chat/resources/*  → 127.0.0.1:18000   眼镜 Bridge
/api/mobile/hotel/*  + 特定 Bearer   → 127.0.0.1:18110   重写 /api/mobile/hotel → /api/v1
/api/mobile/hotel/*  无 Bearer       → 401
/crowd, /crowd/*                     → 127.0.0.1:18099   剥掉 /crowd 前缀，只允许 GET
其余全部                              → 127.0.0.1:18088   QwenPaw
```

**注意：`/api/bridge*` 这两条是通过 Caddy admin API 热加载的，没有写进磁盘上的 Caddyfile。Caddy 一重启就消失，手机端的眼镜对话会立刻失效。** 固化方法见 §6.4。

---

## 3. systemd 坏了 —— 最重要的运维约束

**症状**：任何 `systemctl` 操作系统级 unit 都会超时，root 也一样：

```
Failed to activate service 'org.freedesktop.systemd1': timed out (service_start_timeout=25000ms)
```

**已排查结论**：D-Bus 本身是好的（`dbus-send` 能正常拿到回复，socket 存在）。挂掉的是 **PID 1 自己的 IPC 通道**——`org.freedesktop.systemd1` 不在总线上应答。但 PID 1 的**进程监管仍然正常**（`Restart=` 策略会生效，kill 掉的服务会被拉起）。

**后果**：系统级 unit（`lensgo-qwenpaw.service` / `lensgo-bridge.service` / `lensgo-hotel.service` / `frpc.service`）无法用 systemctl 启停。目前前三个都处于 failed/inactive，服务改由**用户级 transient unit** 托管：

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user list-units 'lensgo*'
#   lensgo-qwenpaw-recovery.service    → ~/run-qwenpaw-recovery.sh
#   lensgo-bridge-recovery.service     → ~/run-lensgo-bridge-recovery.sh
#   lensgo-hotel-recovery.service      → ~/run-lensgo-hotel-recovery.sh
```

用户级的 `systemctl --user restart/status` **是好用的**，重启项目服务都走这个。

⚠️ **这些 unit 是 `--collect` 的 transient unit：`systemctl --user stop` 会把 unit 定义一起回收掉，之后 `start` 会报 "Unit not found"。** 要重新创建：

```bash
systemd-run --user --unit=lensgo-hotel-recovery --collect \
  --property=Restart=on-failure --property=RestartSec=5 \
  /home/jimmyhu/run-lensgo-hotel-recovery.sh
```

所以**只用 `restart`，不要用 `stop`**。

⚠️ **机器一旦重启，这三个服务都不会自动回来**（transient unit 不持久化，系统级 unit 又是 failed）。这是当前最大的隐患。

**根治方案**（未执行，需用户拍板）：对系统 systemd 发 `SIGTERM` 让它 re-exec（等价于 `daemon-reexec`）：

```bash
sudo kill -TERM 1
```

`man systemd` 明确写了系统实例收到 SIGTERM 会序列化状态→重新执行→反序列化。包管理器升级时常做这个操作。**但这是 PID 1**，如果序列化失败整台机器失联，而这台机器在 frp 隧道后面、没有带外访问手段。用户尚未批准。

---

## 4. frpc 的坑

**改了 `/opt/frp/frpc.ini` 必须重启 frpc 才生效**，否则新端口注册不上。

2026-08-07 12:48 已通过 `~/restart-frpc.sh` 重载。最终映射：

```ini
[lensgo-official-http2]  # 现用于 data_publish
local_port = 18099
remote_port = 18001

[lensgo-official-http3]  # 现用于 hotel_book
local_port = 18110
remote_port = 18002
```

frpc 日志已明确显示这两个代理都是 `start proxy success`。只重新利用了原本没有本地监听服务的 18001、18002 预留映射；18000、18003–18006 没有改动。判断配置是否已加载：

```bash
ps -eo pid,lstart,cmd | grep '[f]rpc'     # 进程启动时间
stat -c %y /opt/frp/frpc.ini              # 配置修改时间
```

配置时间晚于进程时间 = 有隧道没生效。重启脚本在 `~/restart-frpc.sh`（detach 执行 + 兜底自启，避免 SSH 被锁死）。

⚠️ 不要再使用 18111、18112。它们曾经能在 frps 日志中显示 `start proxy success`，但公网入口层没有真正转发，浏览器收到 `Empty reply from server`。18001、18002 已从外部 HTTP 实测返回 200。

---

## 5. 本轮（2026-08-06）做了什么

### 5.1 hotel_book：真实数据 + 行程费用账本

- `lib/hotel-store.ts`：3 家虚构酒店 → **10 家真实澳门酒店**（真实名称/地址/星级/坐标，2 晚 ¥1530–¥4850）。加了 `latitude`/`longitude` 列 + `migrateSchema()` 迁移（`CREATE TABLE IF NOT EXISTS` 不会给已有表加列，必须 ALTER）。用 `schema_meta` 表的 `hotel_catalogue` 版本号控制重新播种。
- `lib/trip-expenses.ts`（**新**）：`trip_expenses` 表（类别 / 地点名 / 经纬度 / 第几天 / 单价 / 数量 / 必需标记）+ `attractions` 表（**23 个真实澳门景点，12 个收费**，用公布票价 MOP×0.91 折成 CNY）。
- 新路由：`/api/v1/attractions`、`/api/v1/trip-expenses`、`/api/v1/trip-expenses/[id]`（GET/POST/PATCH/DELETE）。

金额单位统一是**分**（`287600` = ¥2876.00）。

### 5.2 QwenPaw 代理

`src/qwenpaw/app/routers/travel_planner.py` 新增 6 条：
`GET /attractions`、`GET /hotels`、`GET|POST /trip-expenses`、`PATCH|DELETE /trip-expenses/{id}`。

### 5.3 Agent

- 新增 MCP `scripts/mcp/lensgo_booking_server.py`，4 个工具：`search_macau_hotels` / `list_macau_attractions` / `save_trip_expenses` / `list_trip_expenses`。
- driver 配置 `workspace/qwenpaw/workspaces/lensgo-travel-director/drivers/mcp/lensgo-booking.yaml`。
  **注意 driver 必须写 `policy` 段逐个 allow 工具名，否则会 `driver_policy_denied`。** 照抄 `amap-macau.yaml` 的格式。
- `AGENTS.md` 加了「行程规划：住宿与花费」章节：先问预算和人数、用真实报价选酒店、按真实票价算门票、**trip_id 必须复用手机旅程的 id**、写入账单、报总价前先读回来、超预算要直说。

已实测：给它「3天2晚2人预算6000」，它能调真实酒店做预算测算并写入 8 项费用（含免费景点如实记 ¥0）。**但它很慢且会重复调用**（一次规划 22 次搜酒店、12 次查景点，会触发框架的 doom-loop 保护），提示词值得进一步收敛。

### 5.4 手机端（本地仓库 `Z:\...\qwen_compitition\console\`）

- **眼镜对话接入**：新增 `src/mobile-local/glassesBridge.ts`（事件折叠，9 个单测全过）+ Rust 命令 `mobile_glasses_bridge_events`。「对话」页历史抽屉顶部多了只读的「眼镜实时对话」，4 秒轮询。
- **行程花费页**：账单页新增「花费」栏，按天分组、每项显示地点/类别/数量、可改金额数量、可删除，带**行程选择器**（`LocalTrip.id` == agent 的 `trip_id`）。
- 新增 Rust 命令 `mobile_trip_expenses` / `mobile_create_trip_expense` / `mobile_update_trip_expense` / `mobile_delete_trip_expense`，同步登记 `lib.rs` 和 `permissions/mobile-runtime.toml`。

### 5.5 QwenPaw Web 控制台

服务器上的项目实例原本**没有构建过前端**（只有 `dist-mobile`）。已构建 `console/dist`，现在 `http://47.82.123.50:18088/` 是完整控制台。构建过程踩的坑见 §7.1。

### 5.6 2026-08-07：hotel_book 静态首页 + 两个公网 HTTP 入口

- `hotel_book/scripts/build-static-entry.mjs`（新）：读取 vinext 的客户端 manifest，生成 `dist/client/index.html` 和 `dist/client/hotel-static-entry.js`，直接挂载现有 `HotelApp`，使根路径由 Cloudflare 静态资源层处理，不进入 SSR。
- `hotel_book/package.json`：`build` 改为先执行 vinext build，再执行静态入口生成脚本。
- 已验证 `http://127.0.0.1:18110/` 返回 `200 text/html`，`/api/v1/state` 返回 200，访问首页后服务仍是 active。
- 重启时发现磁盘上的 Wrangler 4.92.0 `wrangler-dist/cli.js` 原本已有非法字节；已从 `~/wrangler-4.92.0-backup.tgz` 恢复，损坏副本保留为 `node_modules/wrangler/wrangler-dist/cli.js.corrupt-20260806`。
- `/opt/frp/frpc.ini` 将原本空闲的预留映射 18001、18002 分别指向 data_publish 与 hotel_book；公网首页和 hotel_book API 均已实测返回 200。此前尝试的 18111、18112 已从配置删除。

### 5.7 2026-08-07：data_publish 地图点选只显示最近 5 个命名地点

- 修改文件：`data_publish/web/app.js`。
- 地图点选后，不再直接展示高德返回的整组附近坐标；现在根据各 POI 的 `center=[lng,lat]` 用 Haversine 距离计算、由近到远排序，只保留最近 5 个带名称和有效坐标的地点。
- 列表显示：序号、景点/店铺/地点名称、距离（米/公里）、类别、地址；点击「选择」仍可进入原有发布流程。
- 增加本地数据库兜底：优先从当前城市的已登记 `poi` 中计算最近 5 个，不足 5 个才补街道/区。高德接口不可用时也能正常显示结果。
- 2026-08-07 用户已提供新的高德 Web 服务 Key，已只写入服务器 `data_publish/.env`，本文档与前端均未记录 Key。仅重启 data_publish 后，本机与公网 `/api/amap/regeo` 均实测成功，返回 12 个附近 POI；前端的本地已登记地点兜底仍保留。
- 公网 `http://47.82.123.50:18001/` 已用真实浏览器点击验证：澳门默认地图点选只显示 5 条，示例为“新葡京、澳门旅游塔、澳门科学馆、市政署大楼、议事亭前地”，距离从 687 米递增到约 1.2 公里。
- 这是直接读取的静态 JS，修改后不需要重启 Python 服务；原文件备份：`data_publish/web/app.js.bak-20260807-nearest5`。

### 5.8 2026-08-07：data_publish 地图瓦片溢出页面修复

- 用户截图中高德瓦片以大块图片形式溢出地图容器并覆盖页面。根因不是地图数据：公网静态请求偶发空响应，当 `/vendor/leaflet.css` 单独加载失败时，瓦片缺少 Leaflet 的绝对定位与裁剪规则。
- `data_publish/web/styles.css` 已加入关键布局兜底：地图强制裁剪，Leaflet pane/tile/marker/layer 强制绝对定位，并禁用瓦片图片的全局尺寸限制；同时补了地图 `width:100%`、`min-width:0`。
- `data_publish/web/index.html` 给 Leaflet CSS 与主样式增加版本查询参数，避免浏览器继续使用旧缓存。
- 无需重启 Python 服务。公网真实浏览器验证：12 张瓦片均为 absolute、尺寸不超过 260px，地图 `overflow:hidden`，页面 `scrollWidth === viewportWidth`，没有横向溢出。
- 备份：`data_publish/web/styles.css.bak-20260807-map-layout`、`data_publish/web/index.html.bak-20260807-map-layout`。

---

## 6. 已知坏掉/未完成的东西

### 6.1 hotel_book SSR 会把服务打挂 —— 已用静态首页绕开

原始问题是 SSR 请求进入 workerd 后 **SIGSEGV**，导致 wrangler 退出、整个 hotel_book 下线。底层 SSR 兼容性问题没有根治，但现在根路径已有静态 `index.html`，请求在 Cloudflare assets 层直接返回，不再进入 SSR。

已做的排查（都是死路，别重复走）：
- 不是业务代码：用 `git checkout` 还原 `lib/hotel-store.ts` 到改动前，一样崩。
- 不是 `next/font/google`：去掉字体，一样崩。
- 不是 `HotelApp` 组件：把 `page.tsx` 换成 `<div>ok</div>`，一样崩。
- 不是 layout 的 `headers()`/metadata：换成极简 `<html><body>{children}</body></html>`，**一样崩**。

结论：**任何 SSR 渲染都会崩**，是 vinext + workerd 1.20260515.1 这套运行时在这台机器上的原生问题。

- 试过升级 wrangler 4.92.0 → 4.119.0：**服务直接起不来**，报 `The "legacy_env" field is no longer supported`。那个字段是 **vinext 生成**在 `dist/server/wrangler.json` 里的，所以升 wrangler 必须同时升/适配 vinext。已完整回滚，备份在 `~/wrangler-4.92.0-backup.tgz`（80MB）。

**当前方案**：保留 vinext 构建出的客户端 React 模块，用 `scripts/build-static-entry.mjs` 生成浏览器启动页。根路径和 API 都已实测 200，访问根路径后服务不会崩。

⚠️ 以后重建 hotel_book 必须用 `npm run build`，或者在直接执行 vinext build 后补跑 `node scripts/build-static-entry.mjs`。单独运行 vinext build 会清空静态入口，使根路径重新落到 SSR，再次触发崩溃。

长期根治方向仍是升级 vinext 到能生成新版 wrangler 配置的版本，再升 wrangler/workerd；属于依赖升级工程，不要在演示前动。

### 6.2 AI Drive 没有运行 —— 相册在靠回退

`AI_DRIVE_BASE_URL=http://127.0.0.1:8000`，服务没起。它需要 4 个 docker 容器（postgres/redis/minio/qdrant）+ 一个 uvicorn，见 `~/Desktop/ai-drive/START_WEB.md`。

相册接口 `/api/travel-planner/album/photos` 的设计是**两层**：AI Drive 是正规存储，返回 502/503 时回退到本地 `workspace/qwenpaw/lensgo-cloud-album`。

⚠️ **直接启动 AI Drive 会让相册变空**：空库返回 200 空列表，而回退逻辑只兜 502/503，不兜 200。要起它必须先迁移现有照片。

⚠️ **8000 端口是 AI Drive 保留的，不要占用。** 本轮曾把眼镜 Bridge 放到 8000，导致相册请求打到 Bridge 上收到硬 404、相册页直接挂掉。已挪到 18000。

### 6.3 眼镜照片进不了相册 —— 缺功能

眼镜照片存在 `workspace/runtime/lensgo-media/<userId>/`，而相册读的是 AI Drive / `lensgo-cloud-album`，**两个存储互不相通，没有任何代码把它们连起来**。眼镜的 `console_upload_bytes` 上传目标是 QwenPaw 控制台文件库，是第三个存储。

修法：在 glasses server 存图后，同时 POST 到 `/api/travel-planner/album/photos`。用户已说「暂时不用改眼镜」。

### 6.4 Caddy 的眼镜路由没落盘

`/api/bridge*` 和 `/api/chat/resources/*` 两条路由是通过 admin API（`127.0.0.1:2019`）热加载的，**没写进 `/etc/caddy/Caddyfile`**。Caddy 重启即失效。

回滚/参考快照：`~/caddy-config-backup-20260806-191807.json`
恢复方法：`curl -X POST -H "Content-Type: application/json" --data @<快照> http://127.0.0.1:2019/load`
固化需要 root 改 Caddyfile（admin API 可以 reload，不需要 systemctl，这条路是通的）。

### 6.5 眼镜 TTS 会读到桥接标记

服务端下发给眼镜的 `SCChat` 正文里混着 agent 的桥接块标记（`<!-- ⟦ … -->`），TTS 会念出来或卡住。手机端已在显示时剥离（`glassesBridge.ts` 的 `stripBridgeMarkup`），**但发给眼镜的报文没改**。根治要改 `glasses/server` 的下行处理。

---

## 7. 环境坑（都真实踩过）

### 7.1 node_modules 是从 Windows 拷来的

`console/` 和 `hotel_book/` 的 `node_modules` 都带着 Windows 的痕迹（旧路径 `D:\qwen_compitition\...`）。已知问题：

- **平台原生二进制是空目录**：`@rollup/rollup-linux-x64-gnu`、`@esbuild/linux-x64` 都只有空文件夹。
  修：`npm install --no-save --no-audit --no-fund @rollup/rollup-linux-x64-gnu@<版本>`（版本要对齐 `vite/node_modules/rollup` 的版本）。
- **大小写冲突丢文件**：`@agentscope-ai/icons` 官方包里同时有
  `SparkEcommerceProductLine.js` 和 `SparkECommerceproductLine.js`，只差大小写。
  Windows 上安装时互相覆盖只剩 1360 个文件，拷到 Linux（区分大小写）后永久缺一个，构建报 `Could not resolve ./src/js/SparkEcommerceProductLine.js`。
  修：`npm pack @agentscope-ai/icons@1.0.67` 后从 tarball 里 `tar xzf` 提取缺失文件。现在是 1362 个。
- **`node_modules/.bin/*` 没有执行权限**：`vinext: Permission denied`、`tsc: Permission denied`。
  修：绕开 bin，直接 `node ./node_modules/vinext/dist/cli.js build`。
- **npm 的 postinstall 会失败**（`napi-postinstall: Permission denied`），需要 `--ignore-scripts`。

### 7.2 Windows 端：PowerShell 的 `2>&1` 会伪造失败

对原生 exe 用 `2>&1` 或 `*>&1`，PowerShell 5.1 会把 stderr 包成 ErrorRecord，**即使 exit code 是 0 也报失败**。Android 构建因此连续两次"失败"，其实 APK 正常产出。

**判断构建成败要看产物时间戳，不要看退出码。** 或者干脆别重定向。

### 7.3 Tauri 的 Android debug 包，Rust 仍按 release 编译

构建日志里是 `Finished 'release' profile`，所以 **`cfg!(debug_assertions)` 为假**。
后果：`mobile_runtime.rs` 里"公网必须 HTTPS，明文只放行 loopback/局域网或 debug 构建"的策略，在 debug APK 上**也会拒绝公网明文地址**。所以手机 App 的 Bridge 地址必须填 `https://lensgo.duckdns.org:18866`，不能填 `http://47.82.123.50:18000`（后者只能给眼镜硬件用）。

### 7.4 改了 Python 代码必须重启 QwenPaw

FastAPI 不热加载。判断方法同 §4：

```bash
stat -c %y .../routers/travel_planner.py
ps -o lstart= -p $(pgrep -f "qwenpaw app --host")
```

文件时间晚于进程时间 = 代码没生效。本轮账单的两个 404 就是这么来的。

### 7.5 SSH 传文件

base64 塞命令行会超长（`Argument list too long`）。用 `pscp`/`scp` 传文件。heredoc 经 SSH 层也容易被打乱，复杂脚本一律**本地写好再传**。

---

## 8. 常用命令

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export PATH=/home/jimmyhu/.local/bin:$PATH

# 服务状态
systemctl --user list-units 'lensgo*'
ss -ltnp | grep -E ':18088|:18110|:18099|:18765|:18000|:18866'

# 重启（只用 restart，别用 stop）
systemctl --user restart lensgo-qwenpaw-recovery.service
systemctl --user restart lensgo-hotel-recovery.service
systemctl --user restart lensgo-bridge-recovery.service

# 日志
journalctl --user -u lensgo-hotel-recovery.service -n 50 --no-pager

# 健康检查（18110 的 / 现在是安全的静态首页）
H=/home/jimmyhu/qwenpaw_competition/middle_stage/hotel_book
TOK=$(grep -m1 '^HOTEL_BOOKING_SERVICE_TOKEN=' $H/.dev.vars | cut -d= -f2- | tr -d '"')
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOK" http://127.0.0.1:18110/api/v1/state
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18088/api/agents
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18088/api/travel-planner/trip-expenses
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18110/

# 公网入口（已实测 200）
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' http://47.82.123.50:18001/
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' http://47.82.123.50:18002/
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' http://47.82.123.50:18002/api/v1/state

# hotel_book 改代码后
cd $H && npm run build && systemctl --user restart lensgo-hotel-recovery.service
```

---

## 9. 备份清单

```
~/wrangler-4.92.0-backup.tgz                              升级前的 wrangler+workerd（80MB）
~/caddy-config-backup-20260806-191807.json                Caddy 运行时配置快照
/opt/frp/frpc.ini.bak-20260807-18111-18112                新公网端口修改前的 frpc.ini
/opt/frp/frpc.ini.bak-20260807-before-18001-18002         改用已放行端口 18001/18002 前
data_publish/web/app.js.bak-20260807-nearest5             地图最近 5 个地点功能修改前
data_publish/.env.bak-20260807-before-amap-key-replacement 高德 Web 服务 Key 替换前（含敏感配置，勿外传）
data_publish/web/styles.css.bak-20260807-map-layout        地图瓦片布局兜底修改前
data_publish/web/index.html.bak-20260807-map-layout        地图样式缓存版本号修改前
hotel_book/lib/hotel-store.ts.bak-20260806-204222         改真实数据前
hotel_book/package.json.bak-20260806-static-home          静态首页构建命令修改前
hotel_book/node_modules/wrangler/wrangler-dist/cli.js.corrupt-20260806  Wrangler 损坏文件留档
Qwen_competion/.../travel_planner.py.bak-*                加代理路由前
.../lensgo-travel-director/AGENTS.md.bak-*                改提示词前
Qwen_competion/config/lensgo.integrated.toml.pre-18000-*  眼镜端口改动前
```

辅助脚本：`~/run-*-recovery.sh`（三个服务的启动脚本）、`~/restart-frpc.sh`、`~/add_bridge_route.py`（Caddy 路由热加载）。

---

## 10. 用户明确交代过的约束

- 不要重启整台服务器，只允许重启项目后端。
- 不要把服务器密码、Token、地图 Key 写进前端、日志、交接文档或 Git。
- 不要清空手机端这些 localStorage：`lensgo_mobile_chat_threads_v2`、`lensgo_mobile_active_chat_v1`、`lensgo_mobile_trips_v1`。
- 真机测试不要随意发聊天、删行程、点「清空当前会话」。
- 用户要求改某一个栏目时，严格限制改动范围，其他栏目保持不动。
- 本地 Git 工作区不干净，**不要用 `git reset --hard` / `git checkout --`** 等会覆盖现有工作的命令。

---

## 11. 建议的下一步（按优先级）

1. **修 systemd IPC**（§3）。这是所有运维问题的根，且机器重启后服务不会自动恢复。需要用户批准 `sudo kill -TERM 1`。
2. **固化 Caddy 的眼镜路由**（§6.4）。低风险，不做的话哪天 Caddy 重启眼镜功能就断。
3. **收敛 agent 的规划提示词**（§5.3）。现在一次规划几十次工具调用，慢且触发 doom-loop 保护。
4. **验证 agent 的 trip_id 关联**：在手机「对话」里完整走一次「规划行程 → 确认保存旅程 → 看账单」，确认花费挂到了对应旅程下。代码链路已通，但只做过手工指定 trip_id 的测试。
5. AI Drive（§6.2）、眼镜照片进相册（§6.3）、眼镜 TTS 标记泄漏（§6.5）—— 都是独立的功能缺口，按需求优先级排。
6. hotel_book SSR 底层根治（§6.1）—— 当前静态入口已规避，依赖升级工作量大，放最后。
