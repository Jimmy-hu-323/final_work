import { env } from "cloudflare:workers";

type D1Row = Record<string, string | number | null>;

export type Hotel = {
  id: string;
  name: string;
  area: string;
  address: string;
  stars: number;
  rating: number;
  description: string;
  accent: string;
  distance: string;
  amenities: string[];
  roomName: string;
  price: number;
  availableRooms: number;
  /** WGS-84, so the trip map and the bill can point at the same place. */
  latitude: number;
  longitude: number;
};

export type RequestIdentity = {
  userId: string;
  actorType: "user" | "agent" | "mobile";
  agentId: string | null;
  serviceAuthenticated: boolean;
};

function db() {
  if (!env.DB) {
    throw new Error("D1 database binding DB is unavailable");
  }
  return env.DB;
}

function serviceToken() {
  return String(
    (env as unknown as Record<string, unknown>).HOTEL_BOOKING_SERVICE_TOKEN || "",
  ).trim();
}

export function requestIdentityFrom(request: Request): RequestIdentity {
  const configuredToken = serviceToken();
  const authorization = request.headers.get("authorization") || "";
  const suppliedToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const serviceAuthenticated =
    configuredToken.length >= 16 &&
    suppliedToken.length === configuredToken.length &&
    suppliedToken === configuredToken;

  if (request.headers.has("x-user-id") && !serviceAuthenticated) {
    throw new Error("SERVICE_AUTHENTICATION_REQUIRED");
  }

  const actorHeader = request.headers.get("x-actor-type");
  const actorType =
    serviceAuthenticated && (actorHeader === "agent" || actorHeader === "mobile")
      ? actorHeader
      : "user";
  const trustedUserId = serviceAuthenticated
    ? request.headers.get("x-user-id")?.trim()
    : null;

  return {
    userId:
      trustedUserId ||
      request.headers.get("oai-authenticated-user-email") ||
      "demo@lvyu.local",
    actorType,
    agentId: serviceAuthenticated
      ? request.headers.get("x-agent-id")?.trim() || null
      : null,
    serviceAuthenticated,
  };
}

export function userIdFrom(request: Request) {
  return requestIdentityFrom(request).userId;
}

export function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function isoNow() {
  return new Date().toISOString();
}

