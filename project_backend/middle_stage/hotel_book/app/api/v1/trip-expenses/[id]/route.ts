import { userIdFrom } from "../../../../../lib/hotel-store";
import {
  deleteTripExpense,
  listTripExpenses,
  summarizeExpenses,
  updateTripExpense,
} from "../../../../../lib/trip-expenses";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

function failure(error: unknown, requestId: string) {
  const message = error instanceof Error ? error.message : "行程费用更新失败";
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

function notFound(requestId: string) {
  return Response.json(
    { error: { code: "EXPENSE_NOT_FOUND", message: "费用项不存在。" }, request_id: requestId },
    { status: 404 },
  );
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const userId = userIdFrom(request);
    // Only forward keys the caller actually sent, so a partial edit from the
    // phone never blanks a field it did not show.
    const patch: Record<string, unknown> = {};
    if ("title" in body) patch.title = body.title;
    if ("category" in body) patch.category = body.category;
    if ("place_name" in body) patch.placeName = body.place_name;
    if ("latitude" in body) patch.latitude = body.latitude;
    if ("longitude" in body) patch.longitude = body.longitude;
    if ("day" in body) patch.day = body.day;
    if ("unit_amount" in body) patch.unitAmount = body.unit_amount;
    if ("quantity" in body) patch.quantity = body.quantity;
    if ("currency" in body) patch.currency = body.currency;
    if ("required" in body) patch.required = body.required;
    if ("note" in body) patch.note = body.note;

    const updated = await updateTripExpense(userId, id, patch);
    if (!updated) return notFound(requestId);
    const expenses = await listTripExpenses(userId, updated.trip_id || undefined);
    return Response.json({
      expense: updated,
      expenses,
      summary: summarizeExpenses(expenses),
      request_id: requestId,
    });
  } catch (error) {
    return failure(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const { id } = await context.params;
    const userId = userIdFrom(request);
    const removed = await deleteTripExpense(userId, id);
    if (!removed) return notFound(requestId);
    const expenses = await listTripExpenses(userId);
    return Response.json({
      ok: true,
      expenses,
      summary: summarizeExpenses(expenses),
      request_id: requestId,
    });
  } catch (error) {
    return failure(error, requestId);
  }
}
