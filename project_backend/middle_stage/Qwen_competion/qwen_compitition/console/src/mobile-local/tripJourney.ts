import type { LocalTrip, TripPosition, TripStop } from "./runtime";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type CrowdReading = {
  people_count: number;
  crowd_level: number;
  observed_at: string;
  batch_id: string;
  note?: string | null;
};

export type CrowdPlace = {
  region_id: string;
  name: string;
  name_en?: string | null;
  aliases: string[];
  center: [number, number] | null;
  radius_m?: number | null;
  reading: CrowdReading | null;
};

export type CrowdDensityResponse = {
  generated_at: string;
  count: number;
  items: CrowdPlace[];
};

export type CrowdServiceConfig = {
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
};

type StoredCrowdServiceConfig = {
  baseUrl: string;
  hasApiKey: boolean;
};

export type StopCrowdSnapshot = {
  place: CrowdPlace;
  reading: CrowdReading | null;
  stale: boolean;
  ageMinutes?: number;
};

type NativeLocationPayload = {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: number;
};

const CROWD_CONFIG_KEY = "lensgo_crowd_service_v1";
// Current development machine's LAN address. Users can change this in
// Settings when DHCP assigns the publisher machine a different address.
const DEFAULT_CROWD_URL = "http://10.9.88.6:18099";
let browserCrowdApiKey = "";
export const CROWD_STALE_MINUTES = 30;
export const CROWD_LEVEL_LABELS = ["空旷", "较少", "适中", "拥挤", "非常拥挤"];

declare global {
  interface Window {
    LensGoNative?: {
      speakAndNotify: (title: string, message: string) => void;
      startLocationUpdates?: () => boolean;
      stopLocationUpdates?: () => void;
      capturePhotoToGallery?: () => boolean;
    };
  }
}

function nativePayloadToTripPosition(
  payload: NativeLocationPayload,
): TripPosition {
  const converted = wgs84ToGcj02(payload.latitude, payload.longitude);
  return {
    latitude: converted.latitude,
    longitude: converted.longitude,
    accuracy: Number(payload.accuracy) || 0,
    recordedAt: Number(payload.recordedAt) || Date.now(),
  };
}

let nativeLocationConsumers = 0;

export function startNativeLocationWatch(
  onPosition: (position: TripPosition) => void,
  onError: (message: string) => void,
): (() => void) | null {
  const bridge = window.LensGoNative;
  if (!bridge?.startLocationUpdates) return null;
  const positionListener = (event: Event) => {
    const payload = (event as CustomEvent<NativeLocationPayload>).detail;
    if (
      !payload ||
      !Number.isFinite(payload.latitude) ||
      !Number.isFinite(payload.longitude)
    ) {
      return;
    }
    onPosition(nativePayloadToTripPosition(payload));
  };
  const errorListener = (event: Event) => {
    onError(
      String((event as CustomEvent<string>).detail || "无法获取手机位置"),
    );
  };
  window.addEventListener("lensgo-native-location", positionListener);
  window.addEventListener("lensgo-native-location-error", errorListener);
  if (nativeLocationConsumers++ === 0) bridge.startLocationUpdates();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    window.removeEventListener("lensgo-native-location", positionListener);
    window.removeEventListener("lensgo-native-location-error", errorListener);
    if (--nativeLocationConsumers === 0) bridge.stopLocationUpdates?.();
  };
}

export function requestInitialTripPosition(
  timeoutMs = 30_000,
): Promise<TripPosition> {
  return new Promise((resolve, reject) => {
    let cleanup: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cleanup?.();
      reject(new Error("定位超时，请确认系统定位已开启后重试"));
    }, timeoutMs);
    cleanup = startNativeLocationWatch(
      (position) => {
        if (
          Date.now() - position.recordedAt > 30_000 ||
          position.accuracy <= 0 ||
          position.accuracy > 80
        )
          return;
        window.clearTimeout(timer);
        cleanup?.();
        resolve(position);
      },
      (error) => {
        window.clearTimeout(timer);
        cleanup?.();
        reject(new Error(error));
      },
    );
    if (!cleanup) {
      window.clearTimeout(timer);
      reject(new Error("当前环境没有原生定位桥接"));
    }
  });
}

