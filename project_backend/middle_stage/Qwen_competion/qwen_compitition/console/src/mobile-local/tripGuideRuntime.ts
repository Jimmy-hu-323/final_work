import { invoke } from "@tauri-apps/api/core";
import {
  createId, loadTrips, saveTrips, mobileDeviceId, mobileChat,
  type MobileSettings, type TripPosition,
} from "./runtime";
import { startNativeLocationWatch, toTripPosition, geolocationErrorMessage } from "./tripJourney";
import { streamQwenPawChat } from "./qwenpaw";
import { stripAgentControlContent } from "./tripSync";
import {
  createChatSession, updateChatSessions, QWENPAW_MODEL_ID,
  type LocalChatSession,
} from "./chatSessions";
import {
  GUIDE_VISITS_KEY, GUIDE_OPEN_EVENT, GUIDE_POSITION_EVENT, GUIDE_ERROR_EVENT, GUIDE_DEPARTURE_EVENT,
  TRIPS_CHANGED_EVENT, GUIDE_FOLLOW_UP, TripArrivalTracker,
  guideStoryPrompt, guideQuestion, nearbyGuideKind, formatGuideNearby, isFreshGuidePosition,
  type GuideContext, type NearbyGuideResult,
} from "./tripGuide";

const runningStories = new Set<string>();

export async function replyToTripGuide(
  session: LocalChatSession,
  question: string | undefined,
  onText: (text: string) => void,
  onActivity?: (text: string) => void,
): Promise<string> {
  const guide = session.guide!;
  question = question ? guideQuestion(question) : undefined;
  const kind = question ? nearbyGuideKind(question) : null;
  const trip = loadTrips().find((item) => item.id === guide.tripId);
  if (kind) {
    onActivity?.("正在搜索附近地点…");
    const live = Boolean(trip?.status === "active" && trip.lastPosition && isFreshGuidePosition(trip.lastPosition));
    const origin = live ? trip!.lastPosition! : guide;
    const result = await invoke<NearbyGuideResult>("mobile_trip_guide_nearby", {
      latitude: origin.latitude, longitude: origin.longitude, kind,
    });
    return formatGuideNearby(result, kind, live);
  }
  const prompt = guideStoryPrompt(guide, question);
  // Only the selected attraction is shared automatically. No whole itinerary,
  // memory, album or precise live GPS is attached to the storytelling request.
  const nextStop = question && /下一站/.test(question) ?
    trip?.guideDestination : undefined;
  const context = JSON.stringify({
    task: "attraction_guide", attraction: { name: guide.stopName, day: guide.day },
    nextStop: nextStop ? { name: nextStop.name, time: nextStop.time, note: nextStop.note } : undefined,
    instruction: "仅作景点讲解。不要写入旅程、费用或相册；未提供的实时信息不能编造。",
  });
  const raw = session.model === QWENPAW_MODEL_ID ? await streamQwenPawChat({
    text: prompt, sessionId: session.remoteSessionId,
    userId: mobileDeviceId(), deviceId: mobileDeviceId(), context,
  }, {
    onText: (text) => onText(stripAgentControlContent(text)),
    onActivity: (activity) => onActivity?.(activity.label),
  }) : (await mobileChat([
    { role: "system", content: prompt + "\n" + context },
    ...session.messages.filter((item) => item.content.trim()).slice(-12).map(({ role, content }) => ({ role, content })),
    { role: "user", content: question || `请讲述${guide.stopName}的故事` },
  ], { model: session.model, maxTokens: 1600 })).content;
  const visible = stripAgentControlContent(raw).trim();
  if (!visible) throw new Error("景点讲解没有返回正文，请回复“重试讲解”。");
  return `${visible}\n\n${GUIDE_FOLLOW_UP}`;
}

async function tellArrivalStory(session: LocalChatSession) {
  runningStories.add(session.id);
  const assistantId = session.messages[0].id;
  const update = (content: string, status: GuideContext["status"]) => updateChatSessions((sessions) => sessions.map((item) =>
    item.id === session.id ? {
      ...item, updatedAt: Date.now(), guide: { ...item.guide!, status },
      messages: item.messages.map((message) => message.id === assistantId ? { ...message, content } : message),
    } : item,
  ));
  try {
    const text = await replyToTripGuide(session, undefined, (content) => update(content, "loading"));
    update(text, "ready");
  } catch {
    update("景点讲解暂时未能完成，请检查 QwenPaw 连接后回复“重试讲解”。已有聊天和旅程已保留。", "error");
  } finally {
    runningStories.delete(session.id);
  }
}

