"use strict";
const $ = (id) => document.getElementById(id);
let csrf = "", presets = [], state = {devices: [], events: [], active: false, needsRestore: false}, selected = {preset: "outside"}, busy = false, dirty = false;
let lastServerError = "";
const pointPositions = {outside: "155 255", stpaul: "425 98", senado: "397 214"};

function notice(text) { $("notice").textContent = text || ""; $("notice").hidden = !text; }
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {cache: "no-store"} : {
    method: "POST", headers: {"Content-Type": "application/json", "X-Demo-CSRF": csrf}, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) { if (result.status) render(result.status); throw new Error(result.error || "请求未完成"); }
  return result;
}

function preview(target) {
  if (!target) return;
  $("target-name").textContent = target.name;
  $("wgs-coords").textContent = `${target.latitude.toFixed(6)}, ${target.longitude.toFixed(6)}`;
  $("gcj-coords").textContent = Number.isFinite(target.mapLatitude) ? `${target.mapLatitude.toFixed(6)}, ${target.mapLongitude.toFixed(6)}` : "开始后显示转换结果";
  const position = pointPositions[target.preset || target.id];
  $("marker").setAttribute("visibility", position ? "visible" : "hidden");
  if (position) $("marker").setAttribute("transform", `translate(${position})`);
  $("custom-marker").hidden = !!position;
  $("custom-marker").textContent = target.preset || target.id ? "该预设未标注在简略示意图内" : "自定义位置 · 不在预设示意图内";
}

function render(next) {
  state = next;
  const oldSerial = $("device").value;
  $("device").replaceChildren();
  if (!next.devices.length) $("device").add(new Option("未发现手机", ""));
  for (const d of next.devices) {
    const suffix = d.state === "device" ? "已连接" : d.state === "unauthorized" ? "等待手机授权" : "离线";
    const option = new Option(`${d.model} · ${d.serial} · ${suffix}`, d.serial);
    option.disabled = d.state !== "device";
    $("device").add(option);
  }
  const preferred = next.serial || oldSerial;
  if (next.devices.some(d => d.serial === preferred)) $("device").value = preferred;
  else $("device").value = next.devices.find(d => d.state === "device")?.serial || "";
  const connected = next.devices.some(d => d.serial === $("device").value && d.state === "device");
  $("connection").textContent = connected ? "●  手机已连接" : "○  等待 Type-C 手机";
  $("connection").classList.toggle("disconnected", !connected);
  $("device").disabled = busy || next.needsRestore;
  $("start").disabled = busy || !connected || next.needsRestore;
  $("restore").disabled = busy || !next.needsRestore;
  $("open-app").disabled = busy || !connected;
  $("apply").disabled = busy || (next.needsRestore && !next.active);
  $("refresh").disabled = busy;
  $("mode").textContent = next.active ? "系统模拟中" : next.needsRestore ? "等待恢复" : "未开启模拟";
  $("mode").classList.toggle("active", next.needsRestore);
  $("device-help").textContent = connected ? "仅通过 ADB 操作；不读取手机聊天或真实位置。" : "解锁手机，允许 USB 调试，再点击刷新。";
  $("start").textContent = next.active ? "● 正在持续发送位置" : "▶ 开始模拟定位";
  const elapsed = next.active ? next.elapsed : 0;
  $("elapsed").replaceChildren(document.createTextNode(String(elapsed).padStart(2, "0")), Object.assign(document.createElement("span"), {textContent: "s"}));
  $("dwell-progress").value = Math.min(30, elapsed);
  $("dwell-title").textContent = next.active ? elapsed >= 30 ? "建议停留时间已满足，请查看手机" : "正在这个位置停留…" : next.needsRestore ? "请恢复手机定位" : "等待开始演示";
  $("send-status").textContent = next.active ? `已发送 ${next.samples} 次 · 每 ${next.interval} 秒更新${next.recoveries ? ` · 重连 ${next.recoveries} 次` : ""}` : "模拟位置发送已停止";
  if (next.target && (next.active || next.needsRestore)) preview(next.target);
  const chosen = next.active ? next.target?.preset : selected.preset;
  document.querySelectorAll(".preset").forEach(button => {
    button.classList.toggle("selected", button.dataset.id === chosen);
    button.setAttribute("aria-pressed", String(button.dataset.id === chosen));
    button.disabled = busy || (next.needsRestore && !next.active);
  });
  if (next.events.length) {
    $("events").replaceChildren(...next.events.map(event => {
      const li = document.createElement("li"), time = document.createElement("time"), text = document.createElement("span");
      time.textContent = new Date(event.time * 1000).toLocaleTimeString("zh-CN", {hour12: false});
      text.textContent = event.text; li.append(time, text); return li;
    }));
  }
  if (next.error) { notice(next.error); lastServerError = next.error; }
  else if (lastServerError) { notice(""); lastServerError = ""; }
}