function loadLegacyCrowdConfig(): { baseUrl: string; apiKey: string } {
  try {
    const value = JSON.parse(
      localStorage.getItem(CROWD_CONFIG_KEY) || "{}",
    ) as Partial<CrowdServiceConfig> & { readToken?: string };
    const migrated = {
      baseUrl: (value.baseUrl || DEFAULT_CROWD_URL).replace(/\/+$/, ""),
      apiKey: value.apiKey || value.readToken || "",
    };
    // Never retain credentials in WebView/browser storage. Existing installs
    // are migrated to the native app-private settings on the next load.
    localStorage.setItem(
      CROWD_CONFIG_KEY,
      JSON.stringify({ baseUrl: migrated.baseUrl }),
    );
    return migrated;
  } catch {
    localStorage.setItem(
      CROWD_CONFIG_KEY,
      JSON.stringify({ baseUrl: DEFAULT_CROWD_URL }),
    );
    return { baseUrl: DEFAULT_CROWD_URL, apiKey: "" };
  }
}

export async function loadCrowdServiceConfig(): Promise<CrowdServiceConfig> {
  const legacy = loadLegacyCrowdConfig();
  if (!isTauri()) {
    if (!browserCrowdApiKey && legacy.apiKey)
      browserCrowdApiKey = legacy.apiKey;
    return {
      baseUrl: legacy.baseUrl,
      apiKey: "",
      hasApiKey: Boolean(browserCrowdApiKey),
    };
  }

  let stored = await invoke<StoredCrowdServiceConfig>(
    "mobile_load_crowd_settings",
  );
  if (!stored.baseUrl || (!stored.hasApiKey && legacy.apiKey)) {
    stored = await invoke<StoredCrowdServiceConfig>(
      "mobile_save_crowd_settings",
      {
        settings: {
          baseUrl: stored.baseUrl || legacy.baseUrl,
          apiKey:
            !stored.hasApiKey && legacy.apiKey ? legacy.apiKey : undefined,
        },
      },
    );
  }
  return {
    baseUrl: stored.baseUrl || legacy.baseUrl,
    apiKey: "",
    hasApiKey: stored.hasApiKey,
  };
}

export async function saveCrowdServiceConfig(
  config: CrowdServiceConfig,
  clearApiKey = false,
): Promise<CrowdServiceConfig> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(baseUrl)) {
    throw new Error("客流服务地址必须是完整的 HTTP 或 HTTPS 地址");
  }
  const apiKey = config.apiKey.trim();
  if (isTauri()) {
    const stored = await invoke<StoredCrowdServiceConfig>(
      "mobile_save_crowd_settings",
      {
        settings: {
          baseUrl,
          apiKey: apiKey || undefined,
          clearApiKey,
        },
      },
    );
    localStorage.setItem(CROWD_CONFIG_KEY, JSON.stringify({ baseUrl }));
    return {
      baseUrl: stored.baseUrl,
      apiKey: "",
      hasApiKey: stored.hasApiKey,
    };
  }
  if (clearApiKey) browserCrowdApiKey = "";
  else if (apiKey) browserCrowdApiKey = apiKey;
  const normalized: CrowdServiceConfig = {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: "",
    hasApiKey: Boolean(browserCrowdApiKey),
  };
  localStorage.setItem(
    CROWD_CONFIG_KEY,
    JSON.stringify({ baseUrl: normalized.baseUrl }),
  );
  return normalized;
}

