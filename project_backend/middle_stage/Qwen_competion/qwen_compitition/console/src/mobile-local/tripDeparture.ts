import { invoke } from "@tauri-apps/api/core";
import type { LocalTrip, TripPosition, TripStop } from "./runtime";
import { crowdLabel, distanceMeters, matchStopToCrowdPlace, type CrowdPlace } from "./tripJourney";

export type DepartureOrigin = { available: boolean; label?: string; reason?: string; source?: string };
export type DepartureChoice = {
  stop: TripStop; distance: number;
  crowd: { text: string; color: "default" | "success" | "warning" | "error"; updated: string };
};

export function validGuideStop(stop: TripStop): boolean {
  return Number.isFinite(stop.latitude) && Math.abs(stop.latitude!) <= 90 &&
    Number.isFinite(stop.longitude) && Math.abs(stop.longitude!) <= 180;
}

// Keep the written itinerary intact. These are optional known guide locations,
// not a reordered route or a new booking/itinerary API contract.
export function departureGuidePlaces(trip: LocalTrip, places: CrowdPlace[]): TripStop[] {
  return places.filter((place) => place.center?.length === 2).map((place): TripStop => {
    const existing = trip.stops?.find((stop) => matchStopToCrowdPlace(stop, [place]));
    return existing && validGuideStop(existing) ? existing : {
      id: `guide-${place.region_id}`, name: place.name, crowdRegionId: place.region_id,
      longitude: place.center![0], latitude: place.center![1], radiusM: 120,
    };
  }).filter(validGuideStop);
}

export function departureCrowd(place: CrowdPlace | undefined, now = Date.now()): DepartureChoice["crowd"] {
  const reading = place?.reading;
  if (!reading || !Number.isFinite(reading.people_count) || reading.people_count < 0) {
    return { text: "暂无人数数据", color: "default", updated: "无法判断当前拥挤程度" };
  }
  const observed = Date.parse(reading.observed_at);
  const validTime = Number.isFinite(observed) && observed <= now + 60_000;
  const updated = validTime ? `更新于 ${new Date(observed).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "更新时间无效";
  if (!validTime || now - observed > 30 * 60_000) {
    return { text: `${reading.people_count} 人 · 已过期/不可用`, color: "default", updated: `${updated}，非当前人数` };
  }
  const level = reading.crowd_level;
  if (!Number.isInteger(level) || level < 0 || level > 4) {
    return { text: `${reading.people_count} 人 · 等级未知`, color: "default", updated };
  }
  return { text: `${reading.people_count} 人 · ${crowdLabel(level)}`, color: level >= 3 ? "error" : level === 2 ? "warning" : "success", updated };
}

export function departureChoices(trip: LocalTrip, position: TripPosition, places: CrowdPlace[], now = Date.now()): DepartureChoice[] {
  const known = departureGuidePlaces(trip, places);
  const candidates = [...known, ...(trip.stops || [])];
  const seen = new Set<string>();
  return candidates.flatMap((stop) => {
    if (!validGuideStop(stop)) return [];
    const place = matchStopToCrowdPlace(stop, places);
    const key = place?.region_id || stop.crowdRegionId || `${stop.name}:${stop.latitude}:${stop.longitude}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const distance = distanceMeters(position, { latitude: stop.latitude!, longitude: stop.longitude! });
    // Recommend another place, not the POI the visitor is already standing at.
    if (distance < 120 || distance > 8000) return [];
    return [{ stop, distance, crowd: departureCrowd(place, now) }];
  }).sort((a, b) => a.distance - b.distance).slice(0, 4);
}

export function fallbackDepartureOrigin(position: TripPosition, places: CrowdPlace[]): DepartureOrigin {
  const near = departureGuidePlaces({} as LocalTrip, places).map((stop) => ({
    stop, distance: distanceMeters(position, { latitude: stop.latitude!, longitude: stop.longitude! }),
  })).sort((a, b) => a.distance - b.distance)[0];
  return near && near.distance <= 120
    ? { available: true, label: `你目前在${near.stop.name}附近`, source: "景点目录距离匹配（未确认具体建筑）" }
    : { available: false, label: "已获取当前位置，具体地点暂未识别", reason: "不会假定你在酒店或行程第一站" };
}

export async function locateDepartureOrigin(position: TripPosition, places: CrowdPlace[]): Promise<DepartureOrigin> {
  try {
    const result = await invoke<DepartureOrigin>("mobile_trip_guide_origin", {
      latitude: position.latitude, longitude: position.longitude,
    });
    if (result.available && typeof result.label === "string" && result.label.trim()) return result;
  } catch { /* Transport errors may contain private endpoint information. */ }
  return fallbackDepartureOrigin(position, places);
}
