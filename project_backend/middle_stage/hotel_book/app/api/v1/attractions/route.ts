import { listAttractions } from "../../../../lib/trip-expenses";

/** Ticket price reference the planner uses to cost an itinerary. */
export async function GET() {
  const requestId = crypto.randomUUID();
  try {
    return Response.json({ attractions: await listAttractions(), request_id: requestId });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "ATTRACTIONS_UNAVAILABLE",
          message: error instanceof Error ? error.message : "景点价目加载失败",
        },
        request_id: requestId,
      },
      { status: 500 },
    );
  }
}