// Mounted at the app route boundary with no UI. Switching from Journey to Chat
// does not unmount the GPS owner. Finishing a trip stops the owner immediately.
export function startTripGuideRuntime(settings: MobileSettings | null): () => void {
  let watchingId = "";
  let stopWatch: (() => void) | null = null;
  let stopped = false;
  let choosingDestination = false;
  const tracker = new TripArrivalTracker();
  const visits = new Set<string>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GUIDE_VISITS_KEY) || "[]");
    if (Array.isArray(raw)) raw.filter((item) => typeof item === "string").forEach((key) => visits.add(key));
  } catch { /* invalid visit state cannot create an unsafe GPS match */ }

  // A process killed mid-stream must not leave an unusable permanent spinner.
  updateChatSessions((sessions) => sessions.map((session) =>
    session.guide?.status === "loading" && !runningStories.has(session.id) ? {
      ...session, guide: { ...session.guide, status: "error" },
      messages: [...session.messages, {
        id: createId("message"), role: "assistant" as const,
        content: "上次讲解被中断，可以回复“重试讲解”。", createdAt: Date.now(),
      }],
    } : session,
  ));

  const onError = (text: string) => window.dispatchEvent(new CustomEvent(GUIDE_ERROR_EVENT, { detail: text }));
  const onPosition = (tripId: string, position: TripPosition) => {
    if (stopped) return;
    const trips = loadTrips();
    const trip = trips.find((item) => item.id === tripId && item.status === "active");
    if (!trip) return;
    if (!isFreshGuidePosition(position)) {
      tracker.reset();
      onError("正在等待新鲜、精确的定位，暂不触发景点讲解");
      return;
    }
    const arrival = choosingDestination ? null : tracker.observe(trip, position, visits);
    const updated = { ...trip, lastPosition: position,
      currentStopIndex: arrival && arrival.index >= 0 ? arrival.index : trip.currentStopIndex };
    saveTrips(trips.map((item) => item.id === tripId ? updated : item));
    window.dispatchEvent(new CustomEvent(GUIDE_POSITION_EVENT, { detail: { tripId, position } }));
    if (!arrival) return;
    if (!settings?.qwenpawBaseUrl || !settings.qwenpawAgentId) {
      onError("到达景点，但尚未配置 QwenPaw，暂时无法自动讲解");
      return;
    }
    const session = createChatSession(QWENPAW_MODEL_ID);
    session.title = `${arrival.stop.name} · 景点导览`;
    session.guide = {
      tripId, tripTitle: trip.title, stopId: arrival.stop.id, stopName: arrival.stop.name,
      day: arrival.stop.day || 1, latitude: arrival.stop.latitude!, longitude: arrival.stop.longitude!, status: "loading",
    };
    session.messages = [{ id: createId("message"), role: "assistant", content: `已到达${arrival.stop.name}，正在准备景点讲解…`, createdAt: Date.now() }];
    // Persist the new conversation before consuming the visit. Automatic
    // conversations never truncate or overwrite the user's existing history.
    updateChatSessions((current) => [session, ...current]);
    visits.add(arrival.key);
    localStorage.setItem(GUIDE_VISITS_KEY, JSON.stringify([...visits]));
    void tellArrivalStory(session);
    window.dispatchEvent(new CustomEvent(GUIDE_OPEN_EVENT, { detail: session.id }));
  };

  const sync = () => {
    if (stopped) return;
    const active = loadTrips().find((trip) => trip.status === "active");
    if ((active?.id || "") === watchingId) return;
    stopWatch?.();
    stopWatch = null;
    tracker.reset();
    watchingId = active?.id || "";
    if (!active) return;
    stopWatch = startNativeLocationWatch((position) => onPosition(active.id, position), onError);
    if (!stopWatch && navigator.geolocation) {
      const id = navigator.geolocation.watchPosition(
        (raw) => onPosition(active.id, toTripPosition(raw)),
        (error) => onError(geolocationErrorMessage(error)),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
      stopWatch = () => navigator.geolocation.clearWatch(id);
    }
  };
  const onDeparture = (event: Event) => {
    choosingDestination = Boolean((event as CustomEvent<boolean>).detail);
    tracker.reset();
  };
  window.addEventListener(GUIDE_DEPARTURE_EVENT, onDeparture);
  window.addEventListener(TRIPS_CHANGED_EVENT, sync);
  sync();
  return () => {
    stopped = true;
    window.removeEventListener(TRIPS_CHANGED_EVENT, sync);
    window.removeEventListener(GUIDE_DEPARTURE_EVENT, onDeparture);
    stopWatch?.();
  };
}
