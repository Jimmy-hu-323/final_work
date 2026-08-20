# 人流密度数据发布器 v1.1

给 LensGo × QwenPaw 澳门旅行项目做的**虚拟人流数据发布工具**。用它手动发布
各城市区 / 街道 / 景点的人数，主项目的人流密度地图页再通过 HTTP API 读取
这份数据作为「真实数据源」。

接入高德后，**高德地图上能搜到的任何地点都可以直接发布人数**，不再限于内置
的景点清单。

只依赖 Python 标准库，**不需要 pip install 任何东西**（Leaflet 已随包附带）。

## 快速开始

```powershell
cd Z:\qwen_compitition\final_work\project_backend\middle_stage\data_publish
copy .env.example .env
# 在 .env 填入至少 32 字节的 CROWD_AUTH_PEPPER；高德 Key 可稍后再填
python run.py --create-admin crowd-admin --seed-only
python run.py
```

然后打开 <http://127.0.0.1:18099/> 并登录。首次启动会自动建库并写入内置
数据（4 个城市、18 个区、12 条街道、40 个景点，澳门最完整）。

部门人员使用账号登录；AI、手机和其他程序应各自签发独立、最小权限的 API
Key。完整 Key 只显示一次，服务端只保存摘要：

```powershell
python run.py --create-api-key qwenpaw --scope crowd:read
```

### 配置高德 Key（地图搜索必需）

在 `.env` 里填：

```dotenv
AMAP_WEB_KEY=你的高德Key
```

**必须是「Web服务」类型的 Key**，不是「Web端(JS API)」类型。用错类型高德会
返回 `USERKEY_PLAT_NOMATCH`（infocode 10009）——主项目 `START_LOCAL.md` 里
踩过同样的坑。

Key **只保存在服务端**，浏览器永远拿不到：前端调用本服务的 `/api/amap/*`，
由服务端代为请求高德。这与主项目 `travel_planner.py` 的做法一致。

没有 Key 时地图底图、已有数据、批量发布、撤销等功能都正常，只有「搜索地点」
和「点击地图反查地址」不可用，页面会显示明确提示。

常用参数：

```powershell
python run.py --port 18100          # 换端口
python run.py --reseed              # 清空全部数据并重建内置数据
python run.py --seed-only           # 只建库，不启动服务
python run.py --host 0.0.0.0        # 对局域网开放；生产环境必须使用 HTTPS
```

Windows 下也可以直接双击 `启动发布器.bat`。

## 页面能做什么

| 标签页 | 用途 |
|---|---|
| **地图发布** | 搜索高德地点或直接点地图 → 填人数 → 发布（主要工作流） |
| 批量发布 | 从本库已有区域里挑一批 → 填人数 → 一次性发布 |
| 当前数据 | 查看每个区域的最新读数、拥挤度色块、更新时间、过期标记 |
| 发布历史 | 按批次查看，可整批撤销 |
| 新增地点 | 补充内置数据里没有的区 / 街道 / 景点 |
| API 说明 | 接口清单与 curl 示例 |

### 地图发布怎么用

两种方式，都会在发布时自动把地点登记进本库：

1. **搜索**：输入「大三巴牌坊」「广州塔」等，走高德 POI 搜索，点结果地图就
   飞过去，然后填人数发布。
2. **点地图**：在地图上点任意位置，服务端做逆地理编码，自动带出地址和附近
   POI；可以直接选一个附近的真实地点，也可以就用这个坐标点。

已经有数据的地点会以彩色圆点显示在地图上，点圆点可以直接更新它的人数。

同一个高德 POI 重复添加不会产生重复区域（按高德 POI id 去重）；纯坐标点击
则按「同城 + 同名 + 30 米内」去重。

遇到没见过的城市（比如搜杭州西湖）会自动按高德行政区编码建一个城市记录，
不需要提前手工维护城市清单。

### 批量发布

本库已有区域的搜索支持中文名、英文名、别名和 region_id。例如搜「大三巴」
会同时命中圣安多尼堂区（别名）、大三巴街（街道）和大三巴牌坊（景点）
——正好是地图要展示的三级层次。

「随机填充」按区域层级生成量级合理的人数，用来快速造演示数据。

## 数据模型

