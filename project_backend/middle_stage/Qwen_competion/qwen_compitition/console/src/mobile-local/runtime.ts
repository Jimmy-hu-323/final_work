import { invoke, isTauri } from "@tauri-apps/api/core";
import { parse as parseExif } from "../vendor/exifr/full.esm.js";

export type MobileSettings = {
  apiBaseUrl: string;
  model: string;
  visionModel: string;
  imageBaseUrl: string;
  imageModel: string;
  systemPrompt: string;
  qwenpawBaseUrl: string;
  qwenpawAgentId: string;
  hasApiKey: boolean;
  hasImageApiKey: boolean;
  hasQwenpawAuthToken: boolean;
};

export type MobileSettingsInput = Omit<
  MobileSettings,
  "hasApiKey" | "hasImageApiKey" | "hasQwenpawAuthToken"
> & {
  apiKey?: string;
  imageApiKey?: string;
  qwenpawAuthToken?: string;
  clearApiKey?: boolean;
  clearImageApiKey?: boolean;
  clearQwenpawAuthToken?: boolean;
};

export type LocalMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  albumItemIds?: string[];
  chatMediaId?: string;
  chatMediaKind?: "source" | "preview";
  savedAlbumItemId?: string;
};

export type ChatMediaItem = {
  id: string;
  name: string;
  dataUrl: string;
  kind: "source" | "preview";
  createdAt: number;
  sourceMediaId?: string;
};

export type TripStop = {
  id: string;
  name: string;
  day?: number;
  time?: string;
  note?: string;
  crowdRegionId?: string;
  longitude?: number;
  latitude?: number;
  radiusM?: number;
};

export type TripPosition = {
  longitude: number;
  latitude: number;
  accuracy: number;
  recordedAt: number;
};

export type LocalTrip = {
  id: string;
  title: string;
  request: string;
  content: string;
  createdAt: number;
  stops?: TripStop[];
  guidePlaces?: TripStop[];
  guideDestination?: TripStop;
  status?: "planned" | "active" | "completed";
  currentStopIndex?: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  lastPosition?: TripPosition;
  agentAccess?: boolean;
  syncStatus?: "local" | "pending" | "synced" | "conflict";
  cloudUpdatedAt?: number;
  planningSessionId?: string;
};

export type AlbumItem = {
  id: string;
  name: string;
  dataUrl: string;
  source: "upload" | "pose";
  createdAt: number;
  note?: string;
  capturedAt?: number;
  location?: PhotoLocation;
  analysis?: AlbumAnalysis;
  analysisStatus?: "pending" | "analyzing" | "ready" | "failed";
  analysisError?: string;
  analyzedAt?: number;
  cloudFileId?: number;
  cloudSyncedAt?: number;
  syncStatus?: "local" | "uploading" | "synced" | "failed";
};

export type PhotoLocation = {
  latitude?: number;
  longitude?: number;
  source: "exif" | "ai";
  confidence?: number;
  landmark?: string;
  address?: string;
  district?: string;
  city?: string;
  region?: string;
  country?: string;
};

export type AlbumAnalysis = {
  description: string;
  scene: string;
  tags: string[];
  objects: string[];
  visibleText: string[];
  peopleSummary?: string;
  activity?: string;
  timeOfDay?: string;
  searchText: string;
};

export type PhotoMetadata = {
  capturedAt?: number;
  location?: PhotoLocation;
};

export type ImageAnalysisResponse = AlbumAnalysis & {
  landmark?: string;
  address?: string;
  district?: string;
  city?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  locationConfidence?: number;
};

export type ChatResponse = {
  content: string;
  model: string;
  usage?: Record<string, unknown>;
};

export type QwenPawTravelLeg = {
  mode?: string;
  distance_meters?: number;
  duration_text?: string;
};

export type QwenPawTravelActivity = {
  order: number;
  name: string;
  location?: string;
  note?: string;
  arrive_time?: string;
  depart_time?: string;
  travel_from_previous?: QwenPawTravelLeg | null;
};

export type QwenPawTravelDay = {
  day_number?: number;
  title: string;
  activities: QwenPawTravelActivity[];
};

export type QwenPawTravelItinerary = {
  title: string;
  destination: string;
  day_count: number;
  transportation?: string;
  updated_at?: string;
  days: QwenPawTravelDay[];
};

