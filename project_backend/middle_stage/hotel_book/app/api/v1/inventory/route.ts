import { database, ensureData, id, isoNow, userIdFrom } from "../../../../lib/hotel-store";

type InventoryPayload = {
  hotel_id?: string;
  stay_date?: string;
  price?: number;
  available_rooms?: number;
};

export async function GET(request: Request) {
  try {
    await ensureData();
    const url = new URL(request.url);
    const hotelId = url.searchParams.get("hotel_id") || "hotel_harbour";
    const { results } = await database()
      .prepare(`SELECT i.*, h.name AS hotel_name FROM daily_inventory i
        JOIN hotels h ON h.id = i.hotel_id
        WHERE i.hotel_id = ? AND i.stay_date >= date('now')
        ORDER BY i.stay_date LIMIT 14`)
      .bind(hotelId)
      .all();
    return Response.json({ data: results, request_id: crypto.randomUUID() });
  } catch (error) {
    return Response.json(
      { error: { code: "INVENTORY_UNAVAILABLE", message: error instanceof Error ? error.message : "库存加载失败" } },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const payload = (await request.json()) as InventoryPayload;
    if (!payload.hotel_id || !payload.stay_date) {
      return Response.json(
        { error: { code: "INVALID_INVENTORY", message: "缺少酒店或日期" }, request_id: requestId },
        { status: 400 },
      );
    }
    const rooms = Math.max(0, Math.min(999, Number(payload.available_rooms ?? 0)));
    const price = Math.max(0, Math.min(10_000_000, Number(payload.price ?? 0)));
    const d1 = database();
    await d1.batch([
      d1
        .prepare("UPDATE daily_inventory SET available_rooms = ?, price = ? WHERE hotel_id = ? AND stay_date = ?")
        .bind(rooms, price, payload.hotel_id, payload.stay_date),
      d1
        .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'INVENTORY', ?, ?)")
        .bind(id("activity"), userIdFrom(request), `已更新 ${payload.stay_date} 的价格和库存。`, isoNow()),
    ]);
    return Response.json({
      inventory: { hotel_id: payload.hotel_id, stay_date: payload.stay_date, available_rooms: rooms, price },
      request_id: requestId,
    });
  } catch (error) {
    return Response.json(
      { error: { code: "INVENTORY_UPDATE_FAILED", message: error instanceof Error ? error.message : "库存更新失败" }, request_id: requestId },
      { status: 500 },
    );
  }
}
