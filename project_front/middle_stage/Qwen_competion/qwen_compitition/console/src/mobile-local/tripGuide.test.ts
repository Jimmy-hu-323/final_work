import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  TripArrivalTracker, guideStopKey, guideQuestion,
  nearbyGuideKind, formatGuideNearby, GUIDE_DWELL_MS, GUIDE_VISITS_KEY, GUIDE_DEPARTURE_EVENT,
} from "./tripGuide";
import { loadTrips, saveTrips, type LocalTrip, type TripPosition, type MobileSettings } from "./runtime";
import { wgs84ToGcj02, startNativeLocationWatch } from "./tripJourney";
import { CHAT_SESSIONS_KEY, updateChatSessions, loadChatSessionState } from "./chatSessions";
import { startTripGuideRuntime } from "./tripGuideRuntime";
import { streamQwenPawChat } from "./qwenpaw";

vi.mock("./qwenpaw", () => ({
  loadQwenPawSessionId: () => "legacy-session",
  streamQwenPawChat: vi.fn(async () => "这是可见的景点故事。<!-- 不可见内部内容 -->"),
}));

const now = Date.UTC(2026, 7, 28, 4);
const coordinates = wgs84ToGcj02(22.194, 113.541);
const trip = (): LocalTrip => ({
  id: "test-trip", title: "测试旅程", request: "", content: "", createdAt: now,
  status: "active", startedAt: now, currentStopIndex: -1,
  stops: [
    { id: "s1", name: "景点一", day: 1, ...coordinates },
    { id: "s2", name: "景点二", day: 1, latitude: coordinates.latitude + 0.02, longitude: coordinates.longitude },
    { id: "s1", name: "次日景点", day: 2, ...coordinates },
  ],
});
const fix = (at = now, extra = {}): TripPosition => ({ ...coordinates, accuracy: 5, recordedAt: at, ...extra });