export async function fetchCrowdPlaces(
  config?: CrowdServiceConfig,
): Promise<CrowdDensityResponse> {
  if (isTauri()) {
    // Also performs the one-time migration from the legacy WebView config.
    await loadCrowdServiceConfig();
    return invoke<CrowdDensityResponse>("mobile_fetch_crowd_places");
  }
  const resolved = config || (await loadCrowdServiceConfig());
  if (!/^https?:\/\/[^/]+/i.test(resolved.baseUrl)) {
    throw new Error("客流服务地址必须是完整的 HTTP 或 HTTPS 地址");
  }
  const headers: HeadersInit = { Accept: "application/json" };
  const apiKey = resolved.apiKey.trim() || browserCrowdApiKey;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(
    `${resolved.baseUrl}/api/density/latest?city_id=macau&level=poi&include_empty=1`,
    { headers },
  );
  if (!response.ok) {
    const text = (await response.text()).slice(0, 240);
    throw new Error(
      `客流服务返回 HTTP ${response.status}${text ? `：${text}` : ""}`,
    );
  }
  const payload = (await response.json()) as CrowdDensityResponse;
  if (!Array.isArray(payload.items)) {
    throw new Error("客流服务返回格式不正确");
  }
  return payload;
}

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s·•\-—_()（）【】[\]「」“”"'.,，。]/g, "")
    .replace(/澳门|macau|macao/g, "");
}

function placeNames(place: CrowdPlace): string[] {
  return [place.name, place.name_en || "", ...(place.aliases || [])]
    .map(normalizedName)
    .filter(Boolean);
}

export function matchStopToCrowdPlace(
  stop: TripStop,
  places: CrowdPlace[],
): CrowdPlace | undefined {
  if (stop.crowdRegionId) {
    const exact = places.find(
      (place) => place.region_id === stop.crowdRegionId,
    );
    if (exact) return exact;
  }
  const target = normalizedName(stop.name);
  if (!target) return undefined;
  return places.find((place) =>
    placeNames(place).some(
      (candidate) =>
        candidate === target ||
        (candidate.length >= 3 &&
          target.length >= 3 &&
          (candidate.includes(target) || target.includes(candidate))),
    ),
  );
}

export function crowdSnapshot(
  stop: TripStop,
  places: CrowdPlace[],
  now = Date.now(),
): StopCrowdSnapshot | undefined {
  const place = matchStopToCrowdPlace(stop, places);
  if (!place) return undefined;
  if (!place.reading) return { place, reading: null, stale: false };
  const observedAt = Date.parse(place.reading.observed_at);
  const ageMinutes = Number.isFinite(observedAt)
    ? Math.max(0, (now - observedAt) / 60_000)
    : Number.POSITIVE_INFINITY;
  return {
    place,
    reading: place.reading,
    stale: ageMinutes > CROWD_STALE_MINUTES,
    ageMinutes,
  };
}

export function crowdLabel(level?: number): string {
  if (level === undefined || level < 0) return "暂无数据";
  return CROWD_LEVEL_LABELS[level] || `等级 ${level}`;
}

export function formatCrowdReminder(
  stop: TripStop,
  snapshot?: StopCrowdSnapshot,
): string {
  if (!snapshot?.reading) {
    return `下一站是${stop.name}，客流服务暂时没有该景点的人数数据。是否按现有行程继续？`;
  }
  if (snapshot.stale) {
    const age = Math.round(snapshot.ageMinutes || 0);
    return `下一站是${stop.name}。最近一次记录为${snapshot.reading.people_count}人，但数据已超过${age}分钟，仅供参考。是否调整后续行程？`;
  }
  return `下一站是${stop.name}，当前约${
    snapshot.reading.people_count
  }人，客流${crowdLabel(
    snapshot.reading.crowd_level,
  )}。是否按实时人流调整后续行程？`;
}

export function announceTripUpdate(title: string, message: string): void {
  if (window.LensGoNative?.speakAndNotify) {
    window.LensGoNative.speakAndNotify(title, message);
    return;
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "zh-CN";
    window.speechSynthesis.speak(utterance);
  }
}

