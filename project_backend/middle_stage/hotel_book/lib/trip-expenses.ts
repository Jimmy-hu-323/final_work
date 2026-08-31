/**
 * Trip expense ledger: every cost an itinerary commits the traveller to.
 *
 * Hotel bills already live in `bills`, but a trip also needs tickets, transport
 * and meals before the 账单 page can answer "what will this trip cost me". Those
 * line items land here so the phone can total them, edit them and point each one
 * at the place it belongs to.
 */
import { database as db, ensureData, id, isoNow } from "./hotel-store";

export type ExpenseCategory = "hotel" | "ticket" | "transport" | "meal" | "other";

export type TripExpense = {
  id: string;
  trip_id: string;
  category: ExpenseCategory;
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

type D1Row = Record<string, string | number | null>;

/** Bump when MACAU_ATTRACTIONS changes so an existing D1 file is reseeded. */
const ATTRACTION_CATALOGUE_VERSION = "2026-08-macau-tickets-v1";

/**
 * Real Macau sights with their published admission. Amounts are CNY cents,
 * converted from the MOP gate price at roughly 0.91 and rounded to the yuan;
 * they are indicative, not a live ticketing feed. Free sights are kept in the
 * catalogue so the planner can show a day's real cost is zero.
 */
const MACAU_ATTRACTIONS = [
  ["poi_ruins_st_paul", "大三巴牌坊", "澳门半岛", "landmark", 0, 22.1976, 113.5416, "世界遗产，全天开放，免费"],
  ["poi_a_ma_temple", "妈阁庙", "澳门半岛", "landmark", 0, 22.1861, 113.5312, "世界遗产，免费"],
  ["poi_senado_square", "议事亭前地", "澳门半岛", "landmark", 0, 22.1936, 113.5395, "历史城区核心，免费"],
  ["poi_mandarin_house", "郑家大屋", "澳门半岛", "museum", 0, 22.1885, 113.532, "免费，周三闭馆"],
  ["poi_penha_chapel", "主教山小堂", "澳门半岛", "landmark", 0, 22.1868, 113.533, "免费，可俯瞰南湾"],
  ["poi_love_lane", "恋爱巷", "澳门半岛", "landmark", 0, 22.1972, 113.5408, "免费，大三巴旁的粉色小巷"],
  ["poi_macau_museum", "澳门博物馆", "澳门半岛", "museum", 1400, 22.1972, 113.541, "成人票 MOP15，周二免费"],
  ["poi_macau_tower", "澳门旅游塔观光层", "澳门半岛", "ticket", 17800, 22.1455, 113.5372, "58 层观光主层，成人票 MOP195"],
  ["poi_tower_skywalk", "旅游塔空中漫步", "澳门半岛", "ticket", 80800, 22.1455, 113.5372, "233 米高空环走，MOP888"],
  ["poi_guia_cable_car", "松山缆车", "澳门半岛", "transport", 200, 22.199, 113.548, "单程 MOP2，全球最短缆车"],
  ["poi_fishermans_wharf", "澳门渔人码头", "澳门半岛", "landmark", 0, 22.193, 113.556, "免费开放的主题园区"],
  ["poi_science_center", "澳门科学馆展览中心", "澳门半岛", "museum", 2300, 22.1889, 113.5606, "展览中心成人票 MOP25"],
  ["poi_taipa_houses", "龙环葡韵住宅式博物馆", "氹仔", "museum", 500, 22.156, 113.5626, "成人票 MOP5"],
  ["poi_rua_do_cunha", "官也街", "氹仔", "landmark", 0, 22.1565, 113.558, "免费，手信与小吃street"],
  ["poi_eiffel_tower", "巴黎人铁塔观景台", "路氹金光大道", "ticket", 9100, 22.1425, 113.5648, "7 层与 37 层观景台，MOP100"],
  ["poi_gondola", "威尼斯人贡多拉船", "路氹金光大道", "ticket", 14400, 22.1459, 113.5645, "每人 MOP158，含船夫演唱"],
  ["poi_golden_reel", "影汇之星 8 字摩天轮", "路氹金光大道", "ticket", 9100, 22.147, 113.571, "全球唯一 8 字摩天轮，MOP100"],
  ["poi_house_of_dancing_water", "水舞间", "路氹金光大道", "show", 61900, 22.149, 113.568, "新濠天地水上汇演，A 区 MOP680 起"],
  ["poi_panda_pavilion", "石排湾郊野公园大熊猫馆", "路环", "ticket", 900, 22.1263, 113.562, "成人票 MOP10"],
  ["poi_hac_sa_beach", "黑沙海滩", "路环", "landmark", 0, 22.1195, 113.573, "免费，澳门唯一黑沙滩"],
  ["poi_coloane_village", "路环市区", "路环", "landmark", 0, 22.1168, 113.5555, "免费，安德鲁饼店所在地"],
  ["poi_shuttle_bus", "赌场免费穿梭巴士", "全澳", "transport", 0, 22.1667, 113.5528, "各大度假村之间免费接驳"],
  ["poi_public_bus", "澳门公共巴士", "全澳", "transport", 600, 22.1667, 113.5528, "单程 MOP6，可用澳门通"],
] as const;

async function ensureExpenseTables() {
  // `schema_meta` and the hotel catalogue are created by the base store.
  await ensureData();
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS trip_expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      trip_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      place_name TEXT NOT NULL DEFAULT '',
      latitude REAL,
      longitude REAL,
      day INTEGER,
      unit_amount INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      currency TEXT NOT NULL DEFAULT 'CNY',
      required INTEGER NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'agent',
      booking_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS attractions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      area TEXT NOT NULL,
      category TEXT NOT NULL,
      ticket_amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    )`),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS trip_expenses_user_idx ON trip_expenses(user_id, trip_id)",
    ),
  ]);
}

async function seedAttractions() {
  const d1 = db();
  const seeded = await d1
    .prepare("SELECT value FROM schema_meta WHERE key = 'attraction_catalogue'")
    .first<{ value: string }>();
  if (seeded?.value === ATTRACTION_CATALOGUE_VERSION) return;

  const statements = [d1.prepare("DELETE FROM attractions")];
  for (const [poiId, name, area, category, amount, lat, lon, note] of MACAU_ATTRACTIONS) {
    statements.push(
      d1
        .prepare(`INSERT INTO attractions
          (id, name, area, category, ticket_amount, currency, latitude, longitude, note)
          VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?)`)
        .bind(poiId, name, area, category, amount, lat, lon, note),
    );
  }
  statements.push(
    d1
      .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('attraction_catalogue', ?)")
      .bind(ATTRACTION_CATALOGUE_VERSION),
  );
  await d1.batch(statements);
}

let expenseInit: Promise<void> | null = null;

export async function ensureExpenseData() {
  if (!expenseInit) {
    expenseInit = (async () => {
      await ensureExpenseTables();
      await seedAttractions();
    })();
  }
  try {
    await expenseInit;
  } catch (error) {
    expenseInit = null;
    throw error;
  }
}

function toExpense(row: D1Row): TripExpense {
  const unit = Number(row.unit_amount);
  const quantity = Number(row.quantity) || 1;
  return {
    id: String(row.id),
    trip_id: String(row.trip_id || ""),
    category: String(row.category) as ExpenseCategory,
    title: String(row.title),
    place_name: String(row.place_name || ""),
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    day: row.day === null ? null : Number(row.day),
    unit_amount: unit,
    quantity,
    amount: unit * quantity,
    currency: String(row.currency || "CNY"),
    required: Number(row.required) === 1,
    note: String(row.note || ""),
    source: String(row.source || "agent"),
    booking_id: row.booking_id === null ? null : String(row.booking_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function listAttractions() {
  await ensureExpenseData();
  const { results } = await db()
    .prepare("SELECT * FROM attractions ORDER BY area, ticket_amount DESC")
    .all<D1Row>();
  return results.map((row: D1Row) => ({
    id: String(row.id),
    name: String(row.name),
    area: String(row.area),
    category: String(row.category),
    ticket_amount: Number(row.ticket_amount),
    currency: String(row.currency),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    note: String(row.note),
  }));
}

export async function listTripExpenses(userId: string, tripId?: string) {
  await ensureExpenseData();
  const d1 = db();
  const { results } = tripId
    ? await d1
        .prepare(
          "SELECT * FROM trip_expenses WHERE user_id = ? AND trip_id = ? ORDER BY day, created_at",
        )
        .bind(userId, tripId)
        .all<D1Row>()
    : await d1
        .prepare("SELECT * FROM trip_expenses WHERE user_id = ? ORDER BY day, created_at")
        .bind(userId)
        .all<D1Row>();
  return results.map(toExpense);
}

export type ExpenseInput = {
  tripId?: string;
  category?: string;
  title: string;
  placeName?: string;
  latitude?: number | null;
  longitude?: number | null;
  day?: number | null;
  unitAmount: number;
  quantity?: number;
  currency?: string;
  required?: boolean;
  note?: string;
  source?: string;
  bookingId?: string | null;
};

const CATEGORIES: ExpenseCategory[] = ["hotel", "ticket", "transport", "meal", "other"];

function normalizeCategory(value: string | undefined): ExpenseCategory {
  return CATEGORIES.includes(value as ExpenseCategory) ? (value as ExpenseCategory) : "other";
}

export async function createTripExpense(userId: string, input: ExpenseInput) {
  await ensureExpenseData();
  const title = (input.title || "").trim();
  if (!title) throw new Error("EXPENSE_TITLE_REQUIRED");
  const unitAmount = Math.round(Number(input.unitAmount));
  if (!Number.isFinite(unitAmount) || unitAmount < 0) throw new Error("EXPENSE_AMOUNT_INVALID");
  const quantity = Math.max(1, Math.round(Number(input.quantity) || 1));
  const now = isoNow();
  const expenseId = id("expense");
  await db()
    .prepare(`INSERT INTO trip_expenses
      (id, user_id, trip_id, category, title, place_name, latitude, longitude, day,
       unit_amount, quantity, currency, required, note, source, booking_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      expenseId,
      userId,
      (input.tripId || "").trim(),
      normalizeCategory(input.category),
      title,
      (input.placeName || "").trim(),
      input.latitude ?? null,
      input.longitude ?? null,
      input.day ?? null,
      unitAmount,
      quantity,
      (input.currency || "CNY").trim() || "CNY",
      input.required === false ? 0 : 1,
      (input.note || "").trim(),
      (input.source || "agent").trim(),
      input.bookingId ?? null,
      now,
      now,
    )
    .run();
  return getTripExpense(userId, expenseId);
}

