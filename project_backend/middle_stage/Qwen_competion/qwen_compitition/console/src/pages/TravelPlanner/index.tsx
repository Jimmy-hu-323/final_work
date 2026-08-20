import { Button, Empty, Segmented, Spin, Tag } from "antd";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  ArrowRight,
  Bus,
  Camera,
  Clock3,
  Footprints,
  Hotel,
  MapPin,
  Navigation,
  RefreshCw,
  Route,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { buildAuthHeaders } from "../../api/authHeaders";
import { getApiUrl } from "../../api/config";
import { useTheme } from "../../contexts/ThemeContext";
import styles from "./index.module.less";

interface TravelLeg {
  mode?: string;
  distance_meters?: number;
  duration_text?: string;
  steps?: string[];
}

interface TravelActivity {
  order: number;
  name: string;
  location?: string;
  type?: string;
  note?: string;
  stay_minutes?: number;
  arrive_time?: string;
  depart_time?: string;
  travel_from_previous?: TravelLeg | null;
}

interface TravelDay {
  day_number?: number;
  title: string;
  day_start?: string;
  day_end?: string;
  total_distance_meters?: number;
  total_travel_text?: string;
  map_preview_path?: string;
  activities: TravelActivity[];
}

interface TravelItinerary {
  title: string;
  destination: string;
  day_count: number;
  transportation?: string;
  updated_at?: string;
  days: TravelDay[];
}

const TRANSPORT_LABELS: Record<string, string> = {
  walking: "步行",
  driving: "驾车",
  transit: "公交",
  auto: "自动",
};

type TypeMeta = { label: string; color: string; icon: typeof Camera };

const TYPE_META: Record<string, TypeMeta> = {
  sightseeing: { label: "观光", color: "#f97316", icon: Camera },
  activity: { label: "活动", color: "#8b5cf6", icon: Sparkles },
  transport: { label: "交通", color: "#0ea5e9", icon: Bus },
  hotel: { label: "住宿", color: "#10b981", icon: Hotel },
};

const DEFAULT_TYPE: TypeMeta = { label: "地点", color: "#f97316", icon: MapPin };

function typeMeta(type?: string): TypeMeta {
  return (type && TYPE_META[type]) || DEFAULT_TYPE;
}

