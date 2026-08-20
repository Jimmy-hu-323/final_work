import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type QwenPawActivity = {
  label: string;
  status: "running" | "completed";
};

type NativeStreamPayload = {
  requestId: string;
  event: Record<string, unknown>;
};

type StreamCallbacks = {
  onText: (text: string) => void;
  onActivity?: (activity: QwenPawActivity) => void;
};

type StreamRequest = {
  text: string;
  sessionId: string;
  userId: string;
  deviceId: string;
  context?: string;
};

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string"
      ? [value.text]
      : [];
  });
}

function outputText(event: Record<string, unknown>): string {
  if (!Array.isArray(event.output)) return "";
  for (const raw of [...event.output].reverse()) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (
      item.role !== "assistant" ||
      item.type === "reasoning" ||
      (item.type !== undefined && item.type !== "message")
    ) {
      continue;
    }
    const value = textBlocks(item.content).join("");
    if (value) return value;
  }
  return "";
}

function nestedString(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string {
  if (depth > 4 || !value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = nestedString(item, keys, depth + 1);
      if (result) return result;
    }
    return "";
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  for (const item of Object.values(value)) {
    const result = nestedString(item, keys, depth + 1);
    if (result) return result;
  }
  return "";
}

function activityFromEvent(
  event: Record<string, unknown>,
): QwenPawActivity | null {
  const object = String(event.object || "");
  if (
    object === "response" ||
    object === "message" ||
    object === "content" ||
    !object
  ) {
    return null;
  }
  const name = nestedString(
    event,
    new Set(["tool_name", "toolName", "name", "function_name", "agent_name"]),
  );
  const completed =
    event.status === "completed" ||
    event.status === "success" ||
    event.status === "failed";
  const label = name
    ? `${object.includes("agent") ? "子 Agent" : "工具"}：${name}`
    : object.includes("agent")
      ? "子 Agent 正在处理"
      : "正在调用 Skill / MCP 工具";
  return { label, status: completed ? "completed" : "running" };
}

class QwenPawStreamState {
  private assistantMessageIds = new Set<string>();
  private reasoningMessageIds = new Set<string>();
  private pendingDelta = new Map<string, string[]>();
  private partsByMessageId = new Map<string, string[]>();
  private assistantOrder: string[] = [];
  private latestOutput = "";

  private record(messageId: string, text: string) {
    const parts = this.partsByMessageId.get(messageId) || [];
    parts.push(text);
    this.partsByMessageId.set(messageId, parts);
  }

  private combined(): string {
    for (const messageId of [...this.assistantOrder].reverse()) {
      if (this.reasoningMessageIds.has(messageId)) continue;
      const text = (this.partsByMessageId.get(messageId) || []).join("");
      if (text) return text;
    }
    return this.latestOutput;
  }

  consume(event: Record<string, unknown>): string {
    const object = event.object;
    if (object === "message" && typeof event.id === "string") {
      if (event.role !== "assistant") return this.combined();
      if (event.type === "reasoning") {
        this.reasoningMessageIds.add(event.id);
        this.pendingDelta.delete(event.id);
        return this.combined();
      }
      if (event.type === "message") {
        this.assistantMessageIds.add(event.id);
        if (!this.assistantOrder.includes(event.id)) {
          this.assistantOrder.push(event.id);
        }
        for (const text of this.pendingDelta.get(event.id) || []) {
          this.record(event.id, text);
        }
        this.pendingDelta.delete(event.id);
      }
    }

    if (
      object === "content" &&
      event.type === "text" &&
      typeof event.msg_id === "string" &&
      typeof event.text === "string"
    ) {
      const messageId = event.msg_id;
      if (event.delta === true) {
        if (
          this.assistantMessageIds.has(messageId) &&
          !this.reasoningMessageIds.has(messageId)
        ) {
          this.record(messageId, event.text);
        } else if (!this.reasoningMessageIds.has(messageId)) {
          const pending = this.pendingDelta.get(messageId) || [];
          pending.push(event.text);
          this.pendingDelta.set(messageId, pending);
        }
      } else if (
        event.status === "completed" &&
        this.assistantMessageIds.has(messageId)
      ) {
        this.partsByMessageId.set(messageId, [event.text]);
      }
    }

    if (object === "response") {
      const snapshot = outputText(event);
      if (snapshot) this.latestOutput = snapshot;
    }
    return this.combined();
  }
}

export function loadQwenPawSessionId(): string {
  const key = "lensgo_qwenpaw_session_v1";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `lensgo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, value);
  return value;
}

export async function streamQwenPawChat(
  request: StreamRequest,
  callbacks: StreamCallbacks,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("QwenPaw 对话请在 Android App 中使用");
  }
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `request-${Date.now()}`;
  const state = new QwenPawStreamState();
  let finalText = "";
  let remoteError = "";
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<NativeStreamPayload>(
      "lensgo-qwenpaw-event",
      ({ payload }) => {
        if (payload.requestId !== requestId) return;
        const event = payload.event || {};
        const error = event.error;
        if (typeof error === "string" && error) {
          remoteError = error;
          return;
        }
        const text = state.consume(event);
        if (text && text !== finalText) {
          finalText = text;
          callbacks.onText(text);
        }
        const activity = activityFromEvent(event);
        if (activity) callbacks.onActivity?.(activity);
      },
    );
    await invoke("mobile_qwenpaw_chat", {
      request: {
        requestId,
        text: request.text,
        sessionId: request.sessionId,
        userId: request.userId,
        deviceId: request.deviceId,
        context: request.context || "",
      },
    });
    if (remoteError) throw new Error(remoteError);
    if (!finalText.trim()) {
      throw new Error("QwenPaw 已完成处理，但没有返回可显示的文字");
    }
    return finalText;
  } finally {
    unlisten?.();
  }
}