export async function getTripExpense(userId: string, expenseId: string) {
  await ensureExpenseData();
  const row = await db()
    .prepare("SELECT * FROM trip_expenses WHERE id = ? AND user_id = ?")
    .bind(expenseId, userId)
    .first<D1Row>();
  return row ? toExpense(row) : null;
}

/** Partial update; only the fields present in `patch` are written. */
export async function updateTripExpense(
  userId: string,
  expenseId: string,
  patch: Partial<ExpenseInput>,
) {
  const existing = await getTripExpense(userId, expenseId);
  if (!existing) return null;

  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) throw new Error("EXPENSE_TITLE_REQUIRED");
    set("title", title);
  }
  if (patch.unitAmount !== undefined) {
    const unitAmount = Math.round(Number(patch.unitAmount));
    if (!Number.isFinite(unitAmount) || unitAmount < 0) throw new Error("EXPENSE_AMOUNT_INVALID");
    set("unit_amount", unitAmount);
  }
  if (patch.quantity !== undefined) {
    set("quantity", Math.max(1, Math.round(Number(patch.quantity) || 1)));
  }
  if (patch.category !== undefined) set("category", normalizeCategory(patch.category));
  if (patch.placeName !== undefined) set("place_name", String(patch.placeName).trim());
  if (patch.latitude !== undefined) set("latitude", patch.latitude ?? null);
  if (patch.longitude !== undefined) set("longitude", patch.longitude ?? null);
  if (patch.day !== undefined) set("day", patch.day ?? null);
  if (patch.currency !== undefined) set("currency", String(patch.currency).trim() || "CNY");
  if (patch.required !== undefined) set("required", patch.required ? 1 : 0);
  if (patch.note !== undefined) set("note", String(patch.note).trim());

  if (!assignments.length) return existing;
  set("updated_at", isoNow());
  values.push(expenseId, userId);

  await db()
    .prepare(`UPDATE trip_expenses SET ${assignments.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values)
    .run();
  return getTripExpense(userId, expenseId);
}

export async function deleteTripExpense(userId: string, expenseId: string) {
  await ensureExpenseData();
  const result = await db()
    .prepare("DELETE FROM trip_expenses WHERE id = ? AND user_id = ?")
    .bind(expenseId, userId)
    .run();
  return Boolean(result.meta?.changes);
}

/** Remove every bill line belonging to one trip in a single database write. */
export async function deleteTripExpenses(userId: string, tripId: string) {
  await ensureExpenseData();
  const result = await db()
    .prepare("DELETE FROM trip_expenses WHERE user_id = ? AND trip_id = ?")
    .bind(userId, tripId)
    .run();
  return Number(result.meta?.changes || 0);
}

/** Totals the 账单 page shows above the line items. */
export function summarizeExpenses(expenses: TripExpense[]) {
  const byCategory: Record<string, number> = {};
  let total = 0;
  let requiredTotal = 0;
  for (const expense of expenses) {
    total += expense.amount;
    if (expense.required) requiredTotal += expense.amount;
    byCategory[expense.category] = (byCategory[expense.category] || 0) + expense.amount;
  }
  return {
    total,
    required_total: requiredTotal,
    optional_total: total - requiredTotal,
    by_category: byCategory,
    count: expenses.length,
    currency: expenses[0]?.currency || "CNY",
  };
}
