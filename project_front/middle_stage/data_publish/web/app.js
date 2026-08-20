/* 人流密度数据发布器 —— 前端。
 * 无框架、无构建步骤：一个页面直接调用同源的 /api/*。 */

const CSRF_STORAGE_KEY = "crowd_csrf_token";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function csrfFromCookie() {
  for (const name of ["crowd_csrf", "csrf_token", "XSRF-TOKEN"]) {
    const prefix = `${name}=`;
    const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
    if (part) return decodeURIComponent(part.slice(prefix.length));
  }
  return "";
}

const state = {
  meta: null,
  cities: [],
  level: "",
  results: [],
  basket: new Map(), // region_id -> { region, count, crowd_level }
  user: null,
  csrfToken: sessionStorage.getItem(CSRF_STORAGE_KEY) || csrfFromCookie(),
};

/* ── 工具 ────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(message, kind = "") {
  const node = $("toast");
  node.textContent = message;
  node.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (node.className = ""), 3200);
}

function loginUrl() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `/login.html?next=${encodeURIComponent(next)}`;
}

function rememberCsrf(payload) {
  const token = String(payload?.csrf_token || "").trim();
  if (!token) return;
  state.csrfToken = token;
  sessionStorage.setItem(CSRF_STORAGE_KEY, token);
}

async function api(path, { method = "GET", body, redirectOn401 = true } = {}) {
  method = method.toUpperCase();
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (WRITE_METHODS.has(method)) {
    headers["X-CSRF-Token"] = state.csrfToken || csrfFromCookie();
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${response.status}）`);
  }
  if (response.status === 401 && redirectOn401) {
    sessionStorage.removeItem(CSRF_STORAGE_KEY);
    window.location.replace(loginUrl());
    throw new Error("登录状态已失效，正在跳转登录页");
  }
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  rememberCsrf(payload);
  return payload;
}

function levelLabel(level) {
  return state.meta?.level_labels?.[level] || level;
}

function crowdLabel(value) {
  if (value === null || value === undefined) return "无数据";
  return state.meta?.crowd_level_labels?.[value] ?? `等级 ${value}`;
}

function crowdSwatch(value) {
  const cls = value === null || value === undefined ? "lvnone" : `lv${value}`;
  return `<span class="level"><span class="swatch ${cls}"></span>${esc(crowdLabel(value))}</span>`;
}

function relativeTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(then.getTime())) return iso;
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

function isStale(iso, limitMinutes = 30) {
  if (!iso) return false;
  const then = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return (Date.now() - then.getTime()) / 60000 > limitMinutes;
}

function localDatetimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/* ── 顶栏状态 ─────────────────────────────────────────────────────── */

async function refreshStatus() {
  try {
    const health = await api("/api/health");
    $("statusPill").className = "pill ok";
    $("statusText").textContent = "服务正常";
    const s = health.stats;
    $("statsPill").textContent =
      `${s.cities} 城市 · ${s.districts} 区 · ${s.streets} 街道 · ${s.pois} 景点 · ${s.readings} 条读数`;
  } catch (error) {
    $("statusPill").className = "pill bad";
    $("statusText").textContent = `连接失败：${error.message}`;
  }
}

function userFromPayload(payload) {
  return payload?.user || payload;
}

function roleLabel(role) {
  return {
    admin: "管理员",
    administrator: "管理员",
    publisher: "发布员",
    reviewer: "审核员",
    viewer: "只读人员",
  }[role] || role || "部门成员";
}

function isAdmin() {
  return ["admin", "administrator"].includes(String(state.user?.role || "").toLowerCase());
}

async function requireSession() {
  const payload = await api("/api/auth/me");
  rememberCsrf(payload);
  state.user = userFromPayload(payload);
  if (!state.user?.username && !state.user?.user_id && !state.user?.id) {
    throw new Error("服务器未返回当前用户资料");
  }
}

async function refreshAuth() {
  const meta = await api("/api/meta");
  state.meta = meta;

  const pill = $("authPill");
  const text = $("authText");
  const displayName = state.user?.display_name || state.user?.username || "部门成员";
  pill.className = "pill ok";
  text.textContent = `${displayName} · ${roleLabel(state.user?.role)}`;
  $("adminTabButton").hidden = !isAdmin();

  renderLegend();
}

function renderLegend() {
  const labels = state.meta?.crowd_level_labels || [];
  const parts = labels.map(
    (label, index) =>
      `<span class="level"><span class="swatch lv${index}"></span>${esc(label)}</span>`,
  );
  parts.push('<span class="level"><span class="swatch lvnone"></span>无数据</span>');
  $("legend").innerHTML = parts.join("");
}

/* ── 城市 ────────────────────────────────────────────────────────── */

async function loadCities() {
  const data = await api("/api/cities");
  state.cities = data.items;
  const options = state.cities
    .map((city) => `<option value="${esc(city.city_id)}">${esc(city.name)}</option>`)
    .join("");

  // 重建下拉时保留用户当前的选择，避免发布完自动刷新把选中城市弹回去。
  const previous = {
    city: $("citySelect").value,
    map: $("mapCity").value,
    current: $("currentCity").value,
    place: $("newCity").value,
  };

  $("citySelect").innerHTML = options;
  $("newCity").innerHTML = options;
  $("mapCity").innerHTML = `<option value="">不限定</option>${options}`;
  $("currentCity").innerHTML = `<option value="">全部城市</option>${options}`;

  // 这个项目以澳门为主，有澳门就默认选中，省一次点击。
  const fallback = state.cities.some((city) => city.city_id === "macau") ? "macau" : "";
  const restore = (id, saved) => {
    const select = $(id);
    const wanted = saved || fallback;
    if ([...select.options].some((option) => option.value === wanted)) select.value = wanted;
  };
  restore("citySelect", previous.city);
  restore("newCity", previous.place);
  restore("mapCity", previous.map);
  restore("currentCity", previous.current);
}

