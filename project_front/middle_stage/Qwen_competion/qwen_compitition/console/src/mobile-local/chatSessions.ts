import {
  createId,
  loadMessages,
  type LocalMessage,
  type LocalTrip,
} from "./runtime";
import { loadQwenPawSessionId } from "./qwenpaw";
import { stripAgentControlContent } from "./tripSync";
import type { GuideContext } from "./tripGuide";

export const CHAT_SESSIONS_KEY = "lensgo_mobile_chat_sessions_v1";
export const ACTIVE_CHAT_SESSION_KEY = "lensgo_mobile_active_chat_session_v1";
export const QWENPAW_MODEL_ID = "__lensgo_qwenpaw__";

export type LocalChatSession = {
  id: string;
  title: string;
  messages: LocalMessage[];
  model: string;
  remoteSessionId: string;
  guide?: GuideContext;
  tripId?: string;
  tripTitle?: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatTripLink = {
  tripId: string;
  tripTitle: string;
};

export type TripChatFolder = {
  tripId: string;
  title: string;
  status?: LocalTrip["status"];
  startedAt?: number;
  updatedAt: number;
  orphaned: boolean;
  sessions: LocalChatSession[];
};

function cleanChatMessages(messages: LocalMessage[]): LocalMessage[] {
  return messages
    .map((item) =>
      item.role === "assistant"
        ? { ...item, content: stripAgentControlContent(item.content) }
        : item,
    )
    .filter(
      (item) =>
        item.role === "user" ||
        Boolean(item.content.trim()) ||
        Boolean(item.albumItemIds?.length) ||
        Boolean(item.chatMediaId),
    );
}

export function createChatRemoteSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `lensgo-chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createChatSession(
  model: string,
  messages: LocalMessage[] = [],
  trip?: ChatTripLink,
): LocalChatSession {
  const now = Date.now();
  const cleanMessages = cleanChatMessages(messages);
  const firstQuestion = cleanMessages.find((item) => item.role === "user")
    ?.content;
  return {
    id: createId("chat"),
    title: firstQuestion?.trim().slice(0, 24) || "新对话",
    messages: cleanMessages,
    model,
    remoteSessionId: cleanMessages.length
      ? loadQwenPawSessionId()
      : createChatRemoteSessionId(),
    tripId: trip?.tripId,
    tripTitle: trip?.tripTitle,
    createdAt: cleanMessages[0]?.createdAt || now,
    updatedAt: cleanMessages[cleanMessages.length - 1]?.createdAt || now,
  };
}

export function loadChatSessionState(
  defaultModel: string,
  preservePending = false,
): {
  sessions: LocalChatSession[];
  activeId: string;
} {
  try {
    const raw = JSON.parse(
      localStorage.getItem(CHAT_SESSIONS_KEY) || "[]",
    ) as LocalChatSession[];
    const sessions = Array.isArray(raw)
      ? raw
          .filter(
            (item) =>
              item &&
              typeof item.id === "string" &&
              Array.isArray(item.messages),
          )
          .map((item) => ({
            ...item,
            tripId:
              typeof item.tripId === "string" && item.tripId
                ? item.tripId
                : item.guide?.tripId,
            tripTitle:
              typeof item.tripTitle === "string" && item.tripTitle
                ? item.tripTitle
                : item.guide?.tripTitle,
            messages: preservePending
              ? item.messages
              : cleanChatMessages(item.messages),
          }))
      : [];
    if (sessions.length) {
      const activeId = localStorage.getItem(ACTIVE_CHAT_SESSION_KEY) || "";
      return {
        sessions,
        activeId: sessions.some((item) => item.id === activeId)
          ? activeId
          : sessions[0].id,
      };
    }
  } catch {
    // Invalid local history falls back to the legacy current conversation.
  }
  const session = createChatSession(defaultModel, loadMessages());
  return { sessions: [session], activeId: session.id };
}

export const CHAT_SESSIONS_CHANGED = "lensgo-chat-sessions-changed";

export function sessionTripId(session: LocalChatSession): string {
  return session.tripId || session.guide?.tripId || "";
}

export function linkChatSessionToTrip(
  sessions: LocalChatSession[],
  sessionId: string,
  trip: Pick<LocalTrip, "id" | "title">,
): LocalChatSession[] {
  return sessions.map((session) =>
    session.id === sessionId
      ? { ...session, tripId: trip.id, tripTitle: trip.title }
      : session,
  );
}

export function buildChatHistoryGroups(
  sessions: LocalChatSession[],
  trips: LocalTrip[],
): { folders: TripChatFolder[]; otherSessions: LocalChatSession[] } {
  const byTrip = new Map<string, LocalChatSession[]>();
  const otherSessions: LocalChatSession[] = [];
  sessions.forEach((session) => {
    const tripId = sessionTripId(session);
    if (!tripId) {
      otherSessions.push(session);
      return;
    }
    byTrip.set(tripId, [...(byTrip.get(tripId) || []), session]);
  });

  const folders: TripChatFolder[] = [];
  trips.forEach((trip) => {
    const linked = byTrip.get(trip.id) || [];
    if (!trip.startedAt && !linked.length) return;
    const ordered = [...linked].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    folders.push({
      tripId: trip.id,
      title: trip.title,
      status: trip.status,
      startedAt: trip.startedAt,
      updatedAt: Math.max(
        trip.updatedAt || trip.startedAt || trip.createdAt,
        ...ordered.map((session) => session.updatedAt),
      ),
      orphaned: false,
      sessions: ordered,
    });
    byTrip.delete(trip.id);
  });

  byTrip.forEach((linked, tripId) => {
    const ordered = [...linked].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    folders.push({
      tripId,
      title:
        ordered.find((session) => session.tripTitle)?.tripTitle ||
        ordered.find((session) => session.guide?.tripTitle)?.guide?.tripTitle ||
        "已删除行程的历史对话",
      updatedAt: Math.max(...ordered.map((session) => session.updatedAt)),
      orphaned: true,
      sessions: ordered,
    });
  });

  folders.sort((left, right) => {
    const leftActive = left.status === "active" ? 1 : 0;
    const rightActive = right.status === "active" ? 1 : 0;
    return rightActive - leftActive || right.updatedAt - left.updatedAt;
  });
  otherSessions.sort((left, right) => right.updatedAt - left.updatedAt);
  return { folders, otherSessions };
}

// Every writer reads the latest store so arrivals and in-flight replies never
// replace another conversation with a stale React snapshot.
export function updateChatSessions(
  update: (sessions: LocalChatSession[]) => LocalChatSession[],
): LocalChatSession[] {
  const current = loadChatSessionState(QWENPAW_MODEL_ID, true).sessions;
  const next = update(current);
  localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHAT_SESSIONS_CHANGED));
  return next;
}
