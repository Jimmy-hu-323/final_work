import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { departureChoices, departureCrowd, departureGuidePlaces, fallbackDepartureOrigin, locateDepartureOrigin } from "./tripDeparture";
import TripDepartureChoices from "./TripDepartureChoices";
import type { CrowdPlace } from "./tripJourney";
import type { LocalTrip, TripPosition } from "./runtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const now = Date.UTC(2026, 7, 28, 12);
const position: TripPosition = { latitude: 22.19, longitude: 113.54, accuracy: 5, recordedAt: now };
const place = (id: string, offset: number, level = 1): CrowdPlace => ({
  region_id: id, name: id, aliases: [], center: [113.54, 22.19 + offset],
  reading: { people_count: 120, crowd_level: level, observed_at: new Date(now).toISOString(), batch_id: "test" },
});
const trip: LocalTrip = { id: "test", title: "原有行程", request: "", content: "不改正文", createdAt: now,
  stops: [{ id: "old-first", name: "far", latitude: 22.22, longitude: 113.54 }] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("departure based on actual location", () => {
  it("sorts by distance, excludes current place, and never mutates the itinerary", () => {
    const before = JSON.stringify(trip);
    const places = [place("far", .03), place("here", 0), place("near", .002), place("middle", .01)];
    expect(departureChoices(trip, position, places, now).map((item) => item.stop.name)).toEqual(["near", "middle", "far"]);
    expect(departureGuidePlaces(trip, places).find((stop) => stop.name === "far")?.id).toBe("old-first");
    expect(JSON.stringify(trip)).toBe(before);
    const moved = { ...position, latitude: 22.219 };
    expect(departureChoices(trip, moved, places, now)[0].stop.name).not.toBe("far");
  });
  it("uses real counts and distinct level colors, with unknown/stale shown in grey", () => {
    expect([0, 1, 2, 3, 4].map((level) => departureCrowd(place("p", .01, level), now).color))
      .toEqual(["success", "success", "warning", "error", "error"]);
    const zero = place("zero", .01); zero.reading!.people_count = 0;
    expect(departureCrowd(zero, now).text).toContain("0 人");
    const old = place("old", .01); old.reading!.observed_at = new Date(now - 31 * 60_000).toISOString();
    const future = place("future", .01); future.reading!.observed_at = new Date(now + 120_000).toISOString();
    expect(departureCrowd(old, now).color).toBe("default");
    expect(departureCrowd(old, now).updated).toContain("非当前人数");
    expect(departureCrowd(future, now).color).toBe("default");
    expect(departureCrowd(undefined, now).text).toBe("暂无人数数据");
  });
  it("falls back without inventing hotels and handles unavailable map service", async () => {
    expect(fallbackDepartureOrigin(position, [place("真实地标", 0)]).label).toContain("真实地标附近");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("private-endpoint"));
    const origin = await locateDepartureOrigin(position, []);
    expect(origin.available).toBe(false);
    expect(origin.label).toContain("暂未识别");
    expect(JSON.stringify(origin)).not.toContain("private-endpoint");
  });
  it("handles missing catalog, invalid coordinates, duplicates and distant places", () => {
    expect(departureChoices(trip, position, [], now)[0].crowd.color).toBe("default");
    const invalid = place("invalid", .01); invalid.center = [NaN, 22];
    expect(departureChoices({ ...trip, stops: [] }, position, [invalid, place("far", 1)], now)).toHaveLength(0);
    expect(departureChoices(trip, position, [place("near", .002), place("near", .002)], now).filter((c) => c.stop.name === "near")).toHaveLength(1);
  });
  it("shows place, count, distance and choice using existing UI controls", () => {
    const choose = vi.fn();
    render(<TripDepartureChoices origin={{ available: true, label: "你目前在酒店附近", source: "地图识别" }}
      choices={departureChoices(trip, position, [place("附近景点", .002, 2)], now)} onChoose={choose} />);
    expect(screen.getByText("你目前在酒店附近")).toBeTruthy();
    expect(screen.getByText("120 人 · 适中").className).toContain("warning");
    fireEvent.click(screen.getByRole("button", { name: "去附近景点" }));
    expect(choose.mock.calls[0][0].name).toBe("附近景点");
  });
});