export function extractTripPlan(
  modelContent: string,
  fallbackPlaces: CrowdPlace[],
): { content: string; stops: TripStop[] } {
  const start = modelContent.indexOf("{");
  const end = modelContent.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(modelContent.slice(start, end + 1)) as {
        markdown?: unknown;
        stops?: unknown;
      };
      const stops = Array.isArray(parsed.stops)
        ? parsed.stops
            .map((raw, index) => normalizeStop(raw, index, fallbackPlaces))
            .filter((stop): stop is TripStop => Boolean(stop))
        : [];
      if (typeof parsed.markdown === "string" && parsed.markdown.trim()) {
        return { content: parsed.markdown.trim(), stops };
      }
    } catch {
      // Older or non-compliant models can still produce a usable Markdown trip.
    }
  }
  return {
    content: modelContent,
    stops: inferStopsFromMarkdown(modelContent, fallbackPlaces),
  };
}

function normalizeStop(
  raw: unknown,
  index: number,
  places: CrowdPlace[],
): TripStop | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const regionId =
    typeof value.crowdRegionId === "string" ? value.crowdRegionId : undefined;
  const matched =
    places.find((place) => place.region_id === regionId) ||
    matchStopToCrowdPlace({ id: "", name }, places);
  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : `stop-${index + 1}`,
    name,
    day:
      typeof value.day === "number" && Number.isFinite(value.day)
        ? Math.max(1, Math.round(value.day))
        : undefined,
    time: typeof value.time === "string" ? value.time : undefined,
    note: typeof value.note === "string" ? value.note : undefined,
    crowdRegionId: matched?.region_id || regionId,
    longitude:
      matched?.center?.[0] ??
      (typeof value.longitude === "number" ? value.longitude : undefined),
    latitude:
      matched?.center?.[1] ??
      (typeof value.latitude === "number" ? value.latitude : undefined),
    radiusM: matched?.radius_m || undefined,
  };
}

export function inferStopsFromMarkdown(
  content: string,
  places: CrowdPlace[],
): TripStop[] {
  const dayMarkers: Array<{ position: number; day: number }> = [];
  const chineseDays: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
  };
  for (const match of content.matchAll(/第\s*(\d+|[一二三四五六七])\s*天/g)) {
    const rawDay = match[1];
    dayMarkers.push({
      position: match.index,
      day: Number(rawDay) || chineseDays[rawDay] || 1,
    });
  }
  return places
    .map((place) => {
      const names = [place.name, place.name_en || "", ...(place.aliases || [])];
      const positions = names
        .filter(Boolean)
        .map((name) => content.toLowerCase().indexOf(name.toLowerCase()))
        .filter((position) => position >= 0);
      return {
        place,
        position: positions.length ? Math.min(...positions) : -1,
      };
    })
    .filter(({ position }) => position >= 0)
    .sort((left, right) => left.position - right.position)
    .map(({ place, position }, index) => ({
      id: `stop-${index + 1}`,
      name: place.name,
      day:
        [...dayMarkers].reverse().find((marker) => marker.position <= position)
          ?.day || 1,
      crowdRegionId: place.region_id,
      longitude: place.center?.[0],
      latitude: place.center?.[1],
      radiusM: place.radius_m || undefined,
    }));
}

export function crowdCatalogForPrompt(places: CrowdPlace[]): string {
  return JSON.stringify(
    places.map((place) => ({
      id: place.region_id,
      name: place.name,
      aliases: place.aliases,
      longitude: place.center?.[0],
      latitude: place.center?.[1],
    })),
  );
}

function outOfChina(latitude: number, longitude: number): boolean {
  return (
    longitude < 72.004 ||
    longitude > 137.8347 ||
    latitude < 0.8293 ||
    latitude > 55.8271
  );
}

function transformLatitude(x: number, y: number): number {
  let result =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  result +=
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  result +=
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  result +=
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) *
      2) /
    3;
  return result;
}

function transformLongitude(x: number, y: number): number {
  let result =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  result +=
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  result +=
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  result +=
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) *
      2) /
    3;
  return result;
}

