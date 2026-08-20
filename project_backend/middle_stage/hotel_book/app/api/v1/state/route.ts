import {
  dateOnly,
  getActivities,
  getAuthorizations,
  getBills,
  searchHotels,
  userIdFrom,
} from "../../../../lib/hotel-store";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const checkIn = url.searchParams.get("check_in") || dateOnly(1);
    const checkOut = url.searchParams.get("check_out") || dateOnly(3);
    const userId = userIdFrom(request);
    const [hotels, bills, authorizations, activities] = await Promise.all([
      searchHotels(checkIn, checkOut),
      getBills(userId),
      getAuthorizations(userId),
      getActivities(userId),
    ]);

    return Response.json({
      user: {
        id: userId,
        display_name: userId === "demo@lvyu.local" ? "林澄" : userId.split("@")[0],
      },
      query: { check_in: checkIn, check_out: checkOut },
      hotels,
      bills,
      authorizations,
      activities,
      request_id: crypto.randomUUID(),
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "STATE_UNAVAILABLE",
          message: error instanceof Error ? error.message : "无法加载应用数据",
          retryable: true,
        },
        request_id: crypto.randomUUID(),
      },
      { status: 500 },
    );
  }
}
