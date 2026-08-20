import { dateOnly, searchHotels } from "../../../../../lib/hotel-store";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const checkIn = url.searchParams.get("check_in") || dateOnly(1);
    const checkOut = url.searchParams.get("check_out") || dateOnly(3);
    const hotels = await searchHotels(checkIn, checkOut);
    return Response.json({
      data: hotels,
      meta: { count: hotels.length, check_in: checkIn, check_out: checkOut },
      request_id: crypto.randomUUID(),
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "SEARCH_FAILED",
          message: error instanceof Error ? error.message : "酒店搜索失败",
          retryable: true,
        },
        request_id: crypto.randomUUID(),
      },
      { status: 400 },
    );
  }
}