async function action(fn) {
  if (busy) return;
  busy = true; render(state); notice("");
  try { await fn(); } catch (error) { notice(error.message || "连接失败，请检查控制台是否仍在运行"); }
  finally { busy = false; render(state); }
}

function choose(preset) {
  notice("");
  dirty = false;
  selected = {preset: preset.id};
  $("latitude").value = preset.latitude; $("longitude").value = preset.longitude;
  $("coordinate").value = "wgs84"; $("custom-name").value = preset.name;
  if (!state.active) { preview(preset); render(state); return; }
  action(async () => render(await request("/api/point", selected)));
}

function custom() {
  if (!$("latitude").reportValidity() || !$("longitude").reportValidity()) return null;
  return {latitude: Number($("latitude").value), longitude: Number($("longitude").value), coordinate: $("coordinate").value, name: $("custom-name").value.trim() || "自定义位置"};
}

$("start").onclick = () => {
  const target = dirty ? custom() : selected; if (!target) return;
  action(async () => {render(await request("/api/start", {...target, serial: $("device").value})); selected = target; dirty = false;});
};
$("restore").onclick = () => action(async () => { render(await request("/api/restore", {})); notice(""); });
$("open-app").onclick = () => action(async () => render(await request("/api/open-app", {serial: $("device").value})));
$("refresh").onclick = () => action(async () => {const data = await request("/api/bootstrap"); csrf = data.csrf; render(data.status);});
$("apply").onclick = () => {
  const data = custom(); if (!data) return;
  selected = data; dirty = false;
  action(async () => {
    if (state.active) render(await request("/api/point", data));
    else {preview((await request("/api/preview", data)).target); render(state); notice("自定义坐标已选择，点击“开始模拟定位”发送到手机。");}
  });
};
for (const id of ["latitude", "longitude", "coordinate", "custom-name"]) $(id).addEventListener("input", () => {dirty = true;});

$("preset-group").onchange = () => {
  const group = $("preset-group").value;
  document.querySelectorAll(".preset").forEach(button => { button.hidden = !!group && button.dataset.group !== group; });
  $("preset-count").textContent = `${presets.filter(p => !group || p.group === group).length} 个位置`;
};

async function boot() {
  try {
    const data = await request("/api/bootstrap"); csrf = data.csrf; presets = data.presets;
    $("presets").replaceChildren(...presets.map((preset, index) => {
      const button = document.createElement("button"); button.className = "preset"; button.dataset.id = preset.id;
      button.dataset.group = preset.group;
      const number = Object.assign(document.createElement("span"), {className: "index", textContent: `POINT ${String(index + 1).padStart(2, "0")} · ${preset.group}`});
      const arrow = Object.assign(document.createElement("span"), {className: "arrow", textContent: "↗"});
      const title = Object.assign(document.createElement("strong"), {textContent: preset.name});
      const hint = Object.assign(document.createElement("small"), {textContent: preset.hint});
      button.append(number, arrow, title, hint); button.onclick = () => choose(preset); return button;
    }));
    $("preset-count").textContent = `${presets.length} 个位置`;
    if (data.status.target) {
      const target = data.status.target;
      selected = target.preset ? {preset: target.preset} : {...target, coordinate: "wgs84"};
      $("latitude").value = target.latitude; $("longitude").value = target.longitude;
      $("coordinate").value = "wgs84"; $("custom-name").value = target.name;
    }
    preview(data.status.target || presets[0]); render(data.status);
    setInterval(async () => { if (busy) return; try {render(await request("/api/status"));} catch {notice("控制台连接中断。请重新启动；若仍有模拟位置，请重新连接后恢复。");}}, 2000);
    setInterval(async () => {if (!state.active) return; try {await request("/api/heartbeat", {});} catch {/* server lease restores safely */}}, 5000);
  } catch { notice("无法连接本地后端。请双击“启动定位控制台.cmd”后刷新页面。"); }
}
boot();