三级层级，和地图缩放的三档对应：

| level | 含义 | 例子 |
|---|---|---|
| `district` | 区 / 堂区 | 大堂区、路氹填海区 |
| `street` | 街道 | 新马路、官也街 |
| `poi` | 景点 | 大三巴牌坊、威尼斯人 |

`parent_id` 串起层级关系（景点 → 街道 → 区）。没有著名景点的地方，最细就
到街道，这与需求一致。

### 坐标系（重要）

**库里存的一律是 GCJ-02。** 主项目 `TravelPlanner` 用的是高德栅格瓦片
（GCJ-02），坐标不一致会在地图上整体偏移 300~600 米。

从 GPS / 维基 / OSM 抄来的坐标是 WGS-84，录入时把「坐标系」选成 WGS-84
即可，服务端会自动转换（`app/geo.py`）。API 返回的 `coord_system` 字段固定
为 `gcj02`，前端不需要再做任何转换。

### 拥挤度分级

`crowd_level` 取 0~4（空旷 / 较少 / 适中 / 拥挤 / 非常拥挤），决定地图颜色；
`people_count` 是原始人数，给用户看具体数字。

发布时不填 `crowd_level` 就按人数自动推导。因为区和景点的人数量级差很多，
阈值是分层级定义的（见 `app/config.py: CROWD_THRESHOLDS`）：

| level | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| district | <1000 | 1000 | 5000 | 15000 | 30000+ |
| street | <100 | 100 | 500 | 1500 | 3000+ |
| poi | <50 | 50 | 200 | 500 | 1000+ |

这是启发式阈值，不是行业标准，随时可以在配置里改，也可以发布时手动指定。

### 批次

一次发布 = 一个 `batch_id`，要么整批写入要么整批失败，不会出现「填到一半
被地图读到」。发布错了可以整批撤销。

## API

除 `/api/health` 与登录入口外，所有业务接口都需要网页登录会话或 Bearer API
Key。角色分为 `viewer`、`publisher`、`reviewer` 和 `admin`；程序 Key 使用独立
scope。只读 `crowd:read` Key 无权调用高德代理，因此不会消耗高德额度。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 最小服务状态（公开，不泄露数据库路径或统计） |
| GET | `/api/meta` | 层级、分级标签、推导阈值、当前权限 |
| GET | `/api/cities?q=` | 搜索城市 |
| GET | `/api/regions?city_id=&level=&parent_id=&q=&limit=&offset=` | 搜索区 / 街道 / 景点 |
| GET | `/api/regions/{id}` | 区域详情 |
| GET | `/api/regions/{id}/history` | 该区域历史读数 |
| GET | `/api/density/latest?city_id=&level=&include_empty=` | **地图页主接口** |
| GET | `/api/amap/status` | 高德 Key 是否已配置 |
| GET | `/api/amap/search?q=&city=` | 高德 POI 搜索（服务端代理，Key 不出服务端） |
| GET | `/api/amap/around?lng=&lat=&radius=` | 高德周边搜索 |
| GET | `/api/amap/regeo?lng=&lat=` | 逆地理编码 |
| POST | `/api/regions/from-amap` | 把高德地点登记为可发布区域（幂等） |
| POST | `/api/readings` | 发布一批数据 |
| GET | `/api/batches` / `/api/batches/{id}` | 发布历史 / 批次明细 |
| DELETE | `/api/batches/{id}` | 撤销批次 |
| POST | `/api/cities` / `/api/regions` | 新增城市 / 区域 |

发布：

```bash
curl -X POST http://127.0.0.1:18099/api/readings \
  -H "Authorization: Bearer <PUBLISH_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "publisher": "sensor-sim",
    "items": [
      { "region_id": "macau-poi-ruins-st-paul", "people_count": 860 },
      { "region_id": "macau-s-cunha", "people_count": 430, "crowd_level": 3 }
    ]
  }'
```

读取（地图页就用这个）：

```bash
curl "http://127.0.0.1:18099/api/density/latest?city_id=macau&level=poi&include_empty=0"
```

程序读取时：

```bash
curl "http://127.0.0.1:18099/api/density/latest?city_id=macau" \
  -H "Authorization: Bearer <READ_ONLY_API_KEY>"
```

