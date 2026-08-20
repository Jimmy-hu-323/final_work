declare const VITE_API_BASE_URL: string;
declare const TOKEN: string;

const AUTH_TOKEN_KEY = "qwenpaw_auth_token";
const API_BASE_URL_KEY = "lensgo_qwenpaw_api_base_url";

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Resolve the QwenPaw server selected by the Android client at runtime. */
export function getApiBaseUrl(): string {
  const stored = localStorage.getItem(API_BASE_URL_KEY);
  if (stored) return normalizeBaseUrl(stored);
  return normalizeBaseUrl(VITE_API_BASE_URL || "");
}

export function setApiBaseUrl(value: string): void {
  const normalized = normalizeBaseUrl(value);
  if (normalized) {
    localStorage.setItem(API_BASE_URL_KEY, normalized);
  } else {
    localStorage.removeItem(API_BASE_URL_KEY);
  }
}

export function clearApiBaseUrl(): void {
  localStorage.removeItem(API_BASE_URL_KEY);
}

/**
 * Get the full API URL with /api prefix
 * @param path - API path (e.g., "/models", "/skills")
 * @returns Full API URL (e.g., "http://localhost:8088/api/models" or "/api/models")
 */
export function getApiUrl(path: string): string {
  const base = getApiBaseUrl();
  const apiPrefix = "/api";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${apiPrefix}${normalizedPath}`;
}

/**
 * Get the API token - checks localStorage first (auth login),
 * then falls back to the build-time TOKEN constant.
 * @returns API token string or empty string
 */
export function getApiToken(): string {
  const stored = localStorage.getItem(AUTH_TOKEN_KEY);
  if (stored) return stored;
  return typeof TOKEN !== "undefined" ? TOKEN : "";
}

/**
 * Store the auth token in localStorage after login.
 */
export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

/**
 * Remove the auth token from localStorage (logout / 401).
 */
export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}
