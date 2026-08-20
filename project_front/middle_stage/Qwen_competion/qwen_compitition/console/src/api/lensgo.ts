const LENSGO_BASE_URL_KEY = "lensgo_bridge_base_url";
const LENSGO_TOKEN_KEY = "lensgo_bridge_token";

export type LensGoEvent = {
  event_id: string;
  timestamp: number;
  direction: "upstream" | "downstream" | "internal" | string;
  event_type: string;
  user_id: string;
  device_id: string;
  data: Record<string, unknown>;
};

export type LensGoStatus = {
  status: string;
  bridge: { enabled: boolean; history_size: number; event_count: number };
  qwenpaw: { base_url: string; agent_id: string; reachable: boolean };
  telegram: { enabled: boolean; configured: boolean };
  telegram_status: { enabled: boolean; configured: boolean };
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function getLensGoBaseUrl(): string {
  return normalizeBaseUrl(localStorage.getItem(LENSGO_BASE_URL_KEY) || "");
}

export function setLensGoBaseUrl(value: string): void {
  const normalized = normalizeBaseUrl(value);
  if (normalized) localStorage.setItem(LENSGO_BASE_URL_KEY, normalized);
  else localStorage.removeItem(LENSGO_BASE_URL_KEY);
}

export function getLensGoToken(): string {
  return sessionStorage.getItem(LENSGO_TOKEN_KEY) || "";
}

export function setLensGoToken(value: string): void {
  const normalized = value.trim();
  if (normalized) sessionStorage.setItem(LENSGO_TOKEN_KEY, normalized);
  else sessionStorage.removeItem(LENSGO_TOKEN_KEY);
}

export function clearLensGoConnection(): void {
  localStorage.removeItem(LENSGO_BASE_URL_KEY);
  sessionStorage.removeItem(LENSGO_TOKEN_KEY);
}

function bridgeUrl(path: string): string {
  const base = getLensGoBaseUrl();
  if (!base) throw new Error("尚未配置 LensGo 服务地址");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function bridgeFetch(path: string): Promise<Response> {
  const token = getLensGoToken();
  if (!token) throw new Error("尚未输入 LensGo Bridge Token");
  const response = await fetch(bridgeUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("LensGo Bridge Token 无效");
    throw new Error(`LensGo 请求失败（HTTP ${response.status}）`);
  }
  return response;
}

export async function fetchLensGoStatus(): Promise<LensGoStatus> {
  return (await bridgeFetch("/api/bridge/status")).json();
}

export async function fetchLensGoEvents(limit = 80): Promise<LensGoEvent[]> {
  const response = await bridgeFetch(
    `/api/bridge/events?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
  const body = (await response.json()) as { events?: LensGoEvent[] };
  return Array.isArray(body.events) ? body.events : [];
}

export async function fetchLensGoMedia(path: string): Promise<string> {
  const response = await bridgeFetch(path);
  return URL.createObjectURL(await response.blob());
}

export function subscribeLensGoEvents(
  onEvent: (event: LensGoEvent) => void,
  onState?: (connected: boolean) => void,
): () => void {
  const base = getLensGoBaseUrl();
  const token = getLensGoToken();
  if (!base || !token) return () => {};
  const url = new URL(`${base}/api/bridge/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  const socket = new WebSocket(url.toString());
  socket.onopen = () => onState?.(true);
  socket.onclose = () => onState?.(false);
  socket.onerror = () => onState?.(false);
  socket.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as LensGoEvent & {
        type?: string;
      };
      if (!event.type && event.event_id) onEvent(event);
    } catch {
      // Ignore malformed status frames without breaking the live feed.
    }
  };
  return () => socket.close();
}