export type QwenPawRouteResponse = {
  points: Array<[number, number]>;
  mode: string;
  cached?: boolean;
};

export type ChatNavigationResponse = {
  available: boolean;
  reason?: string;
  mode?: "transit" | "driving" | "walking";
  destination?: {
    name: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  distanceMeters?: number;
  durationSeconds?: number;
  steps?: string[];
  points?: Array<[number, number]>;
  transitOptions?: Array<{
    durationSeconds: number;
    walkingDurationSeconds: number;
    walkingDistanceMeters: number;
    transferCount: number;
    legs: Array<{
      kind: "walking" | "bus" | "railway";
      line?: string;
      fromStop?: string;
      toStop?: string;
      durationSeconds?: number;
      distanceMeters?: number;
      viaStops?: number;
      busReport?: {
        dataType: "mock";
        source: string;
        disclaimer: string;
        stopName?: string;
        routeNo?: string;
        generatedAt?: string;
        arrivals: Array<{
          vehicleId?: string;
          etaMinutes?: number;
          stopsAway?: number;
          occupancyLevel?: number;
          delayMinutes?: number;
          observedAt?: string;
        }>;
      };
    }>;
  }>;
  source?: string;
};

export type HotelBillItem = {
  label: string;
  amount: number;
};

export type HotelBill = {
  id: string;
  booking_id: string;
  title: string;
  subtitle: string;
  amount: number;
  currency: string;
  status: "PENDING_PAYMENT" | "PROCESSING" | "PAID" | "CANCELLED";
  due_at: string;
  version: number;
  breakdown: HotelBillItem[];
  confirmation_no?: string;
  hotel_id?: string;
};

export type HotelAdjustmentPreview = {
  id: string;
  bill_id: string;
  base_version: number;
  current_amount: number;
  new_amount: number;
  delta_amount: number;
  breakdown: HotelBillItem[];
  breakfast: boolean;
  expires_at: string;
};

export type HotelPaymentAuthorization = {
  id: string;
  status: "PENDING" | "GRANTED" | "REVOKED" | "USED";
  bill_ids: string[];
  max_amount: number;
  currency: string;
  expires_at: string;
  agent_name?: string;
};

export type TripExpenseCategory =
  | "hotel"
  | "ticket"
  | "transport"
  | "meal"
  | "other";

export type TripExpense = {
  id: string;
  trip_id: string;
  category: TripExpenseCategory;
  title: string;
  place_name: string;
  latitude: number | null;
  longitude: number | null;
  day: number | null;
  unit_amount: number;
  quantity: number;
  amount: number;
  currency: string;
  required: boolean;
  note: string;
  source: string;
  booking_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TripExpenseSummary = {
  total: number;
  required_total: number;
  optional_total: number;
  by_category: Record<string, number>;
  count: number;
  currency: string;
};

export type TripExpenseInput = {
  title: string;
  category: TripExpenseCategory;
  placeName?: string;
  day?: number | null;
  unitAmount: number;
  quantity: number;
  required: boolean;
  note?: string;
};

const DEFAULT_PROMPT =
  "你是 LensGo 澳门旅游助手。请用简洁、可靠、友好的中文回答，优先提供澳门旅行、路线、拍照姿势、安全和文化背景建议；涉及实时开放时间、票价或天气时明确提醒用户核实最新信息。";
const BROWSER_SETTINGS_KEY = "lensgo_mobile_provider_preview";
const CHAT_KEY = "lensgo_mobile_chat_v1";
const TRIPS_KEY = "lensgo_mobile_trips_v1";
const MEMORY_KEY = "lensgo_mobile_memory_v1";
const PRIVACY_KEY = "lensgo_mobile_privacy_v1";
const DEVICE_KEY = "lensgo_mobile_device_id_v1";
const DB_NAME = "lensgo-mobile-album";
const DB_VERSION = 2;
const STORE_NAME = "images";
const CHAT_MEDIA_STORE_NAME = "chatMedia";

function fallbackSettings(): MobileSettings {
  try {
    const value = JSON.parse(
      localStorage.getItem(BROWSER_SETTINGS_KEY) || "{}",
    ) as Partial<MobileSettings>;
    return {
      apiBaseUrl: value.apiBaseUrl || "",
      model: value.model || "",
      visionModel: value.visionModel || "",
      imageBaseUrl: value.imageBaseUrl || "",
      imageModel: value.imageModel || "",
      systemPrompt: value.systemPrompt || DEFAULT_PROMPT,
      qwenpawBaseUrl: value.qwenpawBaseUrl || "http://127.0.0.1:18088",
      qwenpawAgentId: value.qwenpawAgentId || "lensgo-travel-director",
      hasApiKey: Boolean(value.hasApiKey),
      hasImageApiKey: Boolean(value.hasImageApiKey),
      hasQwenpawAuthToken: Boolean(value.hasQwenpawAuthToken),
    };
  } catch {
    return {
      apiBaseUrl: "",
      model: "",
      visionModel: "",
      imageBaseUrl: "",
      imageModel: "",
      systemPrompt: DEFAULT_PROMPT,
      qwenpawBaseUrl: "http://127.0.0.1:18088",
      qwenpawAgentId: "lensgo-travel-director",
      hasApiKey: false,
      hasImageApiKey: false,
      hasQwenpawAuthToken: false,
    };
  }
}

export async function loadMobileSettings(): Promise<MobileSettings> {
  if (isTauri()) return invoke<MobileSettings>("mobile_load_settings");
  return fallbackSettings();
}

export async function saveMobileSettings(
  settings: MobileSettingsInput,
): Promise<MobileSettings> {
  if (isTauri()) {
    return invoke<MobileSettings>("mobile_save_settings", { settings });
  }
  const existing = fallbackSettings();
  const next: MobileSettings = {
    apiBaseUrl: settings.apiBaseUrl,
    model: settings.model,
    visionModel: settings.visionModel,
    imageBaseUrl: settings.imageBaseUrl,
    imageModel: settings.imageModel,
    systemPrompt: settings.systemPrompt || DEFAULT_PROMPT,
    qwenpawBaseUrl: settings.qwenpawBaseUrl?.trim() || "http://127.0.0.1:18088",
    qwenpawAgentId: settings.qwenpawAgentId?.trim() || "lensgo-travel-director",
    hasApiKey: settings.clearApiKey
      ? false
      : Boolean(settings.apiKey) || existing.hasApiKey,
    hasImageApiKey: settings.clearImageApiKey
      ? false
      : Boolean(settings.imageApiKey) || existing.hasImageApiKey,
    hasQwenpawAuthToken: settings.clearQwenpawAuthToken
      ? false
      : Boolean(settings.qwenpawAuthToken) || existing.hasQwenpawAuthToken,
  };
  localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function testMobileProvider(): Promise<ChatResponse> {
  if (!isTauri()) {
    throw new Error("浏览器预览不能读取本地密钥，请在 Android App 中测试");
  }
  return invoke<ChatResponse>("mobile_test_provider");
}

export async function listMobileModels(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("mobile_list_models");
}

export async function mobileChat(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  options: { model?: string; temperature?: number; maxTokens?: number } = {},
): Promise<ChatResponse> {
  if (!isTauri()) {
    throw new Error("请在 Android App 中调用本地模型运行时");
  }
  return invoke<ChatResponse>("mobile_chat", {
    request: {
      messages,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    },
  });
}

export async function fetchQwenPawLatestItinerary(): Promise<QwenPawTravelItinerary | null> {
  if (!isTauri()) return null;
  return invoke<QwenPawTravelItinerary | null>(
    "mobile_qwenpaw_latest_itinerary",
  );
}

export async function fetchQwenPawRoute(
  origin: string,
  destination: string,
  mode = "driving",
): Promise<QwenPawRouteResponse> {
  if (!isTauri()) {
    throw new Error("真实高德路线请在 Android App 中查看");
  }
  return invoke<QwenPawRouteResponse>("mobile_qwenpaw_route", {
    request: { origin, destination, mode },
  });
}

export async function fetchChatNavigation(
  position: TripPosition,
  destination: string,
  mode: "transit" | "driving" | "walking",
): Promise<ChatNavigationResponse> {
  if (!isTauri()) {
    throw new Error("实时导航请在 Android App 中使用");
  }
  return invoke<ChatNavigationResponse>("mobile_chat_navigation", {
    request: {
      latitude: position.latitude,
      longitude: position.longitude,
      destination,
      mode,
    },
  });
}

type HotelGatewayPayload = {
  operation: string;
  userId: string;
  billId?: string;
  previewId?: string;
  breakfast?: boolean;
  billIds?: string[];
  authorizationId?: string;
  action?: "request" | "grant" | "revoke";
  tripId?: string;
  expenseId?: string;
  expense?: Record<string, unknown>;
};

async function hotelGateway<T>(
  payload: Omit<HotelGatewayPayload, "userId">,
): Promise<T> {
  if (!isTauri()) {
    throw new Error("酒店账单功能请在 Android App 中使用");
  }
  return invoke<T>("mobile_hotel_gateway", {
    request: { ...payload, userId: mobileDeviceId() },
  });
}

export async function listHotelBills(): Promise<HotelBill[]> {
  const result = await hotelGateway<{
    bills?: HotelBill[];
    data?: HotelBill[];
  }>({ operation: "list_bills" });
  return result.bills || result.data || [];
}

export async function previewHotelBillAdjustment(
  billId: string,
  breakfast: boolean,
): Promise<HotelAdjustmentPreview> {
  const result = await hotelGateway<{ preview: HotelAdjustmentPreview }>({
    operation: "preview_adjustment",
    billId,
    breakfast,
  });
  return result.preview;
}

export async function confirmHotelBillAdjustment(
  billId: string,
  previewId: string,
): Promise<void> {
  await hotelGateway({
    operation: "confirm_adjustment",
    billId,
    previewId,
  });
}

export async function listHotelPaymentAuthorizations(): Promise<
  HotelPaymentAuthorization[]
> {
  const result = await hotelGateway<{
    authorizations?: HotelPaymentAuthorization[];
    data?: HotelPaymentAuthorization[];
  }>({ operation: "list_authorizations" });
  return result.authorizations || result.data || [];
}

export async function updateHotelPaymentAuthorization(
  action: "request" | "grant" | "revoke",
  options: { billIds?: string[]; authorizationId?: string },
): Promise<void> {
  await hotelGateway({
    operation: "update_authorization",
    action,
    billIds: options.billIds,
    authorizationId: options.authorizationId,
  });
}

export async function payHotelBills(billIds: string[]): Promise<void> {
  await hotelGateway({ operation: "pay", billIds });
}

function tripExpensePayload(input: TripExpenseInput): Record<string, unknown> {
  return {
    title: input.title,
    category: input.category,
    place_name: input.placeName || "",
    day: input.day ?? null,
    unit_amount: input.unitAmount,
    quantity: input.quantity,
    required: input.required,
    note: input.note || "",
  };
}

export async function listTripExpenses(
  tripId: string,
): Promise<{ expenses: TripExpense[]; summary: TripExpenseSummary }> {
  const result = await hotelGateway<{
    expenses?: TripExpense[];
    summary?: TripExpenseSummary;
  }>({ operation: "list_trip_expenses", tripId });
  const expenses = result.expenses || [];
  return {
    expenses,
    summary: result.summary || {
      total: expenses.reduce((sum, item) => sum + item.amount, 0),
      required_total: expenses
        .filter((item) => item.required)
        .reduce((sum, item) => sum + item.amount, 0),
      optional_total: expenses
        .filter((item) => !item.required)
        .reduce((sum, item) => sum + item.amount, 0),
      by_category: {},
      count: expenses.length,
      currency: expenses[0]?.currency || "CNY",
    },
  };
}

export async function createTripExpense(
  tripId: string,
  input: TripExpenseInput,
): Promise<void> {
  await hotelGateway({
    operation: "create_trip_expense",
    tripId,
    expense: tripExpensePayload(input),
  });
}

export async function updateTripExpense(
  expenseId: string,
  input: TripExpenseInput,
): Promise<void> {
  await hotelGateway({
    operation: "update_trip_expense",
    expenseId,
    expense: tripExpensePayload(input),
  });
}

export async function deleteTripExpense(expenseId: string): Promise<void> {
  await hotelGateway({ operation: "delete_trip_expense", expenseId });
}

export async function deleteTripExpenses(tripId: string): Promise<number> {
  const result = await hotelGateway<{ removed?: number }>({
    operation: "delete_trip_expenses",
    tripId,
  });
  return Number(result.removed || 0);
}

export type MobilePrivacySettings = {
  shareTripsWithAgent: boolean;
  albumSyncMode: "off" | "selected" | "automatic";
};

export function loadPrivacySettings(): MobilePrivacySettings {
  try {
    const value = JSON.parse(
      localStorage.getItem(PRIVACY_KEY) || "{}",
    ) as Partial<MobilePrivacySettings>;
    return {
      shareTripsWithAgent: value.shareTripsWithAgent === true,
      albumSyncMode:
        value.albumSyncMode === "selected" ||
        value.albumSyncMode === "automatic"
          ? value.albumSyncMode
          : "off",
    };
  } catch {
    return { shareTripsWithAgent: false, albumSyncMode: "off" };
  }
}

export function savePrivacySettings(
  settings: MobilePrivacySettings,
): MobilePrivacySettings {
  localStorage.setItem(PRIVACY_KEY, JSON.stringify(settings));
  return settings;
}

export function mobileDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(DEVICE_KEY, value);
  return value;
}

export async function testQwenPaw(): Promise<string> {
  if (!isTauri()) {
    throw new Error("请在 Android App 中测试 QwenPaw 连接");
  }
  return invoke<string>("mobile_test_qwenpaw");
}

export async function uploadAlbumItemToCloud(
  item: AlbumItem,
): Promise<{ fileId: number; message: string }> {
  if (!isTauri()) {
    throw new Error("请在 Android App 中同步照片");
  }
  return invoke<{ fileId: number; message: string }>(
    "mobile_upload_cloud_photo",
    {
      request: {
        fileName: item.name,
        dataUrl: item.dataUrl,
      },
    },
  );
}

export async function deleteCloudAlbumItem(fileId: number): Promise<void> {
  if (!isTauri()) {
    throw new Error("请在 Android App 中管理云端照片");
  }
  await invoke("mobile_delete_cloud_photo", { fileId });
}

export async function generateMobileImage(
  prompt: string,
  size = "1024x1024",
  sourceDataUrl?: string,
): Promise<{ dataUrl: string; revisedPrompt?: string }> {
  if (!isTauri()) {
    throw new Error("请在 Android App 中调用本地图片运行时");
  }
  return invoke<{ dataUrl: string; revisedPrompt?: string }>(
    "mobile_generate_image",
    {
      request: { prompt, size, sourceDataUrl },
    },
  );
}

export async function analyzeAlbumImage(
  item: Pick<AlbumItem, "name" | "dataUrl" | "capturedAt" | "location">,
): Promise<ImageAnalysisResponse> {
  if (!isTauri()) {
    throw new Error("请在 Android App 中调用识图模型");
  }
  const analysisDataUrl = await prepareImageForAnalysis(item.dataUrl);
  return invoke<ImageAnalysisResponse>("mobile_analyze_image", {
    request: {
      fileName: item.name,
      dataUrl: analysisDataUrl,
      capturedAt: item.capturedAt,
      latitude: item.location?.latitude,
      longitude: item.location?.longitude,
    },
  });
}

export async function prepareImageForAnalysis(
  dataUrl: string,
): Promise<string> {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("无法读取待识别图片"));
    image.src = dataUrl;
  });
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (longestSide <= 1600 && dataUrl.length <= 2_500_000) return dataUrl;
  const scale = Math.min(1, 1600 / longestSide);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前设备无法缩放待识别图片");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

