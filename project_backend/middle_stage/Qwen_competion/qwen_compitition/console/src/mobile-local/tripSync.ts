import type {
  LocalTrip,
  QwenPawTravelActivity,
  QwenPawTravelItinerary,
  TripExpenseCategory,
  TripExpenseInput,
  TripStop,
} from "./runtime";
import { extractTripPlan } from "./tripJourney";

export type AgentTripProposal = {
  tripId: string;
  title?: string;
  content: string;
  stops: LocalTrip["stops"];
  expenses: TripExpenseInput[];
  sourceUpdatedAt?: number;
};

const EXPENSE_CATEGORIES = new Set<TripExpenseCategory>([
  "hotel",
  "ticket",
  "transport",
  "meal",
  "other",
]);

function expenseCategory(value: unknown, text = ""): TripExpenseCategory {
  if (
    typeof value === "string" &&
    EXPENSE_CATEGORIES.has(value as TripExpenseCategory)
  ) {
    return value as TripExpenseCategory;
  }
  if (/酒店|住宿|民宿|房费/.test(text)) return "hotel";
  if (/门票|票价|入场|展览|演出/.test(text)) return "ticket";
  if (/交通|公交|巴士|的士|出租|打车|车费|船票/.test(text)) {
    return "transport";
  }
  if (/餐|早餐|午饭|午餐|晚饭|晚餐|美食|饮料|咖啡/.test(text)) {
    return "meal";
  }
  return "other";
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function amountYuanFromLine(line: string): number | null {
  const range = line.match(
    /(?:[¥￥]\s*)?(\d+(?:\.\d+)?)\s*(?:-|–|—|~|～|至)\s*(\d+(?:\.\d+)?)\s*元/,
  );
  if (range) return positiveNumber(range[2]);
  const values = [
    ...line.matchAll(/(?:[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*元)/g),
  ]
    .map((match) => positiveNumber(match[1] || match[2]))
    .filter((value): value is number => value !== null);
  return values[values.length - 1] || null;
}

function matchedStopName(line: string, stops: TripStop[]): string | undefined {
  return stops
    .map((stop) => stop.name.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((name) => line.includes(name));
}

function expenseTitle(line: string, category: TripExpenseCategory): string {
  const cleaned = line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*|\|)/, "")
    .replace(/\|/g, " ")
    .replace(
      /(?:[¥￥]\s*)?\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至)\s*\d+(?:\.\d+)?\s*元/g,
      "",
    )
    .replace(/(?:[¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*元)/g, "")
    .replace(/(?:预算|预计|约|大约|参考价|费用)\s*[:：]?/g, "")
    .replace(/[：:，,；;·\-\s]+$/g, "")
    .trim();
  if (cleaned) return cleaned.slice(0, 80);
  return `${
    {
      hotel: "住宿",
      ticket: "门票",
      transport: "交通",
      meal: "餐饮",
      other: "行程",
    }[category]
  }预算估算`;
}

/** Build conservative bill rows when an older Agent only returns Markdown costs. */
export function budgetExpensesFromMarkdown(
  markdown: string,
  stops: TripStop[],
): TripExpenseInput[] {
  const costLines = markdown
    .split(/\r?\n/)
    .map((line) => ({ line, amountYuan: amountYuanFromLine(line) }))
    .filter(
      (item): item is { line: string; amountYuan: number } =>
        item.amountYuan !== null && item.amountYuan <= 1_000_000,
    );
  const detailLines = costLines.filter(
    ({ line }) => !/总计|合计|预算|费用总额/.test(line),
  );
  const selected = detailLines.length
    ? detailLines
    : costLines
        .filter(({ line }) => /总计|合计|预算|费用/.test(line))
        .slice(-1);

  return selected.slice(0, 40).map(({ line, amountYuan }) => {
    const category = expenseCategory(undefined, line);
    const dayMatch = line.match(/第\s*(\d+)\s*天/);
    return {
      title: expenseTitle(line, category),
      category,
      placeName: matchedStopName(line, stops),
      day: dayMatch ? Math.max(1, Number(dayMatch[1])) : null,
      unitAmount: Math.round(amountYuan * 100),
      quantity: 1,
      required: !/可选|备选|自选/.test(line),
      note: "由行程规划生成的预算估算，实际价格请在出发前确认",
    };
  });
}

function proposalExpense(
  value: unknown,
  stops: TripStop[],
): TripExpenseInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const amountYuan = positiveNumber(
    raw.amountYuan ??
      raw.amount_yuan ??
      raw.unitAmountYuan ??
      raw.unit_amount_yuan,
  );
  if (!title || !amountYuan || amountYuan > 1_000_000) return null;
  const category = expenseCategory(raw.category, title);
  const rawPlaceName = raw.placeName ?? raw.place_name;
  const placeName =
    typeof rawPlaceName === "string" && rawPlaceName.trim()
      ? rawPlaceName.trim()
      : matchedStopName(title, stops);
  const rawDay = positiveNumber(raw.day);
  const quantity = Math.max(
    1,
    Math.min(100, Math.round(positiveNumber(raw.quantity) || 1)),
  );
  return {
    title: title.slice(0, 80),
    category,
    placeName,
    day: rawDay ? Math.max(1, Math.round(rawDay)) : null,
    unitAmount: Math.round(amountYuan * 100),
    quantity,
    required: raw.required !== false,
    note:
      typeof raw.note === "string" && raw.note.trim()
        ? raw.note.trim().slice(0, 300)
        : "由行程规划生成的预算估算，实际价格请在出发前确认",
  };
}

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
  const structuredExpenses = Array.isArray(raw.expenses)
    ? raw.expenses
        .map((value) => proposalExpense(value, plan.stops))
        .filter((value): value is TripExpenseInput => value !== null)
    : [];
  return {
    tripId,
    title: typeof raw.title === "string" ? raw.title.trim() : undefined,
    content: plan.content,
    stops: plan.stops,
    expenses: structuredExpenses.length
      ? structuredExpenses
      : budgetExpensesFromMarkdown(plan.content, plan.stops),
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
    .replace(/```lensgo[-_]trip[-_]update\b[^\n]*\n?[\s\S]*?(?:```|$)/gi, "");

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
    expenses: [],
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