export function wgs84ToGcj02(
  latitude: number,
  longitude: number,
): { latitude: number; longitude: number } {
  if (outOfChina(latitude, longitude)) return { latitude, longitude };
  const a = 6378245;
  const eccentricity = 0.006693421622965943;
  let deltaLat = transformLatitude(longitude - 105, latitude - 35);
  let deltaLng = transformLongitude(longitude - 105, latitude - 35);
  const radLat = (latitude / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - eccentricity * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  deltaLat =
    (deltaLat * 180) /
    (((a * (1 - eccentricity)) / (magic * sqrtMagic)) * Math.PI);
  deltaLng = (deltaLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { latitude: latitude + deltaLat, longitude: longitude + deltaLng };
}

export function toTripPosition(position: GeolocationPosition): TripPosition {
  const converted = wgs84ToGcj02(
    position.coords.latitude,
    position.coords.longitude,
  );
  return {
    ...converted,
    accuracy: position.coords.accuracy,
    recordedAt: position.timestamp || Date.now(),
  };
}

export function distanceMeters(
  left: Pick<TripPosition, "latitude" | "longitude">,
  right: { latitude: number; longitude: number },
): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const deltaLat = radians(right.latitude - left.latitude);
  const deltaLng = radians(right.longitude - left.longitude);
  const lat1 = radians(left.latitude);
  const lat2 = radians(right.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

export function locateTripStop(
  trip: LocalTrip,
  position: TripPosition,
): { index: number; distance: number } | null {
  const candidates = (trip.stops || [])
    .map((stop, index) => {
      if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) {
        return null;
      }
      return {
        index,
        distance: distanceMeters(position, {
          latitude: stop.latitude as number,
          longitude: stop.longitude as number,
        }),
        radius: Math.max(180, (stop.radiusM || 100) * 2),
      };
    })
    .filter(
      (value): value is { index: number; distance: number; radius: number } =>
        Boolean(value),
    )
    .sort((left, right) => left.distance - right.distance);
  const nearest = candidates[0];
  return nearest && nearest.distance <= nearest.radius
    ? { index: nearest.index, distance: nearest.distance }
    : null;
}

export function reorderRemainingStops(
  trip: LocalTrip,
  places: CrowdPlace[],
): TripStop[] {
  const stops = [...(trip.stops || [])];
  const currentIndex = trip.currentStopIndex ?? -1;
  const fixed = stops.slice(0, currentIndex + 1);
  const remaining = stops.slice(currentIndex + 1);
  const activeDay =
    stops[currentIndex]?.day ?? stops[currentIndex + 1]?.day ?? 1;
  const todayRemaining = remaining.filter(
    (stop) => (stop.day ?? activeDay) === activeDay,
  );
  const laterDays = remaining.filter(
    (stop) => (stop.day ?? activeDay) !== activeDay,
  );
  todayRemaining.sort((left, right) => {
    const leftSnapshot = crowdSnapshot(left, places);
    const rightSnapshot = crowdSnapshot(right, places);
    const score = (snapshot?: StopCrowdSnapshot) => {
      if (!snapshot?.reading || snapshot.stale) return 10_000;
      return (
        snapshot.reading.crowd_level * 2_000 + snapshot.reading.people_count
      );
    };
    return score(leftSnapshot) - score(rightSnapshot);
  });
  return [...fixed, ...todayRemaining, ...laterDays];
}

export function revisedTripMarkdown(
  original: string,
  stops: TripStop[],
  currentIndex: number,
): string {
  const remaining = stops
    .slice(currentIndex + 1)
    .map(
      (stop, index) =>
        `${index + 1}. ${stop.time ? `${stop.time} ` : ""}${stop.name}`,
    )
    .join("\n");
  return `## 已按实时客流更新今日后续行程\n\n${
    remaining || "今日景点已全部完成。"
  }\n\n> 更新时间：${new Date().toLocaleString(
    "zh-CN",
  )}；已完成的地点不会改动。\n\n---\n\n${original}`;
}

export function geolocationErrorMessage(
  error: GeolocationPositionError,
): string {
  if (error.code === error.PERMISSION_DENIED) {
    return "定位权限未开启，请在系统设置中允许 LensGo 使用位置信息";
  }
  if (error.code === error.POSITION_UNAVAILABLE) {
    return "暂时无法取得位置，请确认手机定位服务已开启";
  }
  if (error.code === error.TIMEOUT) return "定位超时，请到开阔处重试";
  return error.message || "定位失败";
}
