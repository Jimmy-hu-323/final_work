import {
  addMinutes,
  database,
  ensureData,
  id,
  isoNow,
  nightsBetween,
  userIdFrom,
} from "../../../../lib/hotel-store";

type BookingPayload = {
  quote_id?: string;
  hotel_id?: string;
  check_in?: string;
  check_out?: string;
  guests?: number;
  rooms?: number;
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const payload = (await request.json()) as BookingPayload;
    const userId = userIdFrom(request);
    const d1 = database();
    const savedQuote = payload.quote_id
      ? await d1
          .prepare(`SELECT * FROM booking_quotes
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`)
          .bind(payload.quote_id, userId)
          .first<Record<string, string | number>>()
      : null;
    if (
      payload.quote_id &&
      (!savedQuote || Date.parse(String(savedQuote.expires_at)) <= Date.now())
    ) {
      return Response.json(
        {
          error: {
            code: "QUOTE_EXPIRED",
            message: "报价已过期或不可用，请重新报价",
            retryable: true,
          },
          request_id: requestId,
        },
        { status: 409 },
      );
    }

    const hotelId = String(savedQuote?.hotel_id || payload.hotel_id || "").trim();
    const checkIn = String(savedQuote?.check_in || payload.check_in || "").trim();
    const checkOut = String(savedQuote?.check_out || payload.check_out || "").trim();
    const guests = Math.max(1, Math.min(8, Number(savedQuote?.guests || payload.guests || 2)));
    const rooms = Math.max(1, Math.min(4, Number(savedQuote?.rooms || payload.rooms || 1)));
    const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : 0;

    if (!hotelId || !checkIn || !checkOut || nights < 1 || nights > 30) {
      return Response.json(
        {
          error: {
            code: "INVALID_BOOKING_DATES",
            message: "请选择 1 至 30 晚的有效入住日期",
            retryable: false,
          },
          request_id: requestId,
        },
        { status: 400 },
      );
    }

    const inventoryEnd = new Date(`${checkOut}T00:00:00Z`);
    inventoryEnd.setUTCDate(inventoryEnd.getUTCDate() - 1);
    const lastNight = inventoryEnd.toISOString().slice(0, 10);
    const offer = await d1
      .prepare(`SELECT h.name, MIN(i.room_name) AS room_name,
        SUM(i.price) AS room_total, MIN(i.available_rooms) AS available_rooms,
        COUNT(i.stay_date) AS inventory_days
        FROM hotels h
        JOIN daily_inventory i ON i.hotel_id = h.id
        WHERE h.id = ? AND i.stay_date BETWEEN ? AND ? AND i.status = 'OPEN'
        GROUP BY h.id`)
      .bind(hotelId, checkIn, lastNight)
      .first<Record<string, string | number>>();

    if (!offer || Number(offer.inventory_days) !== nights || Number(offer.available_rooms) < rooms) {
      return Response.json(
        {
          error: {
            code: "INVENTORY_NOT_AVAILABLE",
            message: "所选日期的可售库存已变化，请重新搜索",
            retryable: true,
          },
          request_id: requestId,
        },
        { status: 409 },
      );
    }

    const roomTotal = Number(offer.room_total) * rooms;
    const serviceFee = Math.round(roomTotal * 0.1);
    const totalAmount = roomTotal + serviceFee;
    if (savedQuote && totalAmount !== Number(savedQuote.total_amount)) {
      return Response.json(
        {
          error: {
            code: "QUOTE_PRICE_CHANGED",
            message: "库存价格已经变化，请重新报价",
            retryable: true,
          },
          request_id: requestId,
        },
        { status: 409 },
      );
    }
    const bookingId = id("booking");
    const billId = id("bill");
    const confirmationNo = `LVYU-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const now = isoNow();

    const inventoryRows = await d1
      .prepare("SELECT stay_date FROM daily_inventory WHERE hotel_id = ? AND stay_date BETWEEN ? AND ?")
      .bind(hotelId, checkIn, lastNight)
      .all<{ stay_date: string }>();

    const inventoryUpdates = inventoryRows.results.map((row) =>
      d1
        .prepare(`UPDATE daily_inventory
          SET available_rooms = available_rooms - ?
          WHERE hotel_id = ? AND stay_date = ? AND available_rooms >= ?`)
        .bind(rooms, hotelId, row.stay_date, rooms),
    );

    await d1.batch([
      ...inventoryUpdates,
      ...(payload.quote_id
        ? [
            d1
              .prepare("UPDATE booking_quotes SET status = 'BOOKED' WHERE id = ?")
              .bind(payload.quote_id),
          ]
        : []),
      d1
        .prepare(`INSERT INTO bookings
          (id, confirmation_no, hotel_id, user_id, check_in, check_out, room_name, guests, rooms, status, quote_version, total_amount, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', 1, ?, ?)`)
        .bind(
          bookingId,
          confirmationNo,
          hotelId,
          userId,
          checkIn,
          checkOut,
          String(offer.room_name),
          guests,
          rooms,
          totalAmount,
          now,
        ),
      d1
        .prepare(`INSERT INTO bills
          (id, booking_id, user_id, title, subtitle, amount, currency, status, due_at, version, breakdown, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'CNY', 'PENDING_PAYMENT', ?, 1, ?, ?)`)
        .bind(
          billId,
          bookingId,
          userId,
          String(offer.name),
          `${checkIn} — ${checkOut} · ${offer.room_name}`,
          totalAmount,
          addMinutes(10),
          JSON.stringify([
            { label: `房费 · ${nights} 晚 × ${rooms} 间`, amount: roomTotal },
            { label: "税费与服务费", amount: serviceFee },
          ]),
          now,
        ),
      d1
        .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'BOOKING', ?, ?)")
        .bind(id("activity"), userId, `已为 ${offer.name} 生成待支付账单，房间保留 10 分钟。`, now),
    ]);

    return Response.json(
      {
        booking: {
          id: bookingId,
          confirmation_no: confirmationNo,
          status: "PENDING_PAYMENT",
          total_amount: totalAmount,
        },
        bill: { id: billId, status: "PENDING_PAYMENT", amount: totalAmount, currency: "CNY" },
        request_id: requestId,
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "BOOKING_CREATE_FAILED",
          message: error instanceof Error ? error.message : "订单创建失败",
          retryable: true,
        },
        request_id: requestId,
      },
      { status: 500 },
    );
  }
}