export function dateOnly(offsetDays = 0) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function addMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function nightsBetween(checkIn: string, checkOut: string) {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

async function createTables() {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS hotels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      area TEXT NOT NULL,
      address TEXT NOT NULL,
      stars INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      description TEXT NOT NULL,
      accent TEXT NOT NULL,
      distance TEXT NOT NULL,
      amenities TEXT NOT NULL,
      latitude REAL NOT NULL DEFAULT 0,
      longitude REAL NOT NULL DEFAULT 0
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS daily_inventory (
      hotel_id TEXT NOT NULL,
      stay_date TEXT NOT NULL,
      room_name TEXT NOT NULL,
      price INTEGER NOT NULL,
      available_rooms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      PRIMARY KEY (hotel_id, stay_date)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      confirmation_no TEXT NOT NULL UNIQUE,
      hotel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      room_name TEXT NOT NULL,
      guests INTEGER NOT NULL,
      rooms INTEGER NOT NULL,
      status TEXT NOT NULL,
      quote_version INTEGER NOT NULL,
      total_amount INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      due_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      breakdown TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS payment_authorizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      bill_ids TEXT NOT NULL,
      max_amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      quote_versions TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS booking_quotes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      hotel_id TEXT NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      guests INTEGER NOT NULL,
      rooms INTEGER NOT NULL,
      room_name TEXT NOT NULL,
      room_total INTEGER NOT NULL,
      service_fee INTEGER NOT NULL,
      total_amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS bill_adjustment_quotes (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      breakfast INTEGER NOT NULL,
      new_amount INTEGER NOT NULL,
      new_breakdown TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS bills_user_status_idx ON bills(user_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS booking_quotes_user_idx ON booking_quotes(user_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS bill_adjustment_quotes_bill_idx ON bill_adjustment_quotes(bill_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS inventory_date_idx ON daily_inventory(stay_date)"),
  ]);
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an already-created table alone, so a D1
 * file from before the coordinates existed needs the columns added by hand.
 */
async function migrateSchema() {
  const d1 = db();
  const { results } = await d1.prepare("PRAGMA table_info(hotels)").all<D1Row>();
  const columns = new Set(results.map((row: D1Row) => String(row.name)));
  const additions: string[] = [];
  if (!columns.has("latitude")) additions.push("latitude REAL NOT NULL DEFAULT 0");
  if (!columns.has("longitude")) additions.push("longitude REAL NOT NULL DEFAULT 0");
  for (const definition of additions) {
    await d1.prepare(`ALTER TABLE hotels ADD COLUMN ${definition}`).run();
  }
}

/** Bump when MACAU_HOTELS changes so an existing D1 file is reseeded. */
const HOTEL_CATALOGUE_VERSION = "2026-08-macau-real-v1";

/**
 * Real Macau properties: names, districts, addresses, star ratings and
 * coordinates are the actual ones. Nightly rates are our own generated
 * inventory in the right market band for each property, not live quotes.
 */
const MACAU_HOTELS = [
  {
    id: "hotel_venetian",
    name: "澳门威尼斯人",
    area: "路氹金光大道",
    address: "望德圣母湾大马路",
    stars: 5,
    rating: 46,
    description: "室内运河与贡多拉船，购物、演出和餐饮都在同一栋楼里，适合第一次来澳门。",
    accent: "jade",
    distance: "距金沙城中心 400 m",
    amenities: ["贡多拉船", "大运河购物中心", "室外泳池", "免费穿梭巴士"],
    roomName: "皇室套房",
    basePrice: 158000,
    rooms: 12,
    latitude: 22.1459,
    longitude: 113.5645,
  },
  {
    id: "hotel_parisian",
    name: "澳门巴黎人",
    area: "路氹金光大道",
    address: "路氹连贯公路",
    stars: 5,
    rating: 46,
    description: "半比例埃菲尔铁塔就在门口，夜间灯光秀是路氹最好认的地标。",
    accent: "coral",
    distance: "距威尼斯人 500 m",
    amenities: ["铁塔观景台", "水上乐园", "亲子", "免费穿梭巴士"],
    roomName: "巴黎人客房",
    basePrice: 128000,
    rooms: 10,
    latitude: 22.1425,
    longitude: 113.5648,
  },
  {
    id: "hotel_wynnpalace",
    name: "澳门永利皇宫",
    area: "路氹金光大道",
    address: "体育馆大马路",
    stars: 5,
    rating: 48,
    description: "人工湖上的缆车与表演湖，房间和服务是路氹里公认最讲究的一档。",
    accent: "jade",
    distance: "距新濠天地 700 m",
    amenities: ["观光缆车", "表演湖", "米其林餐厅", "SPA"],
    roomName: "湖景豪华客房",
    basePrice: 218000,
    rooms: 6,
    latitude: 22.144,
    longitude: 113.559,
  },
  {
    id: "hotel_studiocity",
    name: "澳门新濠影汇",
    area: "路氹金光大道",
    address: "体育馆大马路",
    stars: 5,
    rating: 45,
    description: "以电影为主题，8 字形摩天轮和水上乐园让它在亲子行程里很吃香。",
    accent: "coral",
    distance: "距路氹边检站 1.5 km",
    amenities: ["影汇之星摩天轮", "水上乐园", "剧院", "免费穿梭巴士"],
    roomName: "明星汇客房",
    basePrice: 108000,
    rooms: 9,
    latitude: 22.147,
    longitude: 113.571,
  },
  {
    id: "hotel_mandarin",
    name: "澳门文华东方酒店",
    area: "澳门半岛",
    address: "孙逸仙大马路 945 号",
    stars: 5,
    rating: 47,
    description: "南湾湖畔的安静选择，没有赌场，房间视野和早餐是它的口碑所在。",
    accent: "jade",
    distance: "距澳门旅游塔 1.6 km",
    amenities: ["无赌场", "湖景", "泳池", "SPA"],
    roomName: "海景客房",
    basePrice: 198000,
    rooms: 5,
    latitude: 22.1893,
    longitude: 113.549,
  },
  {
    id: "hotel_grandlisboa",
    name: "澳门新葡京酒店",
    area: "澳门半岛",
    address: "葡京路 2-4 号",
    stars: 5,
    rating: 45,
    description: "澳门半岛最显眼的地标建筑，出门就是新马路与历史城区方向。",
    accent: "coral",
    distance: "距议事亭前地 900 m",
    amenities: ["地标建筑", "米其林餐厅", "24 小时礼宾", "近历史城区"],
    roomName: "豪华客房",
    basePrice: 168000,
    rooms: 7,
    latitude: 22.1893,
    longitude: 113.5437,
  },
  {
    id: "hotel_sofitel16",
    name: "澳门十六浦索菲特",
    area: "澳门半岛 · 内港",
    address: "巴素打尔古街",
    stars: 5,
    rating: 44,
    description: "内港老城区一侧，步行去大三巴和福隆新街都很近，价格比路氹温和。",
    accent: "sand",
    distance: "距大三巴牌坊 850 m",
    amenities: ["近大三巴", "河景", "泳池", "法式早餐"],
    roomName: "豪华客房",
    basePrice: 98000,
    rooms: 8,
    latitude: 22.1966,
    longitude: 113.5341,
  },
  {
    id: "hotel_westin",
    name: "澳门威斯汀度假酒店",
    area: "路环",
    address: "黑沙马路 1918 号",
    stars: 5,
    rating: 44,
    description: "直接连着黑沙海滩，远离赌场区，是澳门少见的度假节奏。",
    accent: "sand",
    distance: "紧邻黑沙海滩",
    amenities: ["海滩", "高尔夫", "亲子", "免费停车"],
    roomName: "海景露台房",
    basePrice: 88000,
    rooms: 6,
    latitude: 22.12,
    longitude: 113.568,
  },
  {
    id: "hotel_regencyart",
    name: "澳门丽景湾艺术酒店",
    area: "氹仔",
    address: "氹仔广东大马路",
    stars: 4,
    rating: 43,
    description: "氹仔旧城边上的中价选择，走去官也街吃小吃只要几分钟。",
    accent: "sand",
    distance: "距官也街 700 m",
    amenities: ["近官也街", "室外泳池", "行李寄存", "可取消"],
    roomName: "高级双床房",
    basePrice: 62000,
    rooms: 10,
    latitude: 22.156,
    longitude: 113.558,
  },
  {
    id: "hotel_royal",
    name: "澳门皇都酒店",
    area: "澳门半岛",
    address: "得胜马路 2-4 号",
    stars: 4,
    rating: 42,
    description: "松山脚下的老牌四星，预算有限又想住半岛时最稳的一档。",
    accent: "sand",
    distance: "距东望洋灯塔 600 m",
    amenities: ["高性价比", "近松山", "室内泳池", "含早餐"],
    roomName: "标准双床房",
    basePrice: 52000,
    rooms: 14,
    latitude: 22.1975,
    longitude: 113.5495,
  },
];

async function seedHotels() {
  const d1 = db();
  const seeded = await d1
    .prepare("SELECT value FROM schema_meta WHERE key = 'hotel_catalogue'")
    .first<{ value: string }>();
  if (seeded?.value === HOTEL_CATALOGUE_VERSION) return;

  // Reference data only. Bookings keep their own hotel_id copy, so replacing
  // the catalogue never orphans an existing bill.
  await d1.batch([
    d1.prepare("DELETE FROM daily_inventory"),
    d1.prepare("DELETE FROM hotels"),
  ]);

  const hotelRows = MACAU_HOTELS;

  const statements = hotelRows.map((hotel) =>
    d1
      .prepare(`INSERT INTO hotels
        (id, name, area, address, stars, rating, description, accent, distance, amenities, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        hotel.id,
        hotel.name,
        hotel.area,
        hotel.address,
        hotel.stars,
        hotel.rating,
        hotel.description,
        hotel.accent,
        hotel.distance,
        JSON.stringify(hotel.amenities),
        hotel.latitude,
        hotel.longitude,
      ),
  );

  for (const hotel of hotelRows) {
    for (let day = 1; day <= 45; day += 1) {
      const weekend = [0, 5, 6].includes(new Date(`${dateOnly(day)}T00:00:00Z`).getUTCDay());
      const seasonal = (day % 5) * 2600;
      statements.push(
        d1
          .prepare(`INSERT INTO daily_inventory
            (hotel_id, stay_date, room_name, price, available_rooms, status)
            VALUES (?, ?, ?, ?, ?, 'OPEN')`)
          .bind(
            hotel.id,
            dateOnly(day),
            hotel.roomName,
            hotel.basePrice + (weekend ? 18000 : 0) + seasonal,
            Math.max(1, hotel.rooms - (day % 4)),
          ),
      );
    }
  }

  statements.push(
    d1
      .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('hotel_catalogue', ?)")
      .bind(HOTEL_CATALOGUE_VERSION),
  );

  await d1.batch(statements);
}

async function seedDemoBills() {
  const d1 = db();
  const result = await d1.prepare("SELECT COUNT(*) AS count FROM bills").first<{ count: number }>();
  if ((result?.count || 0) > 0) return;

  const userId = "demo@lvyu.local";
  const now = isoNow();
  await d1.batch([
    d1
      .prepare(`INSERT INTO bookings
        (id, confirmation_no, hotel_id, user_id, check_in, check_out, room_name, guests, rooms, status, quote_version, total_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("booking_demo_pending", "LVYU-260731-A8K2", "hotel_sofitel16", userId, dateOnly(2), dateOnly(4), "豪华客房", 2, 1, "PENDING_PAYMENT", 1, 287600, now),
    d1
      .prepare(`INSERT INTO bills
        (id, booking_id, user_id, title, subtitle, amount, currency, status, due_at, version, breakdown, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        "bill_demo_pending",
        "booking_demo_pending",
        userId,
        "澳门十六浦索菲特",
        `${dateOnly(2)} — ${dateOnly(4)} · 豪华客房`,
        287600,
        "CNY",
        "PENDING_PAYMENT",
        addMinutes(42),
        1,
        JSON.stringify([
          { label: "房费 · 2 晚", amount: 257600 },
          { label: "税费与服务费", amount: 30000 },
        ]),
        now,
      ),
    d1
      .prepare(`INSERT INTO bookings
        (id, confirmation_no, hotel_id, user_id, check_in, check_out, room_name, guests, rooms, status, quote_version, total_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("booking_demo_paid", "LVYU-260718-P9M4", "hotel_regencyart", userId, dateOnly(-12), dateOnly(-10), "高级双床房", 2, 1, "CONFIRMED", 1, 171600, now),
    d1
      .prepare(`INSERT INTO bills
        (id, booking_id, user_id, title, subtitle, amount, currency, status, due_at, version, breakdown, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        "bill_demo_paid",
        "booking_demo_paid",
        userId,
        "澳门丽景湾艺术酒店",
        `${dateOnly(-12)} — ${dateOnly(-10)} · 花园露台房`,
        171600,
        "CNY",
        "PAID",
        now,
        1,
        JSON.stringify([
          { label: "房费 · 2 晚", amount: 153600 },
          { label: "税费与服务费", amount: 18000 },
        ]),
        now,
      ),
    d1
      .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("activity_demo_1", userId, "AI", "旅行助手整理了 1 笔待支付账单，尚未获得付款权限。", now),
  ]);
}

let initialization: Promise<void> | null = null;

export async function ensureData() {
  if (!initialization) {
    initialization = (async () => {
      await createTables();
      await migrateSchema();
      await seedHotels();
      await seedDemoBills();
    })();
  }
  try {
    await initialization;
  } catch (error) {
    initialization = null;
    throw error;
  }
}

export async function searchHotels(checkIn: string, checkOut: string): Promise<Hotel[]> {
  await ensureData();
  const d1 = db();
  const nights = nightsBetween(checkIn, checkOut);
  const inventoryEnd = new Date(`${checkOut}T00:00:00Z`);
  inventoryEnd.setUTCDate(inventoryEnd.getUTCDate() - 1);
  const lastNight = inventoryEnd.toISOString().slice(0, 10);
  const { results } = await d1
    .prepare(`SELECT
      h.*,
      MIN(i.available_rooms) AS available_rooms,
      MIN(i.room_name) AS room_name,
      SUM(i.price) AS total_price,
      COUNT(i.stay_date) AS inventory_days
      FROM hotels h
      JOIN daily_inventory i ON i.hotel_id = h.id
      WHERE i.stay_date BETWEEN ? AND ? AND i.status = 'OPEN'
      GROUP BY h.id
      HAVING inventory_days = ?
      ORDER BY h.rating DESC`)
    .bind(checkIn, lastNight, nights)
    .all<D1Row>();

  return results.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    area: String(row.area),
    address: String(row.address),
    stars: Number(row.stars),
    rating: Number(row.rating) / 10,
    description: String(row.description),
    accent: String(row.accent),
    distance: String(row.distance),
    amenities: JSON.parse(String(row.amenities)) as string[],
    roomName: String(row.room_name),
    price: Number(row.total_price),
    availableRooms: Number(row.available_rooms),
    latitude: Number(row.latitude || 0),
    longitude: Number(row.longitude || 0),
  }));
}

export async function getBills(userId: string) {
  await ensureData();
  const { results } = await db()
    .prepare(`SELECT b.*, bk.status AS booking_status, bk.confirmation_no, bk.hotel_id
      FROM bills b
      JOIN bookings bk ON bk.id = b.booking_id
      WHERE b.user_id = ?
      ORDER BY CASE b.status WHEN 'PENDING_PAYMENT' THEN 0 WHEN 'PROCESSING' THEN 1 ELSE 2 END, b.created_at DESC`)
    .bind(userId)
    .all<D1Row>();
  return results.map((row) => ({
    ...row,
    breakdown: JSON.parse(String(row.breakdown)),
  }));
}

export async function getAuthorizations(userId: string) {
  await ensureData();
  const { results } = await db()
    .prepare(`SELECT * FROM payment_authorizations
      WHERE user_id = ? AND status IN ('PENDING', 'GRANTED')
      ORDER BY created_at DESC`)
    .bind(userId)
    .all<D1Row>();
  return results.map((row) => ({
    ...row,
    bill_ids: JSON.parse(String(row.bill_ids)),
    quote_versions: JSON.parse(String(row.quote_versions)),
  }));
}

export async function getActivities(userId: string) {
  await ensureData();
  const { results } = await db()
    .prepare(`SELECT * FROM activities WHERE user_id = ? ORDER BY created_at DESC LIMIT 8`)
    .bind(userId)
    .all<D1Row>();
  return results;
}

export async function getBill(userId: string, billId: string) {
  await ensureData();
  const row = await db()
    .prepare(`SELECT b.*, bk.status AS booking_status, bk.confirmation_no, bk.hotel_id
      FROM bills b
      JOIN bookings bk ON bk.id = b.booking_id
      WHERE b.id = ? AND b.user_id = ?`)
    .bind(billId, userId)
    .first<D1Row>();
  if (!row) return null;
  return {
    ...row,
    breakdown: JSON.parse(String(row.breakdown)),
  };
}

export function database() {
  return db();
}
