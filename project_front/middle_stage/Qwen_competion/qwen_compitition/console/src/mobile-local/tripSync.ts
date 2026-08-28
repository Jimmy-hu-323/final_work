import type {
  LocalTrip,
  QwenPawTravelActivity,
  QwenPawTravelItinerary,
  TripStop,
} from "./runtime";
import { extractTripPlan } from "./tripJourney";

export type AgentTripProposal = {
  tripId: string;
  title?: string;
  content: string;
  stops: LocalTrip["stops"];
  sourceUpdatedAt?: number;
};

function jsonObject(value: string): Record<string, unknown> | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function proposalFromObject(
  raw: Record<string, unknown>,
): AgentTripProposal | null {
  const rawTripId = raw.tripId ?? raw.trip_id;
  const tripId = typeof rawTripId === "string" ? rawTripId.trim() : "";
  if (!tripId) return null;
  const plan = extractTripPlan(
    JSON.stringify({
      markdown: raw.markdown ?? raw.content,
      stops: raw.stops,
    }),
    [],
  );
  if (!plan.content.trim() || !plan.stops.length) return null;
  return {
    tripId,
    title: typeof raw.title === "string" ? raw.title.trim() : undefined,
    content: plan.content,
    stops: plan.stops,
  };
}

/** Accept the documented block plus harmless fence/name variations from models. */
export function extractAgentTripProposal(
  value: string,
): AgentTripProposal | null {
  const candidates: string[] = [];
  for (const match of value.matchAll(
    /```(?:lensgo[-_]trip[-_]update|json)?\s*([\s\S]*?)```/gi,
  )) {
    candidates.push(match[1]);
  }
  const xml = value.match(
    /<lensgo[-_]trip[-_]update>([\s\S]*?)<\/lensgo[-_]trip[-_]update>/i,
  );
  if (xml) candidates.push(xml[1]);
  candidates.push(value);

  for (const candidate of candidates) {
    const raw = jsonObject(candidate);
    if (!raw) continue;
    const proposal = proposalFromObject(raw);
    if (proposal) return proposal;
  }
  return null;
}

function stripTrailingProposalJson(value: string): string {
  const end = value.lastIndexOf("}");
  if (end < 0 || value.slice(end + 1).trim()) return value;
  let start = value.lastIndexOf("{", end);
  while (start >= 0) {
    try {
      const raw = JSON.parse(value.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      if (proposalFromObject(raw)) {
        return `${value.slice(0, start)}${value.slice(end + 1)}`;
      }
    } catch {
      // Keep looking for the outer opening brace of a nested JSON object.
    }
    start = value.lastIndexOf("{", start - 1);
  }
  return value;
}

/** Hide machine-readable trip bridge payloads while keeping them parseable upstream. */
export function stripAgentControlContent(value: string): string {
  let visible = value
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(
      /<lensgo[-_]trip[-_]update\b[^>]*>[\s\S]*?(?:<\/lensgo[-_]trip[-_]update\s*>|$)/gi,
      "",
    )
    .replace(
      /```lensgo[-_]trip[-_]update\b[^\n]*\n?[\s\S]*?(?:```|$)/gi,
      "",
    );

  visible = visible.replace(
    /```json\s*([\s\S]*?)```/gi,
    (block, body: string) => {
      const raw = jsonObject(body);
      return raw && proposalFromObject(raw) ? "" : block;
    },
  );
  visible = stripTrailingProposalJson(visible);
  return visible.replace(/\n{3,}/g, "\n\n").trim();
}

function coordinate(
  location?: string,
): { longitude: number; latitude: number } | null {
  if (!location) return null;
  const [longitude, latitude] = location
    .split(",")
    .map((part) => Number(part.trim()));
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { longitude, latitude };
}

function activityNote(activity: QwenPawTravelActivity): string | undefined {
  const leg = activity.travel_from_previous;
  const travel = leg
    ? [
        leg.mode === "walking"
          ? "步行"
          : leg.mode === "transit"
          ? "公交"
          : "驾车",
        leg.distance_meters
          ? leg.distance_meters >= 1000
            ? `${(leg.distance_meters / 1000).toFixed(1)} 公里`
            : `${Math.round(leg.distance_meters)} 米`
          : "",
        leg.duration_text || "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    [travel ? `从上一站${travel}` : "", activity.note || ""]
      .filter(Boolean)
      .join("；") || undefined
  );
}

function itineraryMarkdown(itinerary: QwenPawTravelItinerary): string {
  const lines = [`# ${itinerary.title || "澳门行程"}`, ""];
  itinerary.days.forEach((day, dayIndex) => {
    lines.push(
      `## 第 ${day.day_number || dayIndex + 1} 天 · ${day.title || "行程"}`,
      "",
    );
    day.activities.forEach((activity) => {
      const time = activity.arrive_time || activity.depart_time || "待定";
      const note = activityNote(activity);
      lines.push(`- **${time} ${activity.name}**${note ? `：${note}` : ""}`);
    });
    lines.push("");
  });
  return lines.join("\n").trim();
}

/** Convert the server's authoritative AMap snapshot into the phone's local model. */
export function proposalFromRemoteItinerary(
  itinerary: QwenPawTravelItinerary,
): AgentTripProposal | null {
  const stops: TripStop[] = [];
  itinerary.days.forEach((day, dayIndex) => {
    day.activities.forEach((activity, activityIndex) => {
      if (!activity?.name?.trim()) return;
      const point = coordinate(activity.location);
      stops.push({
        id: `day-${day.day_number || dayIndex + 1}-stop-${
          activity.order || activityIndex + 1
        }`,
        name: activity.name.trim(),
        day: day.day_number || dayIndex + 1,
        time: activity.arrive_time || activity.depart_time,
        note: activityNote(activity),
        longitude: point?.longitude,
        latitude: point?.latitude,
      });
    });
  });
  if (!stops.length) return null;
  const sourceUpdatedAt = itinerary.updated_at
    ? Date.parse(itinerary.updated_at)
    : Number.NaN;
  return {
    tripId: "new",
    title: itinerary.title || "QwenPaw 澳门行程",
    content: itineraryMarkdown(itinerary),
    stops,
    sourceUpdatedAt: Number.isFinite(sourceUpdatedAt)
      ? sourceUpdatedAt
      : undefined,
  };
}

export function remoteItinerarySignature(
  itinerary: QwenPawTravelItinerary | null,
): string {
  return itinerary ? JSON.stringify(itinerary) : "";
}