function formatDistance(meters?: number) {
  if (!meters) return "";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

function dayKey(day: TravelDay, index: number) {
  return day.day_number || index + 1;
}

/** AMap coordinates are stored as "lng,lat" (GCJ-02); Leaflet wants [lat, lng]. */
function parseLatLng(location?: string): [number, number] | null {
  if (!location) return null;
  const [lng, lat] = location.split(",").map((value) => Number(value.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripDayPrefix(title: string) {
  const match = title.match(/第\s*\d+\s*天/);
  return match ? match[0] : title;
}

/** AMap directions only supports these; anything else routes as driving. */
function normalizeMode(mode?: string) {
  return mode === "walking" ? "walking" : "driving";
}

type Stop = { activity: TravelActivity; coord: [number, number] };

function routeKey(a: Stop, b: Stop) {
  return `${normalizeMode(b.activity.travel_from_previous?.mode)}:${
    a.activity.location
  }:${b.activity.location}`;
}

// AMap raster tiles are GCJ-02, so they line up exactly with the stored
// coordinates. Tiles are best-effort: markers + route still render without them.
const AMAP_TILE_URL =
  "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}";

export default function TravelPlanner() {
  const navigate = useNavigate();
  const { isDark } = useTheme();
  const [itinerary, setItinerary] = useState<TravelItinerary | null>(null);
  const [selectedDayNumber, setSelectedDayNumber] = useState<number | null>(
    null,
  );
  const [activeOrder, setActiveOrder] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [tilesFailed, setTilesFailed] = useState(false);

  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<number, L.Marker>>(new Map());
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const flyTimerRef = useRef<number | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  // Decoded real-route polylines, keyed by `mode:origin:destination`.
  const routeCacheRef = useRef<Map<string, [number, number][]>>(new Map());
  const routeReqRef = useRef(0);

  const loadItinerary = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(getApiUrl("/travel-planner/latest"), {
        headers: buildAuthHeaders(),
        cache: "no-store",
      });
      if (response.status === 404) {
        setItinerary(null);
        setError("");
        return;
      }
      if (!response.ok) throw new Error("暂时无法读取行程，请稍后重试。");
      const data = (await response.json()) as TravelItinerary;
      setItinerary(data);
      setSelectedDayNumber((current) => {
        if (
          current &&
          data.days.some((day, index) => dayKey(day, index) === current)
        ) {
          return current;
        }
        return data.days.length ? dayKey(data.days[0], 0) : null;
      });
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "暂时无法读取行程。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadItinerary();
    const timer = window.setInterval(() => void loadItinerary(), 20_000);
    return () => window.clearInterval(timer);
  }, [loadItinerary]);

  const selectedDay = useMemo(() => {
    if (!itinerary?.days.length) return null;
    return (
      itinerary.days.find(
        (day, index) => dayKey(day, index) === selectedDayNumber,
      ) || itinerary.days[0]
    );
  }, [itinerary, selectedDayNumber]);

  const mappable = useMemo(
    () =>
      (selectedDay?.activities || [])
        .map((activity) => ({ activity, coord: parseLatLng(activity.location) }))
        .filter(
          (e): e is { activity: TravelActivity; coord: [number, number] } =>
            e.coord !== null,
        ),
    [selectedDay],
  );

  // Signature so 20s polling with unchanged data doesn't re-fit the map.
  const mapSignature = useMemo(
    () =>
      `${selectedDayNumber}|` +
      mappable
        .map((e) => `${e.activity.order},${e.coord[0]},${e.coord[1]}`)
        .join(";"),
    [selectedDayNumber, mappable],
  );
  const mappableRef = useRef(mappable);
  mappableRef.current = mappable;

  // ---- Map creation via callback ref: robust single init + cleanup, and it
  // only ever touches Leaflet inside try/catch so a tile/engine quirk can never
  // bubble up into React's render and trip the error boundary. ----
  const attachMap = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      // Detach: tear the map down.
      if (flyTimerRef.current) window.clearTimeout(flyTimerRef.current);
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      try {
        mapRef.current?.remove();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      layerRef.current = null;
      routeLayerRef.current = null;
      markersRef.current.clear();
      return;
    }
    if (mapRef.current) return;
    try {
      const map = L.map(node, {
        zoomControl: true,
        attributionControl: false,
        scrollWheelZoom: true,
      }).setView([22.17, 113.55], 12);
      const tiles = L.tileLayer(AMAP_TILE_URL, {
        subdomains: "1234",
        maxZoom: 18,
        minZoom: 3,
      });
      let failures = 0;
      tiles.on("tileerror", () => {
        failures += 1;
        if (failures >= 3) setTilesFailed(true);
      });
      tiles.on("load", () => setTilesFailed(false));
      tiles.addTo(map);
      // Route sits under the markers; markers stay on their own layer.
      routeLayerRef.current = L.layerGroup().addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      // Keep Leaflet's pixel origin in sync with the real container size —
      // without this, markers get placed against a stale size and land far
      // outside the viewport (the "map won't display" symptom).
      if (typeof ResizeObserver !== "undefined") {
        const obs = new ResizeObserver(() => {
          try {
            map.invalidateSize(false);
          } catch {
            /* ignore */
          }
        });
        obs.observe(node);
        resizeObsRef.current = obs;
      }
      // Draw after the container has a settled size.
      window.requestAnimationFrame(() => {
        try {
          map.invalidateSize(false);
        } catch {
          /* ignore */
        }
        renderDay(mappableRef.current);
      });
    } catch {
      mapRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw the route line from whatever geometry we currently have cached:
  // solid orange for real road routes, faded dashes for not-yet-loaded legs.
  const drawRoute = useCallback((stops: Stop[]) => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    try {
      layer.clearLayers();
      for (let i = 1; i < stops.length; i += 1) {
        const prev = stops[i - 1];
        const cur = stops[i];
        const real = routeCacheRef.current.get(routeKey(prev, cur));
        if (real && real.length > 1) {
          L.polyline(real, {
            color: "#FF7F16",
            weight: 5,
            opacity: 0.9,
            lineJoin: "round",
            lineCap: "round",
          }).addTo(layer);
        } else {
          L.polyline([prev.coord, cur.coord], {
            color: "#FF7F16",
            weight: 3,
            opacity: 0.45,
            dashArray: "1 8",
            lineJoin: "round",
          }).addTo(layer);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Fetch missing real routes from the backend proxy; redraw as each arrives.
  const fetchRoutes = useCallback(
    async (stops: Stop[]) => {
      const token = (routeReqRef.current += 1);
      const jobs: Promise<void>[] = [];
      for (let i = 1; i < stops.length; i += 1) {
        const prev = stops[i - 1];
        const cur = stops[i];
        const key = routeKey(prev, cur);
        if (routeCacheRef.current.has(key)) continue;
        const mode = normalizeMode(cur.activity.travel_from_previous?.mode);
        const origin = prev.activity.location;
        const destination = cur.activity.location;
        if (!origin || !destination) continue;
        const params = new URLSearchParams({ origin, destination, mode });
        jobs.push(
          fetch(getApiUrl(`/travel-planner/route?${params.toString()}`), {
            headers: buildAuthHeaders(),
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              const points = data?.points;
              if (Array.isArray(points) && points.length > 1) {
                routeCacheRef.current.set(key, points as [number, number][]);
                if (token === routeReqRef.current) drawRoute(stops);
              }
            })
            .catch(() => {
              /* keep the straight fallback for this leg */
            }),
        );
      }
      await Promise.allSettled(jobs);
    },
    [drawRoute],
  );

  // Build markers + route line for a given set of stops.
  const renderDay = useCallback(
    (stops: { activity: TravelActivity; coord: [number, number] }[]) => {
      const map = mapRef.current;
      const layer = layerRef.current;
      if (!map || !layer) return;
      try {
        layer.clearLayers();
        markersRef.current.clear();
        if (!stops.length) return;

        const points = stops.map((s) => s.coord);
        // Draw the route (real road geometry where available, straight
        // fallback otherwise), then fetch any missing real routes.
        drawRoute(stops);
        void fetchRoutes(stops);

        stops.forEach(({ activity, coord }) => {
          const meta = typeMeta(activity.type);
          const marker = L.marker(coord, {
            icon: L.divIcon({
              className: styles.markerWrap,
              html: `<span class="${styles.pin}" style="--pin:${meta.color}">${activity.order}</span>`,
              iconSize: [34, 34],
              iconAnchor: [17, 17],
              popupAnchor: [0, -18],
            }),
            zIndexOffset: activity.order,
          });
          marker.bindPopup(
            `<div class="${styles.popup}"><strong>${activity.order}. ${escapeHtml(
              activity.name,
            )}</strong><span>${escapeHtml(activity.arrive_time || "--:--")} – ${escapeHtml(
              activity.depart_time || "--:--",
            )}</span>${
              activity.note ? `<em>${escapeHtml(activity.note)}</em>` : ""
            }</div>`,
            { closeButton: false, offset: [0, 4] },
          );
          marker.on("click", () => focusStop(activity.order, false));
          marker.addTo(layer);
          markersRef.current.set(activity.order, marker);
        });

        // Sizing must be correct before fitBounds, or markers land off-screen.
        map.invalidateSize(false);
        map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 16 });
      } catch {
        /* ignore Leaflet drawing errors */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Redraw whenever the selected day's stops change (guarded by signature).
  useEffect(() => {
    renderDay(mappableRef.current);
  }, [mapSignature, renderDay]);

  // Keep Leaflet sized after layout / theme changes.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        mapRef.current?.invalidateSize();
      } catch {
        /* ignore */
      }
    }, 80);
    return () => window.clearTimeout(id);
  }, [selectedDayNumber, isDark, loading]);

  // Reset highlight when switching days.
  useEffect(() => {
    setActiveOrder(null);
  }, [selectedDayNumber]);

  // Highlight the active marker; only pan on explicit focus (not hover storms).
  useEffect(() => {
    markersRef.current.forEach((marker, order) => {
      try {
        marker.getElement()?.classList.toggle(styles.pinActive, order === activeOrder);
      } catch {
        /* ignore */
      }
    });
  }, [activeOrder]);

  // Focus a stop: highlight it, optionally scroll the timeline, and pan the map.
  const focusStop = useCallback((order: number, scroll = true) => {
    setActiveOrder(order);
    if (scroll) {
      itemRefs.current
        .get(order)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (flyTimerRef.current) window.clearTimeout(flyTimerRef.current);
    flyTimerRef.current = window.setTimeout(() => {
      const map = mapRef.current;
      const marker = markersRef.current.get(order);
      if (!map || !marker) return;
      try {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), {
          animate: true,
        });
        marker.openPopup();
      } catch {
        /* ignore */
      }
    }, 120);
  }, []);

  const dayOptions = useMemo(
    () =>
      (itinerary?.days || []).map((day, index) => ({
        value: dayKey(day, index),
        label: `DAY ${dayKey(day, index)}`,
      })),
    [itinerary],
  );

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <span className={styles.eyebrow}>
            <Route size={13} /> QwenPaw · 智能行程
          </span>
          <h1>{itinerary?.title || "旅行规划"}</h1>
          <p>
            {itinerary?.destination
              ? "点击地图标记或右侧行程，即可在真实路线上逐站查看当天安排。"
              : "在聊天中确认偏好后，自动生成按天路线、时间与可交互地图。"}
          </p>
          {itinerary ? (
            <div className={styles.heroMeta}>
              <span className={styles.metaChip}>
                <MapPin size={14} />
                {itinerary.destination}
              </span>
              <span className={styles.metaChip}>
                <Route size={14} />
                {itinerary.day_count} 天行程
              </span>
              {itinerary.transportation ? (
                <span className={styles.metaChip}>
                  <Navigation size={14} />
                  {TRANSPORT_LABELS[itinerary.transportation] ||
                    itinerary.transportation}
                </span>
              ) : null}
              {itinerary.updated_at ? (
                <span className={styles.metaChipMuted}>
                  更新于 {itinerary.updated_at}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className={styles.heroActions}>
          <Button
            icon={<RefreshCw size={16} />}
            loading={refreshing}
            onClick={() => void loadItinerary(true)}
          >
            刷新行程
          </Button>
          <Button
            type="primary"
            icon={<ArrowRight size={16} />}
            onClick={() => navigate("/chat")}
          >
            去 Chat 规划
          </Button>
        </div>
      </section>

      {loading ? (
        <div className={styles.loading}>
          <Spin size="large" />
        </div>
      ) : !itinerary ? (
        <section className={styles.emptyState}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有可展示的旅行行程"
          >
            <Button type="primary" onClick={() => navigate("/chat")}>
              在 Chat 中开始规划
            </Button>
          </Empty>
          <p>例如：我计划下周去澳门三天，喜欢美食和人文景点，预算中等。</p>
        </section>
      ) : (
        <section className={styles.workspace}>
          <aside className={styles.daysPanel}>
            <div className={styles.panelHeading}>
              <div>
                <Route size={16} />
                <span>每日行程</span>
              </div>
            </div>
            <div className={styles.dayList}>
              {itinerary.days.map((day, index) => {
                const key = dayKey(day, index);
                const active = selectedDay
                  ? dayKey(selectedDay, itinerary.days.indexOf(selectedDay)) ===
                    key
                  : false;
                return (
                  <button
                    className={`${styles.dayCard}${
                      active ? ` ${styles.dayCardActive}` : ""
                    }`}
                    key={key}
                    onClick={() => setSelectedDayNumber(key)}
                  >
                    <span className={styles.dayNumber}>DAY {key}</span>
                    <strong>{stripDayPrefix(day.title)}</strong>
                    <span className={styles.dayStat}>
                      <MapPin size={12} />
                      {day.activities.length} 站
                      <span className={styles.dot} />
                      <Clock3 size={12} />
                      {day.total_travel_text || "待生成"}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className={styles.mapPanel}>
            <div className={styles.mapBar}>
              <div className={styles.mapBarLeft}>
                <Segmented
                  size="small"
                  value={selectedDayNumber ?? undefined}
                  options={dayOptions}
                  onChange={(value) => setSelectedDayNumber(Number(value))}
                />
              </div>
              <div className={styles.mapBarRight}>
                {selectedDay?.day_start && selectedDay?.day_end ? (
                  <Tag className={styles.statTag} icon={<Clock3 size={12} />}>
                    {selectedDay.day_start}–{selectedDay.day_end}
                  </Tag>
                ) : null}
                {selectedDay?.total_distance_meters ? (
                  <Tag className={styles.statTag} icon={<Route size={12} />}>
                    {formatDistance(selectedDay.total_distance_meters)}
                  </Tag>
                ) : null}
                {selectedDay?.total_travel_text ? (
                  <Tag className={styles.statTag} icon={<Navigation size={12} />}>
                    在途 {selectedDay.total_travel_text}
                  </Tag>
                ) : null}
              </div>
            </div>
            <div className={styles.mapCanvas}>
              <div ref={attachMap} className={styles.mapNode} />
              {!mappable.length ? (
                <div className={styles.noMap}>
                  <MapPin size={28} />
                  <span>该日行程暂无坐标，无法绘制路线</span>
                </div>
              ) : null}
              {tilesFailed ? (
                <div className={styles.tileWarn}>
                  底图瓦片加载失败，仅显示路线与标记
                </div>
              ) : null}
              <div className={styles.legend}>
                {Object.entries(TYPE_META).map(([key, meta]) => (
                  <span className={styles.legendItem} key={key}>
                    <i style={{ background: meta.color }} />
                    {meta.label}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <aside className={styles.detailsPanel}>
            <div className={styles.panelHeading}>
              <div>
                <Navigation size={16} />
                <span>当天安排</span>
              </div>
              <small>{selectedDay?.activities.length || 0} 个地点</small>
            </div>
            <div className={styles.timeline}>
              {selectedDay?.activities.map((activity) => {
                const meta = typeMeta(activity.type);
                const Icon = meta.icon;
                const leg = activity.travel_from_previous;
                const active = activity.order === activeOrder;
                return (
                  <div
                    className={styles.activityBlock}
                    key={`${activity.order}-${activity.name}`}
                  >
                    {leg ? (
                      <div className={styles.leg}>
                        {leg.mode === "walking" ? (
                          <Footprints size={13} />
                        ) : (
                          <Bus size={13} />
                        )}
                        <span>
                          {TRANSPORT_LABELS[leg.mode || ""] || "前往"}
                          {leg.duration_text ? ` · ${leg.duration_text}` : ""}
                          {leg.distance_meters
                            ? ` · ${formatDistance(leg.distance_meters)}`
                            : ""}
                        </span>
                      </div>
                    ) : null}
                    <div
                      ref={(node) => {
                        if (node) itemRefs.current.set(activity.order, node);
                        else itemRefs.current.delete(activity.order);
                      }}
                      className={`${styles.activity}${
                        active ? ` ${styles.activityActive}` : ""
                      }`}
                      onClick={() => focusStop(activity.order, false)}
                    >
                      <span
                        className={styles.stopNumber}
                        style={{ background: meta.color }}
                      >
                        {activity.order}
                      </span>
                      <div className={styles.activityBody}>
                        <div className={styles.activityHead}>
                          <strong>{activity.name}</strong>
                          <span
                            className={styles.typeTag}
                            style={{ color: meta.color }}
                          >
                            <Icon size={12} />
                            {meta.label}
                          </span>
                        </div>
                        <span className={styles.activityTime}>
                          <Clock3 size={12} />
                          {activity.arrive_time || "--:--"}–
                          {activity.depart_time || "--:--"}
                          {activity.stay_minutes
                            ? ` · 停留 ${activity.stay_minutes} 分钟`
                            : ""}
                        </span>
                        {activity.note ? (
                          <em className={styles.note}>{activity.note}</em>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {error ? <p className={styles.error}>{error}</p> : null}
          </aside>
        </section>
      )}
    </main>
  );
}
