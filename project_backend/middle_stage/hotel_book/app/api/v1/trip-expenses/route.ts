import { userIdFrom } from "../../../../lib/hotel-store";
import {
  createTripExpense,
  listTripExpenses,
  summarizeExpenses,
} from "../../../../lib/trip-expenses";

function failure(error: unknown, requestId: string) {
  const message = error instanceof Error ? error.message : "行程费用加载失败";
  const status =
    message === "SERVICE_AUTHENTICATION_REQUIRED"
      ? 401
      : message.startsWith("EXPENSE_")
        ? 400
        : 500;
  const readable =
    message === "EXPENSE_TITLE_REQUIRED"
      ? "费用项需要名称。"
      : message === "EXPENSE_AMOUNT_INVALID"
        ? "金额必须是不小于 0 的整数（单位：分）。"
        : message;
  return Response.json(
    { error: { code: message, message: readable }, request_id: requestId },
    { status },
  );
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const tripId = new URL(request.url).searchParams.get("trip_id") || undefined;
    const expenses = await listTripExpenses(userIdFrom(request), tripId);
    return Response.json({
      expenses,
      summary: summarizeExpenses(expenses),
      request_id: requestId,
    });
  } catch (error) {
    return failure(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const items = Array.isArray(body.expenses) ? body.expenses : [body];
    const userId = userIdFrom(request);
    const created = [];
    for (const item of items) {
      const input = item as Record<string, unknown>;
      created.push(
        await createTripExpense(userId, {
          tripId: input.trip_id as string | undefined,
          category: input.category as string | undefined,
          title: String(input.title ?? ""),
          placeName: input.place_name as string | undefined,
          latitude: (input.latitude as number | null) ?? null,
          longitude: (input.longitude as number | null) ?? null,
          day: (input.day as number | null) ?? null,
          unitAmount: Number(input.unit_amount ?? input.amount ?? 0),
          quantity: Number(input.quantity ?? 1),
          currency: input.currency as string | undefined,
          required: input.required as boolean | undefined,
          note: input.note as string | undefined,
          source: input.source as string | undefined,
          bookingId: (input.booking_id as string | null) ?? null,
        }),
      );
    }
    const expenses = await listTripExpenses(userId, body.trip_id as string | undefined);
    return Response.json(
      { created, expenses, summary: summarizeExpenses(expenses), request_id: requestId },
      { status: 201 },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
