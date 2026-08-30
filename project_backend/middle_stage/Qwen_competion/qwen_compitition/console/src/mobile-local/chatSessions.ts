import { createId, loadMessages, type LocalMessage } from "./runtime";
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
  createdAt: number;
  updatedAt: number;
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
        Boolean(item.albumItemIds?.length),
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
): LocalChatSession {
  const now = Date.now();
  const cleanMessages = cleanChatMessages(messages);
  const firstQuestion = cleanMessages.find(
    (item) => item.role === "user",
  )?.content;
  return {
    id: createId("chat"),
    title: firstQuestion?.trim().slice(0, 24) || "新对话",
    messages: cleanMessages,
    model,
    remoteSessionId: cleanMessages.length
      ? loadQwenPawSessionId()
      : createChatRemoteSessionId(),
    createdAt: cleanMessages[0]?.createdAt || now,
    updatedAt: cleanMessages[cleanMessages.length - 1]?.createdAt || now,
  };
}

export function loadChatSessionState(defaultModel: string, preservePending = false): {
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
            messages: preservePending ? item.messages : cleanChatMessages(item.messages),
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
