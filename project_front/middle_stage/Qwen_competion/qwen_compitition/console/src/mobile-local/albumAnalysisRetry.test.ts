import { describe, expect, it, vi } from "vitest";
import {
  isTransientAlbumAnalysisError,
  retryAlbumAnalysis,
} from "./albumAnalysisRetry";

describe("album analysis retry", () => {
  it("retries a transient connection error and returns the later result", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("error sending request for url"))
      .mockResolvedValueOnce("ready");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryAlbumAnalysis(operation, { sleep, delayMs: 10 }),
    ).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("does not retry an invalid API key", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new Error("401 invalid API Key"));

    await expect(
      retryAlbumAnalysis(operation, { sleep: vi.fn() }),
    ).rejects.toThrow("401");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(isTransientAlbumAnalysisError(new Error("网络连接超时"))).toBe(true);
  });
});