function loadArray<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function loadMessages(): LocalMessage[] {
  return loadArray<LocalMessage>(CHAT_KEY);
}

export function saveMessages(messages: LocalMessage[]): void {
  localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-200)));
}

export function clearMessages(): void {
  localStorage.removeItem(CHAT_KEY);
}

export function loadTrips(): LocalTrip[] {
  return loadArray<LocalTrip>(TRIPS_KEY);
}

export function saveTrips(trips: LocalTrip[]): void {
  localStorage.setItem(TRIPS_KEY, JSON.stringify(trips.slice(0, 30)));
  window.dispatchEvent(new Event("lensgo-trips-changed"));
}

export function loadMemory(): string {
  return localStorage.getItem(MEMORY_KEY) || "";
}

export function saveMemory(value: string): void {
  localStorage.setItem(MEMORY_KEY, value.slice(0, 12000));
}

function openAlbumDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CHAT_MEDIA_STORE_NAME)) {
        db.createObjectStore(CHAT_MEDIA_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listChatMediaItems(): Promise<ChatMediaItem[]> {
  const db = await openAlbumDb();
  return new Promise<ChatMediaItem[]>((resolve, reject) => {
    const request = db
      .transaction(CHAT_MEDIA_STORE_NAME, "readonly")
      .objectStore(CHAT_MEDIA_STORE_NAME)
      .getAll();
    request.onsuccess = () => resolve(request.result as ChatMediaItem[]);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

export async function putChatMediaItem(item: ChatMediaItem): Promise<void> {
  const db = await openAlbumDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(CHAT_MEDIA_STORE_NAME, "readwrite");
    transaction.objectStore(CHAT_MEDIA_STORE_NAME).put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

export async function listAlbumItems(): Promise<AlbumItem[]> {
  const db = await openAlbumDb();
  return new Promise<AlbumItem[]>((resolve, reject) => {
    const request = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as AlbumItem[]).sort(
          (left, right) => right.createdAt - left.createdAt,
        ),
      );
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

export async function putAlbumItem(item: AlbumItem): Promise<void> {
  const db = await openAlbumDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

export async function deleteAlbumItem(id: string): Promise<void> {
  const db = await openAlbumDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

function dateValue(value: unknown): number | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function extractPhotoMetadata(file: File): Promise<PhotoMetadata> {
  try {
    const metadata = await parseExif(file, {
      gps: true,
      exif: true,
      ifd0: true,
      iptc: true,
      xmp: true,
      mergeOutput: true,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      silentErrors: true,
    });
    if (!metadata) return {};
    const latitude =
      typeof metadata.latitude === "number" &&
      Number.isFinite(metadata.latitude)
        ? metadata.latitude
        : undefined;
    const longitude =
      typeof metadata.longitude === "number" &&
      Number.isFinite(metadata.longitude)
        ? metadata.longitude
        : undefined;
    const city = textValue(metadata.City);
    const region = textValue(metadata.State);
    const country = textValue(metadata.Country);
    const district = textValue(metadata.Sublocation);
    const address = textValue(metadata.GPSAreaInformation);
    const hasLocationText = Boolean(
      city || region || country || district || address,
    );
    return {
      capturedAt:
        dateValue(metadata.DateTimeOriginal) ||
        dateValue(metadata.CreateDate) ||
        dateValue(metadata.DateTime),
      location:
        latitude !== undefined || longitude !== undefined || hasLocationText
          ? {
              latitude,
              longitude,
              source: "exif",
              confidence: 1,
              address,
              district,
              city,
              region,
              country,
            }
          : undefined,
    };
  } catch {
    return {};
  }
}

export function locationLabel(
  location: PhotoLocation | undefined,
  detail: "broad" | "city" | "precise" = "precise",
): string {
  if (!location) return "未识别地点";
  const broad = [location.country, location.region].filter(Boolean).join(" · ");
  const city = [location.city, location.district].filter(Boolean).join(" · ");
  const precise = location.landmark || location.address;
  if (detail === "broad") return broad || city || precise || "未识别地点";
  if (detail === "city") return city || broad || precise || "未识别地点";
  return precise || city || broad || "未识别地点";
}

export function albumSearchDocument(item: AlbumItem): string {
  return [
    item.name,
    item.note,
    item.analysis?.description,
    item.analysis?.scene,
    item.analysis?.activity,
    item.analysis?.peopleSummary,
    item.analysis?.timeOfDay,
    item.analysis?.searchText,
    ...(item.analysis?.tags || []),
    ...(item.analysis?.objects || []),
    ...(item.analysis?.visibleText || []),
    item.location?.landmark,
    item.location?.address,
    item.location?.district,
    item.location?.city,
    item.location?.region,
    item.location?.country,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function searchAlbumItems(
  items: AlbumItem[],
  query: string,
): AlbumItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  const tokens = normalized.split(/[\s,，。、“”‘’]+/).filter(Boolean);
  return items.filter((item) => {
    const document = albumSearchDocument(item);
    return (
      document.includes(normalized) ||
      tokens.every((token) => document.includes(token))
    );
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error("只支持图片文件"));
  }
  if (file.size > 20 * 1024 * 1024) {
    return Promise.reject(new Error("图片不能超过 20 MB"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
