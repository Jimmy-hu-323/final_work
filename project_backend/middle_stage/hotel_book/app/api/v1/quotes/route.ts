import {
  addMinutes,
  database,
  ensureData,
  id,
  isoNow,
  nightsBetween,
  userIdFrom,
} from "../../../../lib/hotel-store";

type QuotePayload = {
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
    const payload = (await request.json()) as QuotePayload;
    const hotelId = payload.hotel_id?.trim();
    const checkIn = payload.check_in?.trim();
    const checkOut = payload.check_out?.trim();
    const guests = Math.max(1, Math.min(8, Number(payload.guests || 2)));
    const rooms = Math.max(1, Math.min(4, Number(payload.rooms || 1)));
    const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : 0;

    if (!hotelId || !checkIn || !checkOut || nights < 1 || nights > 30) {
      return Response.json(
        {
          error: {
            code: "INVALID_QUOTE_REQUEST",
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
    const d1 = database();
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
            message: "所选日期的可售库存不足，请重新搜索",
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
    const quoteId = id("quote");
    const now = isoNow();
    const expiresAt = addMinutes(10);
    await d1
      .prepare(`INSERT INTO booking_quotes
        (id, user_id, hotel_id, check_in, check_out, guests, rooms, room_name,
         room_total, service_fee, total_amount, currency, status, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', 'ACTIVE', ?, ?)`)
      .bind(
        quoteId,
        userIdFrom(request),
        hotelId,
        checkIn,
        checkOut,
        guests,
        rooms,
        String(offer.room_name),
        roomTotal,
        serviceFee,
        totalAmount,
        expiresAt,
        now,
      )
      .run();

    return Response.json(
      {
        quote: {
          id: quoteId,
          hotel_id: hotelId,
          hotel_name: String(offer.name),
          check_in: checkIn,
          check_out: checkOut,
          nights,
          guests,
          rooms,
          room_name: String(offer.room_name),
          room_total: roomTotal,
          service_fee: serviceFee,
          total_amount: totalAmount,
          currency: "CNY",
          expires_at: expiresAt,
        },
        request_id: requestId,
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "报价生成失败";
    return Response.json(
      {
        error: {
          code:
            message === "SERVICE_AUTHENTICATION_REQUIRED"
              ? "SERVICE_AUTHENTICATION_REQUIRED"
              : "QUOTE_CREATE_FAILED",
          message,
        },
        request_id: requestId,
      },
      { status: message === "SERVICE_AUTHENTICATION_REQUIRED" ? 401 : 500 },
    );
  }
}
