import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

import {
  fetchCrowdPlaces,
  loadCrowdServiceConfig,
  saveCrowdServiceConfig,
} from "./tripJourney";

const STORAGE_KEY = "lensgo_crowd_service_v1";

describe("crowd API key browser fallback", () => {
  beforeEach(async () => {
    localStorage.clear();
    await saveCrowdServiceConfig(
      { baseUrl: "http://127.0.0.1:18099", apiKey: "", hasApiKey: false },
      true,
    );
    vi.restoreAllMocks();
  });

  it("migrates a legacy read token without retaining it in localStorage", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        baseUrl: "http://127.0.0.1:18099/",
        readToken: "legacy-secret",
      }),
    );

    const config = await loadCrowdServiceConfig();

    expect(config).toMatchObject({
      baseUrl: "http://127.0.0.1:18099",
      apiKey: "",
      hasApiKey: true,
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ baseUrl: "http://127.0.0.1:18099" }),
    );
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain("legacy-secret");
  });

  it("uses Bearer auth for the read-only density endpoint only", async () => {
    const config = await saveCrowdServiceConfig({
      baseUrl: "http://127.0.0.1:18099",
      apiKey: "lgc_live_device_secret",
      hasApiKey: false,
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        json: async () => ({ generated_at: "now", count: 0, items: [] }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchCrowdPlaces(config);

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain("/api/density/latest?");
    expect(String(call?.[0])).not.toContain("/api/amap");
    expect((call?.[1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer lgc_live_device_secret",
    );
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(
      "lgc_live_device_secret",
    );
  });
});