describe("journey arrival rules", () => {
  it("guides known places outside the itinerary without inventing route progress", () => {
    const t = trip();
    t.stops = [{ ...t.stops![1] }];
    t.guidePlaces = [{ id: "outside-plan", name: "自由探索景点", ...coordinates }];
    t.guideDestination = t.stops[0];
    const before = JSON.stringify(t);
    const tracker = new TripArrivalTracker();
    tracker.observe(t, fix(), new Set(), now);
    const arrival = tracker.observe(t, fix(now + 20_000), new Set(), now + 20_000)!;
    expect(arrival.stop.id).toBe("outside-plan");
    expect(arrival.index).toBe(-1);
    expect(JSON.stringify(t)).toBe(before);
  });
  it("requires fresh consecutive fixes and dwell, then advances only once", () => {
    const tracker = new TripArrivalTracker();
    const t = trip();
    const visited = new Set<string>();
    expect(tracker.observe(t, fix(), visited, now)).toBeNull();
    expect(tracker.observe(t, fix(now + 10_000), visited, now + 10_000)).toBeNull();
    const arrival = tracker.observe(t, fix(now + GUIDE_DWELL_MS), visited, now + GUIDE_DWELL_MS)!;
    expect(arrival.stop.id).toBe("s1");
    visited.add(arrival.key);
    expect(tracker.observe(t, fix(now + 30_000), visited, now + 30_000)).toBeNull();
    expect(tracker.observe(t, fix(now + 50_000), visited, now + 50_000)).toBeNull();
  });

  it("rejects inaccurate, old, future and duplicate fixes, and resets when leaving", () => {
    const tracker = new TripArrivalTracker();
    const t = trip();
    const visited = new Set<string>();
    for (const position of [fix(now - 31_000), fix(now + 10_000), fix(now, { accuracy: 500 }), fix(now, { latitude: NaN })]) {
      expect(tracker.observe(t, position, visited, now)).toBeNull();
    }
    tracker.observe(t, fix(), visited, now);
    expect(tracker.observe(t, fix(), visited, now + 20_000)).toBeNull();
    tracker.observe(t, fix(now + 10_000, { latitude: 23 }), visited, now + 10_000);
    expect(tracker.observe(t, fix(now + 20_000), visited, now + 20_000)).toBeNull();
    expect(tracker.observe({ ...t, status: "completed" }, fix(now + 40_000), visited, now + 40_000)).toBeNull();
  });

  it("guides a later-day stop before the planned first stop, regardless of route progress", () => {
    const t = trip();
    t.stops![1].day = 2;
    t.currentStopIndex = 2;
    const original = JSON.stringify(t);
    expect(guideStopKey(t.id, t.stops![0])).not.toBe(guideStopKey(t.id, t.stops![2]));
    const tracker = new TripArrivalTracker();
    const elsewhere = fix(now, { latitude: t.stops![1].latitude });
    tracker.observe(t, elsewhere, new Set(), now);
    const arrival = tracker.observe(t, { ...elsewhere, recordedAt: now + 20_000 }, new Set(), now + 20_000)!;
    expect(arrival.stop.id).toBe("s2");
    const visited = new Set([arrival.key]);
    tracker.observe(t, fix(now + 30_000), visited, now + 30_000);
    expect(tracker.observe(t, fix(now + 50_000), visited, now + 50_000)?.stop.id).toBe("s1");
    expect(JSON.stringify(t)).toBe(original);
  });

  it("can revisit an earlier-day unvisited stop after several calendar days", () => {
    const tracker = new TripArrivalTracker();
    const t = trip();
    const later = now + 3 * 86400_000;
    tracker.observe(t, fix(later), new Set(), later);
    expect(tracker.observe(t, fix(later + 20_000), new Set(), later + 20_000)?.stop.id).toBe("s1");
  });

  it("chooses the nearest overlapping stop and does not cascade after it is visited", () => {
    const t = trip();
    t.stops = [
      { ...t.stops![0], id: "far", latitude: coordinates.latitude + 0.0005 },
      { ...t.stops![0], id: "near" },
    ];
    const tracker = new TripArrivalTracker();
    const visited = new Set<string>();
    tracker.observe(t, fix(), visited, now);
    const arrival = tracker.observe(t, fix(now + 20_000), visited, now + 20_000)!;
    expect(arrival.stop.id).toBe("near");
    visited.add(arrival.key);
    tracker.observe(t, fix(now + 30_000), visited, now + 30_000);
    expect(tracker.observe(t, fix(now + 50_000), visited, now + 50_000)).toBeNull();
    const farFix = (at: number) => fix(at, { latitude: t.stops![0].latitude });
    tracker.observe(t, farFix(now + 60_000), visited, now + 60_000);
    expect(tracker.observe(t, farFix(now + 80_000), visited, now + 80_000)?.stop.id).toBe("far");
  });

  it("still requires an active trip and restarts dwell when the nearest place changes", () => {
    const tracker = new TripArrivalTracker();
    const t = trip();
    for (const status of ["planned", "completed"] as const) {
      tracker.observe({ ...t, status }, fix(), new Set(), now);
      expect(tracker.observe({ ...t, status }, fix(now + 20_000), new Set(), now + 20_000)).toBeNull();
    }
    tracker.observe(t, fix(), new Set(), now);
    const elsewhere = (at: number) => fix(at, { latitude: t.stops![1].latitude });
    expect(tracker.observe(t, elsewhere(now + 15_000), new Set(), now + 15_000)).toBeNull();
    expect(tracker.observe(t, elsewhere(now + 25_000), new Set(), now + 25_000)).toBeNull();
    expect(tracker.observe(t, elsewhere(now + 35_000), new Set(), now + 35_000)?.stop.id).toBe("s2");
  });

  it("routes numbered or natural language requests without inventing ratings", () => {
    expect(guideQuestion("选6")).toBe("下一站路线");
    expect(nearbyGuideKind("4")).toBe("food");
    expect(nearbyGuideKind("找附近高评价出片点")).toBe("photo");
    expect(nearbyGuideKind("不用找食物")).toBeNull();
    const content = formatGuideNearby({ available: true, radius: 3000, source: "高德地图", items: [{
      id: "p", name: "真实地点", address: "地址", category: "景点", latitude: 22, longitude: 113, distance: 100, rating: null,
    }] }, "photo", false);
    expect(content).toContain("暂无评分");
    expect(content).toContain("位置已过期");
    expect(content).toContain("不等同于出片效果评分");
  });
});