旧的 `CROWD_READ_TOKEN` / `CROWD_WRITE_TOKEN` 仅在显式设置
`CROWD_AUTH_MODE=compat` 时作为迁移兜底；新部署保持 `required`。

### 给地图页接入时注意

- `reading` 为 `null` 表示**没有数据**，必须和「0 人」区分渲染（灰色/斜纹
  vs 色阶最浅端），否则会误导用户。
- `observed_at` 是 UTC。前端应显示相对时间，并对超过 30 分钟的数据显示
  「已过期」，不要把老数据当实时展示。
- 当前 `geometry` 字段恒为 `null`，用 `center` + `radius_m` 落点。等区域
  多边形补上之后，同一个接口会直接返回 GeoJSON，前端不用改结构。

## 当前版本的边界

以下是刻意留到下一版的，不是遗漏：

0. **高德相关接口尚未用真 Key 实测过**。写代码时本机没有 Key，所以
   `/api/amap/search`、`/api/amap/regeo` 只验证了「没有 Key 时正确降级并给出
   可读错误」。填入 Key 后请先点一次搜索，若报 `USERKEY_PLAT_NOMATCH`
   就是 Key 类型选错了（要 Web服务，不要 JS API）。
1. **没有区域多边形**。内置数据只有中心点和影响半径。真实的堂区边界需要
   从 OSM 提取并转 GCJ-02，街道级几乎没有现成面数据——这是地图页那边最大
   的一块工作量，等你定了「手绘近似多边形 vs 网格热力图」再补。
2. **没有层级自动聚合**。区级的人数必须单独发布，不会由下属街道求和。
   之前分析里推荐的是「有独立值用独立值，没有就求和」的混合规则，但这个
   决定还没定，先不写死；数据结构（`parent_id` + 每条读数独立存储）已经
   支持之后加聚合，不用改表。
3. **发布页没有地图点选**。等有了多边形，发布器和地图页可以共用同一份
   几何数据，那时候「在地图上点区域填人数」才有意义。
4. **单机 SQLite**。够本地演示；要多人同时发布或跨机访问，再考虑换库。

## 内置数据的准确性

`app/seed_data.py` 里的坐标是人工整理的近似值，精度够做分区着色，但不是
测绘数据。需要修正直接改那个文件，然后 `python run.py --reseed`。

澳门部分最完整：8 个堂区/填海区、12 条重点街道、24 个景点。香港、广州、
深圳各有若干区和地标，用来验证多城市切换。

## 诚信提示

这些数据是**人工发布的模拟数据**，不是官方实时客流。接进主项目展示时，
界面上应保留数据来源和更新时间的标注，避免看的人误以为是真实监测数据。

## 目录结构

```text
data_publish/
├─ run.py               启动入口
├─ 启动发布器.bat        Windows 双击启动
├─ .env.example         配置模板（复制成 .env 填 Key）
├─ 项目说明.md           设计说明与接入指南
├─ versions/            版本记录（每版改了什么）
├─ app/
│  ├─ config.py         端口、拥挤度分级与阈值、.env 读取
│  ├─ geo.py            WGS-84 → GCJ-02 转换
│  ├─ amap.py           高德 Web 服务客户端（Key 只在服务端）
│  ├─ db.py             SQLite 表结构与增量迁移
│  ├─ store.py          全部数据访问逻辑
│  ├─ auth.py           读写令牌与本机白名单
│  ├─ api.py            HTTP 服务与路由
│  └─ seed_data.py      内置城市 / 区 / 街道 / 景点
├─ web/
│  ├─ index.html app.js styles.css
│  └─ vendor/           Leaflet 1.9.4（本地化，不走 CDN）
└─ data/crowd.db        运行时生成，不要提交
```

业务逻辑集中在 `store.py`，HTTP 层很薄。以后要换成 FastAPI，或者把这套
数据服务并进主项目，只需要重写 `api.py`。

## 还有这些文档

- **`项目说明.md`** —— 设计说明：为什么这样做、数据模型细节、坐标系约定、
  高德接入的边界、怎么接进主项目。想改代码之前先看这个。
- **`versions/`** —— 版本记录，每个版本改了什么、实现了什么、验证到什么程度。
  当前版本 v1.1.0。