/* ── 搜索 ────────────────────────────────────────────────────────── */

let searchTimer = null;
function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 220);
}

async function runSearch() {
  const params = new URLSearchParams({
    city_id: $("citySelect").value,
    limit: "60",
  });
  if (state.level) params.set("level", state.level);
  const q = $("regionSearch").value.trim();
  if (q) params.set("q", q);

  try {
    const data = await api(`/api/regions?${params}`);
    state.results = data.items;
    renderResults(data.total);
  } catch (error) {
    $("searchResults").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderResults(total) {
  const box = $("searchResults");
  if (!state.results.length) {
    box.innerHTML = '<div class="empty">没有匹配的区域。换个关键词，或到「新增地点」自己加一个。</div>';
    return;
  }
  const more = total > state.results.length ? `（共 ${total} 条，仅显示前 ${state.results.length} 条）` : "";
  box.innerHTML =
    state.results
      .map((region) => {
        const parent = region.parent_name ? ` · ${esc(region.parent_name)}` : "";
        const inBasket = state.basket.has(region.region_id);
        return `<div class="item">
          <div class="grow">
            <div class="name">${esc(region.name)}</div>
            <div class="meta">${esc(region.city_name || "")}${parent} · ${esc(region.region_id)}</div>
          </div>
          <span class="badge">${esc(levelLabel(region.level))}</span>
          <button class="btn sm" data-add="${esc(region.region_id)}" ${inBasket ? "disabled" : ""}>
            ${inBasket ? "已添加" : "添加"}
          </button>
        </div>`;
      })
      .join("") + (more ? `<div class="empty">${esc(more)}</div>` : "");
}

/* ── 待发布清单 ───────────────────────────────────────────────────── */

function addToBasket(regionId) {
  const region = state.results.find((item) => item.region_id === regionId);
  if (!region || state.basket.has(regionId)) return;
  state.basket.set(regionId, { region, count: "", crowd_level: "" });
  renderBasket();
  renderResults(state.results.length);
}

function renderBasket() {
  const box = $("basket");
  $("basketCount").textContent = `${state.basket.size} 项`;
  if (!state.basket.size) {
    box.innerHTML = '<div class="empty">还没有选择区域，从左侧点击「添加」。</div>';
    return;
  }
  const levelOptions = (selected) =>
    ['<option value="">自动</option>']
      .concat(
        (state.meta?.crowd_level_labels || []).map(
          (label, index) =>
            `<option value="${index}" ${String(selected) === String(index) ? "selected" : ""}>${esc(
              `${index} ${label}`,
            )}</option>`,
        ),
      )
      .join("");

  box.innerHTML = [...state.basket.values()]
    .map(({ region, count, crowd_level }) => {
      const id = esc(region.region_id);
      return `<div class="item">
        <div class="grow">
          <div class="name">${esc(region.name)}</div>
          <div class="meta">${esc(levelLabel(region.level))} · ${id}</div>
        </div>
        <input type="number" min="0" step="1" placeholder="人数" style="width:96px"
               data-count="${id}" value="${esc(count)}">
        <select style="width:104px" data-level="${id}">${levelOptions(crowd_level)}</select>
        <button class="btn sm danger" data-remove="${id}">移除</button>
      </div>`;
    })
    .join("");
}

function randomFill() {
  if (!state.basket.size) {
    toast("清单是空的，先添加区域", "err");
    return;
  }
  // 按层级给一个量级合理的随机值，方便快速造演示数据。
  const ranges = { district: [800, 26000], street: [80, 2600], poi: [40, 1400] };
  for (const entry of state.basket.values()) {
    const [low, high] = ranges[entry.region.level] || ranges.poi;
    entry.count = String(Math.floor(low + Math.random() * (high - low)));
    entry.crowd_level = "";
  }
  renderBasket();
  toast("已随机填充人数，可再手动微调");
}

async function publish() {
  const items = [];
  for (const [regionId, entry] of state.basket) {
    if (entry.count === "" || entry.count === null) {
      toast(`「${entry.region.name}」还没有填人数`, "err");
      return;
    }
    const count = Number(entry.count);
    if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
      toast(`「${entry.region.name}」的人数必须是非负整数`, "err");
      return;
    }
    const item = { region_id: regionId, people_count: count };
    if (entry.crowd_level !== "") item.crowd_level = Number(entry.crowd_level);
    items.push(item);
  }
  if (!items.length) {
    toast("清单是空的", "err");
    return;
  }

  const body = {
    publisher: $("publisherInput").value.trim() || "web-ui",
    note: $("noteInput").value.trim(),
    items,
  };
  const observed = $("observedInput").value;
  if (observed) body.observed_at = new Date(observed).toISOString();

  const button = $("publishBtn");
  button.disabled = true;
  try {
    const result = await api("/api/readings", { method: "POST", body });
    const tag = $("publishResult");
    tag.style.display = "";
    tag.textContent = `已发布 ${result.item_count} 条 · ${result.batch_id}`;
    toast(`发布成功：${result.item_count} 条`, "ok");
    state.basket.clear();
    renderBasket();
    renderResults(state.results.length);
    refreshStatus();
  } catch (error) {
    toast(`发布失败：${error.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

/* ── 当前数据 ─────────────────────────────────────────────────────── */

async function loadCurrent() {
  const params = new URLSearchParams({ include_empty: $("currentEmpty").value });
  if ($("currentCity").value) params.set("city_id", $("currentCity").value);
  if ($("currentLevel").value) params.set("level", $("currentLevel").value);

  const tbody = $("currentTable").querySelector("tbody");
  try {
    const data = await api(`/api/density/latest?${params}`);
    if (!data.items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">还没有数据，先去「发布数据」发一批。</td></tr>';
      return;
    }
    tbody.innerHTML = data.items
      .map((region) => {
        const reading = region.reading;
        const stale = reading && isStale(reading.observed_at);
        const time = reading
          ? `<span class="${stale ? "stale" : ""}">${esc(relativeTime(reading.observed_at))}${
              stale ? " · 已过期" : ""
            }</span>`
          : "—";
        return `<tr>
          <td>${esc(region.name)}</td>
          <td>${esc(levelLabel(region.level))}</td>
          <td>${esc(region.parent_name || region.city_name || "—")}</td>
          <td class="num">${reading ? reading.people_count.toLocaleString("zh-CN") : "—"}</td>
          <td>${crowdSwatch(reading ? reading.crowd_level : null)}</td>
          <td>${time}</td>
        </tr>`;
      })
      .join("");
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${esc(error.message)}</td></tr>`;
  }
}

/* ── 发布历史 ─────────────────────────────────────────────────────── */

async function loadHistory() {
  const tbody = $("historyTable").querySelector("tbody");
  try {
    const data = await api("/api/batches?limit=50");
    if (!data.items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">还没有发布记录。</td></tr>';
      return;
    }
    tbody.innerHTML = data.items
      .map((batch) => {
        const reverted = batch.status === "reverted";
        return `<tr>
          <td><code>${esc(batch.batch_id)}</code></td>
          <td>${esc(batch.publisher || "—")}</td>
          <td class="num">${batch.item_count}</td>
          <td>${reverted ? '<span class="stale">已撤销</span>' : "生效中"}</td>
          <td>${esc(relativeTime(batch.created_at))}</td>
          <td>${esc(batch.note || "—")}</td>
          <td>${
            reverted
              ? ""
              : `<button class="btn sm danger" data-revert="${esc(batch.batch_id)}">撤销</button>`
          }</td>
        </tr>`;
      })
      .join("");
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${esc(error.message)}</td></tr>`;
  }
}

async function revertBatch(batchId) {
  if (!window.confirm(`确认撤销 ${batchId}？该批次写入的读数会被删除。`)) return;
  try {
    await api(`/api/batches/${encodeURIComponent(batchId)}`, { method: "DELETE" });
    toast("已撤销", "ok");
    loadHistory();
    refreshStatus();
  } catch (error) {
    toast(`撤销失败：${error.message}`, "err");
  }
}

/* ── 新增地点 ─────────────────────────────────────────────────────── */

async function loadParentOptions() {
  const cityId = $("newCity").value;
  if (!cityId) return;
  const data = await api(`/api/regions?city_id=${encodeURIComponent(cityId)}&limit=300`);
  $("newParent").innerHTML =
    '<option value="">（无）</option>' +
    data.items
      .filter((region) => region.level !== "poi")
      .map(
        (region) =>
          `<option value="${esc(region.region_id)}">${esc(region.name)} · ${esc(
            levelLabel(region.level),
          )}</option>`,
      )
      .join("");
}

async function createRegion() {
  const name = $("newName").value.trim();
  if (!name) {
    toast("名称不能为空", "err");
    return;
  }
  const body = {
    city_id: $("newCity").value,
    level: $("newLevel").value,
    name,
    name_en: $("newNameEn").value.trim(),
    aliases: $("newAliases").value.trim(),
    parent_id: $("newParent").value,
    coord_system: $("newCoordSystem").value,
  };
  const lng = $("newLng").value.trim();
  const lat = $("newLat").value.trim();
  if (lng && lat) {
    body.lng = lng;
    body.lat = lat;
  }
  const radius = $("newRadius").value.trim();
  if (radius) body.radius_m = radius;

  try {
    const region = await api("/api/regions", { method: "POST", body });
    toast(`已创建：${region.name}（${region.region_id}）`, "ok");
    ["newName", "newNameEn", "newAliases", "newLng", "newLat", "newRadius"].forEach(
      (id) => ($(id).value = ""),
    );
    refreshStatus();
    loadParentOptions();
    runSearch();
  } catch (error) {
    toast(`创建失败：${error.message}`, "err");
  }
}

/* ── API 示例 ─────────────────────────────────────────────────────── */

function renderCurlExamples() {
  const origin = window.location.origin;
  $("curlPublish").textContent = `curl -X POST ${origin}/api/readings \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "publisher": "sensor-sim",
    "note": "周末下午",
    "items": [
      { "region_id": "macau-poi-ruins-st-paul", "people_count": 860 },
      { "region_id": "macau-s-cunha", "people_count": 430, "crowd_level": 3 }
    ]
  }'`;
  $("curlLatest").textContent =
    `curl "${origin}/api/density/latest?city_id=macau&level=poi&include_empty=0" \\
  -H "Authorization: Bearer <API_KEY>"`;
}

/* ── 地图发布 ─────────────────────────────────────────────────────── */

// 高德栅格瓦片是 GCJ-02，和库里存的坐标天然对齐（与主项目 TravelPlanner 同源）。
const AMAP_TILE_URL =
  "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}";

const LEVEL_COLORS = ["--level-0", "--level-1", "--level-2", "--level-3", "--level-4"];

const map = {
  instance: null,
  existingLayer: null,
  pickLayer: null,
  amapReady: false,
  selection: null, // { name, address, lng, lat, amap_id, city, adcode, region }
};

function levelColor(value) {
  const name = value === null || value === undefined ? "--level-none" : LEVEL_COLORS[value];
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

async function initMap() {
  if (map.instance) {
    map.instance.invalidateSize();
    return;
  }

  const city = state.cities.find((item) => item.city_id === $("mapCity").value) || state.cities[0];
  const center = city ? [city.center[1], city.center[0]] : [22.1987, 113.5439];

  map.instance = L.map("map", { center, zoom: city?.default_zoom || 13, zoomControl: true });
  L.tileLayer(AMAP_TILE_URL, {
    subdomains: ["1", "2", "3", "4"],
    maxZoom: 18,
    attribution: "高德地图 GCJ-02",
  }).addTo(map.instance);

  map.existingLayer = L.layerGroup().addTo(map.instance);
  map.pickLayer = L.layerGroup().addTo(map.instance);

  map.instance.on("click", (event) => {
    void pickByCoordinate(event.latlng.lng, event.latlng.lat);
  });

  await checkAmap();
  await loadExistingMarkers();
}

async function checkAmap() {
  try {
    const status = await api("/api/amap/status");
    map.amapReady = status.configured;
    const notice = $("amapNotice");
    if (status.configured) {
      notice.style.display = "none";
    } else {
      notice.style.display = "";
      notice.innerHTML =
        "尚未配置高德 Key，<strong>搜索地点和地图点击反查地址暂不可用</strong>。" +
        "把 <code>.env.example</code> 复制成 <code>.env</code>，填入 " +
        "<code>AMAP_WEB_KEY</code>（必须是「Web服务」类型的 Key），重启服务即可。" +
        "地图底图和已有数据不受影响。";
    }
  } catch (error) {
    map.amapReady = false;
    toast(`高德状态检查失败：${error.message}`, "err");
  }
}

async function loadExistingMarkers() {
  if (!map.existingLayer) return;
  map.existingLayer.clearLayers();

  const params = new URLSearchParams({ include_empty: "0" });
  if ($("mapCity").value) params.set("city_id", $("mapCity").value);

  try {
    const data = await api(`/api/density/latest?${params}`);
    data.items.forEach((region) => {
      if (!region.center) return;
      const [lng, lat] = region.center;
      const level = region.reading ? region.reading.crowd_level : null;
      const marker = L.circleMarker([lat, lng], {
        radius: 9,
        color: "#ffffff",
        weight: 1.5,
        fillColor: levelColor(level),
        fillOpacity: 0.85,
      });
      marker.bindTooltip(
        `${region.name}<br>${region.reading ? region.reading.people_count.toLocaleString("zh-CN") : "—"} 人 · ${crowdLabel(level)}`,
        { direction: "top" },
      );
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        selectExistingRegion(region);
      });
      map.existingLayer.addLayer(marker);
    });
  } catch (error) {
    toast(`读取已有数据失败：${error.message}`, "err");
  }
}

function setPickMarker(lng, lat) {
  map.pickLayer.clearLayers();
  const icon = L.divIcon({ className: "", html: '<div class="map-pin"></div>', iconSize: [0, 0] });
  L.marker([lat, lng], { icon }).addTo(map.pickLayer);
}

function openPanel(selection) {
  map.selection = selection;
  $("mapPanel").style.display = "";
  $("panelTitle").textContent = selection.region ? "已登记的地点" : "新位置";
  $("panelSourceBadge").textContent = selection.source || "";
  $("panelAddress").textContent = selection.address || "（高德未返回详细地址）";
  $("panelCoord").textContent = `GCJ-02 ${selection.lng.toFixed(6)}, ${selection.lat.toFixed(6)}`;
  $("panelName").value = selection.name || "";
  $("panelLevel").value = selection.level || "poi";
  $("panelCount").value = selection.people_count ?? "";
  $("panelCrowd").value = "";
  $("panelExisting").textContent = selection.region
    ? `已有记录：${selection.region.region_id}`
    : "发布时会自动登记这个地点";
  setPickMarker(selection.lng, selection.lat);
}

function selectExistingRegion(region) {
  map.instance.flyTo([region.center[1], region.center[0]], Math.max(map.instance.getZoom(), 16));
  openPanel({
    name: region.name,
    address: region.address || region.parent_name || region.city_name || "",
    lng: region.center[0],
    lat: region.center[1],
    level: region.level,
    region,
    region_id: region.region_id,
    people_count: region.reading ? region.reading.people_count : "",
    source: "本库已有",
  });
}

async function searchAmap() {
  const keywords = $("mapSearch").value.trim();
  if (!keywords) {
    toast("请输入要搜索的地点", "err");
    return;
  }
  if (!map.amapReady) {
    toast("尚未配置高德 Key，无法搜索", "err");
    return;
  }
  const box = $("mapResults");
  box.innerHTML = '<div class="empty">搜索中…</div>';

  const cityId = $("mapCity").value;
  const city = state.cities.find((item) => item.city_id === cityId);
  const params = new URLSearchParams({ q: keywords, limit: "20" });
  if (city) params.set("city", city.name);

  try {
    const data = await api(`/api/amap/search?${params}`);
    if (!data.items.length) {
      box.innerHTML = '<div class="empty">高德没有搜到匹配的地点。</div>';
      return;
    }
    map.searchResults = data.items;
    box.innerHTML = data.items
      .map(
        (poi, index) => `<div class="item">
          <div class="grow">
            <div class="name">${esc(poi.name)}</div>
            <div class="meta">${esc([poi.district, poi.address, poi.type.split(";").pop()].filter(Boolean).join(" · "))}</div>
          </div>
          <button class="btn sm" data-poi="${index}">定位</button>
        </div>`,
      )
      .join("");
  } catch (error) {
    box.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function selectAmapPoi(index) {
  const poi = (map.searchResults || [])[index];
  if (!poi || !poi.center) return;
  if (poi.region) {
    selectExistingRegion(poi.region);
    return;
  }
  const [lng, lat] = poi.center;
  map.instance.flyTo([lat, lng], 17);
  openPanel({
    name: poi.name,
    address: [poi.district, poi.address].filter(Boolean).join(" · "),
    lng,
    lat,
    level: "poi",
    amap_id: poi.amap_id,
    city: poi.city,
    adcode: poi.adcode,
    amap_type: poi.type,
    source: "高德 POI",
  });
}

function distanceBetweenCoordinates(lng1, lat1, lng2, lat2) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusM = 6371008.8;
  const latDelta = toRadians(lat2 - lat1);
  const lngDelta = toRadians(lng2 - lng1);
  const startLat = toRadians(lat1);
  const endLat = toRadians(lat2);
  const value =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDelta / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function getNearestPois(pois, lng, lat, limit = 5) {
  return (Array.isArray(pois) ? pois : [])
    .filter(
      (poi) =>
        poi.name &&
        Array.isArray(poi.center) &&
        poi.center.length === 2 &&
        Number.isFinite(Number(poi.center[0])) &&
        Number.isFinite(Number(poi.center[1])),
    )
    .map((poi) => ({
      ...poi,
      distance_m: distanceBetweenCoordinates(
        lng,
        lat,
        Number(poi.center[0]),
        Number(poi.center[1]),
      ),
    }))
    .sort((left, right) => left.distance_m - right.distance_m)
    .slice(0, limit);
}

function formatPoiDistance(distanceM) {
  return distanceM >= 1000
    ? `${(distanceM / 1000).toFixed(1)} 公里`
    : `${Math.round(distanceM)} 米`;
}

function poiTypeLabel(poi) {
  return String(poi.type || "")
    .split(";")
    .filter(Boolean)
    .pop() || "地点";
}

async function getNearestRegisteredPlaces(lng, lat) {
  const params = new URLSearchParams({ limit: "500" });
  if ($("mapCity").value) params.set("city_id", $("mapCity").value);
  const data = await api(`/api/regions?${params}`);
  const located = data.items.filter((region) => region.center && region.name);
  const pois = located.filter((region) => region.level === "poi");
  const candidates = pois.length >= 5 ? pois : pois.concat(located.filter((region) => region.level !== "poi"));

  return getNearestPois(
    candidates.map((region) => ({
      name: region.name,
      center: region.center,
      address: [region.parent_name, region.city_name].filter(Boolean).join(" · "),
      type: levelLabel(region.level),
      region,
    })),
    lng,
    lat,
    5,
  );
}

function renderNearestPlaces(nearestPois, note = "") {
  map.searchResults = nearestPois;
  if (!nearestPois.length) {
    $("mapResults").innerHTML =
      '<div class="empty">点击位置附近没有查到带名称和坐标的地点。</div>';
    return;
  }

  $("mapResults").innerHTML =
    `<div class="empty" style="padding:10px">离点击位置最近的 ${nearestPois.length} 个地点（由近到远）${note ? ` · ${esc(note)}` : ""}：</div>` +
    nearestPois
      .map(
        (poi, index) => `<div class="item">
          <div class="grow">
            <div class="name">${index + 1}. ${esc(poi.name)}</div>
            <div class="meta">${esc([formatPoiDistance(poi.distance_m), poiTypeLabel(poi), poi.address].filter(Boolean).join(" · "))}</div>
          </div>
          <button class="btn sm" data-poi="${index}">选择</button>
        </div>`,
      )
      .join("");
}

function openPickedCoordinate(lng, lat, nearestPois, details = {}) {
  const nearest = nearestPois[0];
  openPanel({
    name: nearest ? nearest.name : details.fallbackName || "",
    address: details.address || nearest?.address || "",
    lng,
    lat,
    level: nearest?.region?.level || (nearest ? "poi" : "street"),
    amap_id: nearest?.amap_id || "",
    city: details.city || nearest?.city || "",
    adcode: details.adcode || nearest?.adcode || "",
    source: details.source || "地图点选 · 最近地点",
  });
  renderNearestPlaces(nearestPois, details.note || "");
}

async function pickByCoordinate(lng, lat) {
  setPickMarker(lng, lat);
  if (!map.amapReady) {
    try {
      const nearestPois = await getNearestRegisteredPlaces(lng, lat);
      openPickedCoordinate(lng, lat, nearestPois, {
        source: "地图点选 · 本地最近地点",
        note: "本地已登记数据",
      });
    } catch (error) {
      openPanel({
        name: "",
        address: "无法读取附近地点；可以自己填名称后发布。",
        lng,
        lat,
        level: "poi",
        source: "手动点选",
      });
      renderNearestPlaces([]);
    }
    return;
  }
  try {
    const info = await api(`/api/amap/regeo?lng=${lng.toFixed(6)}&lat=${lat.toFixed(6)}`);
    // 严格按 POI 坐标到点击坐标的直线距离排序，只展示最近 5 个有效地点。
    const nearestPois = getNearestPois(info.nearby, lng, lat, 5);
    openPickedCoordinate(lng, lat, nearestPois, {
      address: info.formatted_address,
      city: info.city,
      adcode: info.adcode,
      fallbackName: info.township || info.street || info.formatted_address,
      source: nearestPois.length ? "地图点选 · 最近 POI" : "地图点选 · 反查地址",
      note: "高德 POI",
    });
  } catch (error) {
    try {
      const nearestPois = await getNearestRegisteredPlaces(lng, lat);
      openPickedCoordinate(lng, lat, nearestPois, {
        source: "地图点选 · 本地最近地点",
        note: "高德不可用，已切换本地数据",
      });
      toast(`高德反查不可用，已展示本地最近地点：${error.message}`, "err");
    } catch (fallbackError) {
      toast(`读取附近地点失败：${fallbackError.message}`, "err");
      openPanel({ name: "", address: "", lng, lat, level: "poi", source: "手动点选" });
      renderNearestPlaces([]);
    }
  }
}

async function publishFromPanel() {
  const selection = map.selection;
  if (!selection) return;

  const name = $("panelName").value.trim();
  if (!name) {
    toast("请填写地点名称", "err");
    return;
  }
  const rawCount = $("panelCount").value;
  if (rawCount === "") {
    toast("请填写人数", "err");
    return;
  }
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 0) {
    toast("人数必须是非负整数", "err");
    return;
  }

  const button = $("panelPublishBtn");
  button.disabled = true;
  try {
    // 1) 先确保这个地点在库里有 region 记录
    let regionId = selection.region_id;
    if (!regionId) {
      const region = await api("/api/regions/from-amap", {
        method: "POST",
        body: {
          name,
          level: $("panelLevel").value,
          lng: selection.lng,
          lat: selection.lat,
          coord_system: "gcj02",
          amap_id: selection.amap_id || "",
          address: selection.address || "",
          city: selection.city || "",
          adcode: selection.adcode || "",
          amap_type: selection.amap_type || "",
          // 高德没给出城市（例如未配 Key 时直接点地图）时，用页面上限定的城市兜底
          city_id: selection.city ? "" : $("mapCity").value,
        },
      });
      regionId = region.region_id;
    }

    // 2) 再发布这一条读数
    const item = { region_id: regionId, people_count: count };
    if ($("panelCrowd").value !== "") item.crowd_level = Number($("panelCrowd").value);
    const result = await api("/api/readings", {
      method: "POST",
      body: { publisher: $("publisherInput").value.trim() || "map-ui", items: [item] },
    });

    toast(`已发布：${name} ${count} 人（${result.batch_id}）`, "ok");
    $("panelCount").value = "";
    $("mapPanel").style.display = "none";
    map.selection = null;
    map.pickLayer.clearLayers();
    await loadExistingMarkers();
    await refreshStatus();
    await loadCities();
  } catch (error) {
    toast(`发布失败：${error.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

function renderMapLegend() {
  const labels = state.meta?.crowd_level_labels || [];
  $("mapLegend").innerHTML = labels
    .map((label, index) => `<span class="level"><span class="swatch lv${index}"></span>${esc(label)}</span>`)
    .join("");
  $("panelCrowd").innerHTML =
    '<option value="">自动</option>' +
    labels.map((label, index) => `<option value="${index}">${esc(`${index} ${label}`)}</option>`).join("");
}

/* ── 部门管理（仅管理员可见）────────────────────────────────────── */

function itemsFrom(payload, alternateKey) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (alternateKey && Array.isArray(payload?.[alternateKey])) return payload[alternateKey];
  return [];
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function normalizedScopes(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 兼容逗号或空格分隔的 scope 字符串。
    }
    return value.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

async function loadAdminUsers() {
  const body = $("adminUsersBody");
  body.innerHTML = '<tr><td colspan="6" class="empty">正在加载账号…</td></tr>';
  try {
    const payload = await api("/api/admin/users");
    const users = itemsFrom(payload, "users");
    body.innerHTML = users.length
      ? users
          .map((user) => {
            const enabled = user.active !== false && user.enabled !== false && user.status !== "disabled";
            return `<tr>
              <td>${esc(user.username || "—")}</td>
              <td>${esc(user.display_name || "—")}</td>
              <td><span class="badge">${esc(roleLabel(user.role))}</span></td>
              <td>${enabled ? "启用" : "停用"}</td>
              <td>${esc(formatTime(user.last_login_at))}</td>
              <td>${esc(formatTime(user.created_at))}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="6" class="empty">暂无部门账号</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="6" class="empty">加载失败：${esc(error.message)}</td></tr>`;
  }
}

async function createAdminUser(event) {
  event.preventDefault();
  const button = $("createUserBtn");
  const body = {
    username: $("adminUsername").value.trim(),
    display_name: $("adminDisplayName").value.trim(),
    password: $("adminPassword").value,
    role: $("adminRole").value,
  };
  if (!body.username || !body.password) {
    toast("用户名和初始密码不能为空", "err");
    return;
  }
  button.disabled = true;
  try {
    await api("/api/admin/users", { method: "POST", body });
    $("createUserForm").reset();
    $("adminRole").value = "publisher";
    toast(`账号 ${body.username} 已创建`, "ok");
    await loadAdminUsers();
  } catch (error) {
    toast(`创建账号失败：${error.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

function keyStatus(key) {
  if (key.revoked_at || key.revoked === true || key.status === "revoked") return "已撤销";
  if (key.enabled === false || key.status === "disabled") return "已停用";
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return "已过期";
  return "有效";
}

async function loadAdminApiKeys() {
  const body = $("adminKeysBody");
  body.innerHTML = '<tr><td colspan="7" class="empty">正在加载 API Key…</td></tr>';
  try {
    const payload = await api("/api/admin/api-keys");
    const keys = itemsFrom(payload, "api_keys");
    body.innerHTML = keys.length
      ? keys
          .map((key) => {
            const id = key.key_id || key.id || "";
            const status = keyStatus(key);
            const prefix = key.prefix || key.key_prefix || (id ? `crowd_live_${id}_…` : "—");
            return `<tr>
              <td>${esc(key.name || "—")}</td>
              <td><code>${esc(prefix)}</code></td>
              <td class="scope-cell">${normalizedScopes(key.scopes).map((scope) => `<span class="badge">${esc(scope)}</span>`).join(" ") || "—"}</td>
              <td>${esc(status)}</td>
              <td>${esc(formatTime(key.expires_at))}</td>
              <td>${esc(formatTime(key.last_used_at))}</td>
              <td>${status === "有效" && id ? `<button class="btn sm danger" data-revoke-key="${esc(id)}">撤销</button>` : "—"}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="7" class="empty">暂无 API Key</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7" class="empty">加载失败：${esc(error.message)}</td></tr>`;
  }
}

async function createAdminApiKey(event) {
  event.preventDefault();
  const scopes = [...document.querySelectorAll('input[name="adminKeyScope"]:checked')].map(
    (input) => input.value,
  );
  const body = { name: $("adminKeyName").value.trim(), scopes };
  const expires = $("adminKeyExpires").value;
  if (expires) body.expires_at = new Date(expires).toISOString();
  if (!body.name || !scopes.length) {
    toast("请填写 Key 名称并至少选择一个权限", "err");
    return;
  }

  const button = $("createKeyBtn");
  button.disabled = true;
  try {
    const payload = await api("/api/admin/api-keys", { method: "POST", body });
    const fullKey = payload.api_key || payload.key || payload.token || payload.secret || "";
    if (!fullKey) throw new Error("服务器没有返回新 API Key 的完整值");
    $("createdKeyValue").textContent = fullKey;
    $("createdKeyPanel").hidden = false;
    $("createKeyForm").reset();
    toast("API Key 已创建，请立即复制保存", "ok");
    await loadAdminApiKeys();
  } catch (error) {
    toast(`创建 API Key 失败：${error.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

async function revokeAdminApiKey(keyId) {
  if (!window.confirm("确定撤销这个 API Key？撤销后使用它的软件会立即失去访问权限。")) return;
  try {
    await api(`/api/admin/api-keys/${encodeURIComponent(keyId)}/revoke`, {
      method: "POST",
      body: {},
    });
    toast("API Key 已撤销", "ok");
    await Promise.all([loadAdminApiKeys(), loadAdminAudit()]);
  } catch (error) {
    toast(`撤销失败：${error.message}`, "err");
  }
}

async function loadAdminAudit() {
  const body = $("adminAuditBody");
  body.innerHTML = '<tr><td colspan="7" class="empty">正在加载审计记录…</td></tr>';
  const limit = Math.max(1, Math.min(Number($("auditLimit").value) || 100, 500));
  try {
    const payload = await api(`/api/admin/audit?limit=${limit}`);
    const logs = itemsFrom(payload, "audit_logs");
    body.innerHTML = logs.length
      ? logs
          .map((entry) => {
            const actor = entry.actor_label || entry.actor_name || entry.username || entry.key_name || entry.actor_id || "—";
            const resource = entry.resource || entry.resource_type || entry.target_type || "—";
            const resourceId = entry.resource_id || entry.target_id || "";
            return `<tr>
              <td>${esc(formatTime(entry.created_at || entry.timestamp))}</td>
              <td>${esc(actor)}</td>
              <td>${esc(entry.actor_type || "—")}</td>
              <td>${esc(entry.action || "—")}</td>
              <td>${esc(`${resource}${resourceId ? ` · ${resourceId}` : ""}`)}</td>
              <td>${esc(entry.result || entry.status || "—")}</td>
              <td>${esc(entry.client_ip || entry.ip || "—")}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="7" class="empty">暂无审计记录</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7" class="empty">加载失败：${esc(error.message)}</td></tr>`;
  }
}

async function loadAdminPanel() {
  if (!isAdmin()) return;
  await Promise.all([loadAdminUsers(), loadAdminApiKeys(), loadAdminAudit()]);
}

async function logout() {
  const button = $("logoutBtn");
  button.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch (error) {
    if (error.status !== 401) {
      button.disabled = false;
      toast(`退出失败：${error.message}`, "err");
      return;
    }
  }
  sessionStorage.removeItem(CSRF_STORAGE_KEY);
  window.location.replace("/login.html");
}

/* ── 事件绑定 ─────────────────────────────────────────────────────── */

function bindEvents() {
  document.querySelectorAll("nav.tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      button.classList.add("active");
      const tab = button.dataset.tab;
      $(`tab-${tab}`).classList.add("active");
      if (tab === "map") initMap();
      if (tab === "current") loadCurrent();
      if (tab === "history") loadHistory();
      if (tab === "places") loadParentOptions();
      if (tab === "admin") loadAdminPanel();
    });
  });

  $("mapCity").addEventListener("change", async () => {
    const city = state.cities.find((item) => item.city_id === $("mapCity").value);
    if (city && map.instance) {
      map.instance.flyTo([city.center[1], city.center[0]], city.default_zoom || 13);
    }
    await loadExistingMarkers();
  });
  $("mapSearchBtn").addEventListener("click", searchAmap);
  $("mapSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchAmap();
  });
  $("mapReloadBtn").addEventListener("click", loadExistingMarkers);
  $("mapResults").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-poi]");
    if (button) selectAmapPoi(Number(button.dataset.poi));
  });
  $("panelPublishBtn").addEventListener("click", publishFromPanel);
  $("panelCloseBtn").addEventListener("click", () => {
    $("mapPanel").style.display = "none";
    map.selection = null;
    map.pickLayer?.clearLayers();
  });

  $("citySelect").addEventListener("change", runSearch);
  $("regionSearch").addEventListener("input", scheduleSearch);

  $("levelFilter").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    $("levelFilter")
      .querySelectorAll("button")
      .forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    state.level = button.dataset.level;
    runSearch();
  });

  $("searchResults").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-add]");
    if (button) addToBasket(button.dataset.add);
  });

  $("addAllBtn").addEventListener("click", () => {
    state.results.forEach((region) => addToBasket(region.region_id));
  });

  // 清单里的输入用事件委托，避免每次重渲染都重新绑定。
  $("basket").addEventListener("input", (event) => {
    const countInput = event.target.closest("input[data-count]");
    if (countInput) {
      const entry = state.basket.get(countInput.dataset.count);
      if (entry) entry.count = countInput.value;
    }
  });

  $("basket").addEventListener("change", (event) => {
    const select = event.target.closest("select[data-level]");
    if (select) {
      const entry = state.basket.get(select.dataset.level);
      if (entry) entry.crowd_level = select.value;
    }
  });

  $("basket").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-remove]");
    if (!button) return;
    state.basket.delete(button.dataset.remove);
    renderBasket();
    renderResults(state.results.length);
  });

  $("randomFillBtn").addEventListener("click", randomFill);
  $("clearBasketBtn").addEventListener("click", () => {
    state.basket.clear();
    renderBasket();
    renderResults(state.results.length);
  });
  $("publishBtn").addEventListener("click", publish);

  $("currentCity").addEventListener("change", loadCurrent);
  $("currentLevel").addEventListener("change", loadCurrent);
  $("currentEmpty").addEventListener("change", loadCurrent);
  $("refreshCurrentBtn").addEventListener("click", loadCurrent);

  $("refreshHistoryBtn").addEventListener("click", loadHistory);
  $("historyTable").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-revert]");
    if (button) revertBatch(button.dataset.revert);
  });

  $("newCity").addEventListener("change", loadParentOptions);
  $("createRegionBtn").addEventListener("click", createRegion);

  $("logoutBtn").addEventListener("click", logout);
  $("createUserForm").addEventListener("submit", createAdminUser);
  $("refreshUsersBtn").addEventListener("click", loadAdminUsers);
  $("createKeyForm").addEventListener("submit", createAdminApiKey);
  $("refreshKeysBtn").addEventListener("click", loadAdminApiKeys);
  $("adminKeysBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-revoke-key]");
    if (button) revokeAdminApiKey(button.dataset.revokeKey);
  });
  $("copyCreatedKeyBtn").addEventListener("click", async () => {
    const value = $("createdKeyValue").textContent;
    try {
      await navigator.clipboard.writeText(value);
      toast("API Key 已复制", "ok");
    } catch {
      window.getSelection()?.selectAllChildren($("createdKeyValue"));
      toast("无法自动复制，已选中内容，请手动复制", "err");
    }
  });
  $("dismissCreatedKeyBtn").addEventListener("click", () => {
    $("createdKeyValue").textContent = "";
    $("createdKeyPanel").hidden = true;
  });
  $("refreshAuditBtn").addEventListener("click", loadAdminAudit);
}

/* ── 启动 ────────────────────────────────────────────────────────── */

async function main() {
  await requireSession();
  bindEvents();
  renderCurlExamples();
  $("observedInput").value = localDatetimeValue();
  await refreshStatus();
  try {
    await refreshAuth();
    renderMapLegend();
    await loadCities();
    await runSearch();
    await initMap(); // 地图是默认标签页
  } catch (error) {
    toast(`初始化失败：${error.message}`, "err");
  }
}

main();