describe("journey runtime and conversation persistence", () => {
  let cleanup: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    window.LensGoNative = { startLocationUpdates: vi.fn(() => true), stopLocationUpdates: vi.fn(), speakAndNotify: vi.fn() };
    vi.mocked(streamQwenPawChat).mockClear();
  });
  afterEach(() => { cleanup?.(); cleanup = undefined; delete window.LensGoNative; vi.useRealTimers(); });

  it("keeps GPS active but pauses arrival stories while choosing a destination", () => {
    const t = trip(); t.stops = [t.stops![1]];
    t.guidePlaces = [{ id: "free", name: "自由景点", ...coordinates }];
    t.currentStopIndex = 0;
    saveTrips([t]);
    cleanup = startTripGuideRuntime({ qwenpawBaseUrl: "http://localhost", qwenpawAgentId: "director" } as MobileSettings);
    const emit = (offset: number) => {
      vi.setSystemTime(now + offset);
      window.dispatchEvent(new CustomEvent("lensgo-native-location", { detail: {
        latitude: 22.194, longitude: 113.541, accuracy: 5, recordedAt: now + offset,
      } }));
    };
    window.dispatchEvent(new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: true }));
    emit(0); emit(20_000); emit(40_000);
    expect(streamQwenPawChat).not.toHaveBeenCalled();
    expect(loadTrips()[0].lastPosition?.recordedAt).toBe(now + 40_000);
    window.dispatchEvent(new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: false }));
    emit(50_000); emit(70_000);
    expect(streamQwenPawChat).toHaveBeenCalledTimes(1);
    expect(loadTrips()[0].currentStopIndex).toBe(0);
  });

  it("creates an independent story, preserves other chats, survives remount and stops on finish", async () => {
    const existing = loadChatSessionState("test-model").sessions[0];
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify([existing]));
    const unorderedTrip = trip();
    unorderedTrip.stops![0].day = 2;
    unorderedTrip.stops![2].latitude = coordinates.latitude + 0.03;
    unorderedTrip.currentStopIndex = 2;
    saveTrips([unorderedTrip]);
    const settings = { qwenpawBaseUrl: "http://localhost", qwenpawAgentId: "director" } as MobileSettings;
    cleanup = startTripGuideRuntime(settings);
    const emit = (offset: number) => {
      vi.setSystemTime(now + offset);
      window.dispatchEvent(new CustomEvent("lensgo-native-location", { detail: {
        latitude: 22.194, longitude: 113.541, accuracy: 5, recordedAt: now + offset,
      } }));
    };
    emit(0); emit(10_000); emit(20_000);
    updateChatSessions((sessions) => sessions.map((s) => s.id === existing.id ? { ...s, title: "用户已有对话" } : s));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const sessions = loadChatSessionState("").sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === existing.id)?.title).toBe("用户已有对话");
    const guide = sessions.find((s) => s.guide)!;
    expect(guide.remoteSessionId).not.toBe(existing.remoteSessionId);
    expect(guide.messages[0].content).toContain("#lensgo-guide-4");
    expect(guide.messages[0].content).not.toContain("不可见内部内容");
    expect(guide.guide?.status).toBe("ready");
    expect(streamQwenPawChat).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(GUIDE_VISITS_KEY)!)).toHaveLength(1);
    cleanup(); cleanup = startTripGuideRuntime(settings);
    emit(30_000); emit(40_000); emit(50_000);
    expect(streamQwenPawChat).toHaveBeenCalledTimes(1);
    saveTrips(loadTrips().map((t) => ({ ...t, status: "completed" })));
    expect(window.LensGoNative!.stopLocationUpdates).toHaveBeenCalledTimes(2);
    emit(60_000);
    expect(streamQwenPawChat).toHaveBeenCalledTimes(1);
  });

  it("temporary permission/initial-fix subscribers do not stop the journey's GPS owner", () => {
    const stopJourney = startNativeLocationWatch(vi.fn(), vi.fn())!;
    const stopInitial = startNativeLocationWatch(vi.fn(), vi.fn())!;
    stopInitial(); stopInitial();
    expect(window.LensGoNative!.startLocationUpdates).toHaveBeenCalledTimes(1);
    expect(window.LensGoNative!.stopLocationUpdates).not.toHaveBeenCalled();
    stopJourney();
    expect(window.LensGoNative!.stopLocationUpdates).toHaveBeenCalledTimes(1);
  });

  it("retains an empty streaming placeholder across concurrent session writes", () => {
    const session = loadChatSessionState("").sessions[0];
    session.messages = [{ id: "pending", role: "assistant", content: "", createdAt: now }];
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify([session]));
    updateChatSessions((current) => current.map((s) => ({ ...s, title: "still streaming" })));
    updateChatSessions((current) => current.map((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m, content: "完整回复" })) })));
    expect(loadChatSessionState("").sessions[0].messages[0].content).toBe("完整回复");
  });
});
