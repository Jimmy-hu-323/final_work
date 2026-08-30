import type { LocalTrip, TripPosition, TripStop } from "./runtime";
import { distanceMeters } from "./tripJourney";

export const GUIDE_VISITS_KEY = "lensgo_trip_guide_visits_v1";
export const GUIDE_OPEN_EVENT = "lensgo-trip-guide-open";
export const GUIDE_POSITION_EVENT = "lensgo-trip-guide-position";
export const GUIDE_ERROR_EVENT = "lensgo-trip-guide-error";
export const GUIDE_DEPARTURE_EVENT = "lensgo-trip-guide-departure";
export const TRIPS_CHANGED_EVENT = "lensgo-trips-changed";
export const GUIDE_DWELL_MS = 20_000;
export const GUIDE_MAX_FIX_AGE_MS = 30_000;

export type GuideContext = {
  tripId: string;
  tripTitle: string;
  stopId: string;
  stopName: string;
  day: number;
  latitude: number;
  longitude: number;
  status: "loading" | "ready" | "error";
};

export const GUIDE_OPTIONS = [
  "历史背景", "文化故事", "建筑特色", "附近美食", "拍照打卡点", "下一站路线",
] as const;

export const GUIDE_FOLLOW_UP = "你还想了解哪些方面？可以点击选项，或直接回复编号、文字：\n\n" +
  GUIDE_OPTIONS.map((label, i) => `${i + 1}. [${label}](#lensgo-guide-${i + 1})`).join("\n");

export function guideQuestion(text: string): string {
  const match = text.trim().match(/^(?:选|第)?([1-6])(?:项|个)?[.。]?$/);
  return match ? GUIDE_OPTIONS[Number(match[1]) - 1] : text;
}

export function nearbyGuideKind(text: string): "food" | "photo" | null {
  const question = guideQuestion(text);
  if (/不要|不想|不用|不找/.test(question)) return null;
  if (/拍照|打卡|出片|机位|攝影|摄影/.test(question)) return "photo";
  if (/美食|餐[厅馆]|食物|吃[饭的点]|找吃|小吃|咖啡|饿了|覓食|觅食/.test(question)) return "food";
  return null;
}

export function guideStopKey(tripId: string, stop: TripStop): string {
  return JSON.stringify([tripId, stop.day || 1, stop.id]);
}

export function isFreshGuidePosition(position: TripPosition, now = Date.now()): boolean {
  return Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90 &&
    Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180 &&
    Number.isFinite(position.accuracy) && position.accuracy > 0 && position.accuracy <= 80 &&
    Number.isFinite(position.recordedAt) && now - position.recordedAt <= GUIDE_MAX_FIX_AGE_MS &&
    position.recordedAt <= now + 5_000;
}

export class TripArrivalTracker {
  private candidate: { key: string; first: number; last: number } | null = null;

  reset() { this.candidate = null; }

  observe(trip: LocalTrip, position: TripPosition, visited: Set<string>, now = Date.now()) {
    if (trip.status !== "active" || !isFreshGuidePosition(position, now)) {
      this.reset();
      return null;
    }
    // Starting the journey enables location guidance, not a mandatory route.
    // Match all recorded stops regardless of planned day or route progress.
    const original = trip.stops || [];
    const extra = [...(trip.guidePlaces || []), ...(trip.guideDestination ? [trip.guideDestination] : [])];
    const seen = new Set(original.map((stop) => guideStopKey(trip.id, stop)));
    const candidates = original.map((stop, index) => ({ stop, index }));
    for (const stop of extra) {
      const key = guideStopKey(trip.id, stop);
      if (!seen.has(key)) { seen.add(key); candidates.push({ stop, index: -1 }); }
    }
    const nearest = candidates.flatMap(({ stop, index }) => {
      if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude) ||
          Math.abs(stop.latitude!) > 90 || Math.abs(stop.longitude!) > 180) return [];
      const radius = Math.min(200, Math.max(100, stop.radiusM || 120));
      const distance = distanceMeters(position, {
        latitude: stop.latitude!, longitude: stop.longitude!,
      });
      return distance <= radius && position.accuracy <= radius / 2
        ? [{ stop, index, distance }] : [];
    }).sort((left, right) => left.distance - right.distance)[0];
    if (!nearest) { this.reset(); return null; }
    const { stop, index } = nearest;
    const key = guideStopKey(trip.id, stop);
    // Select the nearest place BEFORE checking visits. Standing at a place
    // already explained must not cascade into stories for overlapping stops.
    if (visited.has(key)) { this.reset(); return null; }
    if (!this.candidate || this.candidate.key !== key || position.recordedAt - this.candidate.last > 25_000) {
      this.candidate = { key, first: position.recordedAt, last: position.recordedAt };
      return null;
    }
    if (position.recordedAt <= this.candidate.last) return null;
    this.candidate.last = position.recordedAt;
    if (position.recordedAt - this.candidate.first < GUIDE_DWELL_MS) return null;
    this.reset();
    return { key, index, stop };
  }
}

export function guideStoryPrompt(guide: GuideContext, question?: string): string {
  return [
    `你是澳门实地导游。当前景点：${guide.stopName}。`,
    "只回答景点导览，不生成、修改或保存旅行计划，不输出控制 JSON 或内部提示。",
    "区分有据可查的历史与传说；不确定的年代、人名和轶事请明确说明，不编造事实、来源、评分或实时信息。",
    question ? `游客问题：${guideQuestion(question)}` :
      "游客刚到达此景点，请用中文讲述一段约300至500字、适合现场阅读的历史文化故事，结合可以观察到的建筑细节。",
    "直接输出讲解正文，不重复列出追问选项，客户端会在正文后提供选项。",
  ].join("\n");
}

export type NearbyGuidePlace = {
  id: string;
  name: string;
  address: string;
  category: string;
  latitude: number;
  longitude: number;
  distance: number;
  rating: number | null;
};

export type NearbyGuideResult = {
  available: boolean;
  reason?: string;
  items: NearbyGuidePlace[];
  radius: number;
  source: string;
};

const markdownText = (value: string) => value.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&").replace(/[\r\n]+/g, " ");

export function formatGuideNearby(result: NearbyGuideResult, kind: "food" | "photo", live: boolean): string {
  if (!result.available) return result.reason || "附近地点服务暂不可用，请稍后回复同一个选项重试。";
  const topic = kind === "food" ? "餐厅" : "拍照地点";
  if (!result.items.length) return `在${live ? "当前位置" : "本景点"}附近 ${result.radius} 米内没有找到可核实的${topic}，暂不推荐未经确认的地点。`;
  const rows = result.items.map((place, i) => {
    const rating = place.rating === null ? "暂无评分" : `高德评分 ${place.rating.toFixed(1)}/5`;
    const reason = kind === "food" ? "按地图评分优先、距离其次筛选；营业状态和价格请到店前确认。" :
      "这是地图中的景点候选；可尝试建筑全景或环境人像，拍摄时避免挡路并遵守现场规定。";
    const uri = `https://uri.amap.com/marker?position=${place.longitude},${place.latitude}&name=${encodeURIComponent(place.name)}&coordinate=gaode`;
    return `${i + 1}. **${markdownText(place.name)}** — ${rating}，直线距离约 ${Math.round(place.distance)} 米\n\n   ${markdownText(place.address || "地址未提供")} · ${markdownText(place.category)}\n\n   ${reason} [查看位置](${uri})`;
  });
  return `以下为${live ? "手机最新位置" : "当前景点坐标（手机位置已过期，未冒充实时定位）"}附近 ${result.radius} 米的${topic}。来源：${markdownText(result.source)}。${kind === "photo" ? "景点评分不等同于出片效果评分。" : ""}\n\n${rows.join("\n\n")}\n\n你想进一步了解哪一个地点？`;
}
