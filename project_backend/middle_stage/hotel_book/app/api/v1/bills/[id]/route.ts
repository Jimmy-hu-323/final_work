import { getBill, userIdFrom } from "../../../../../lib/hotel-store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function GET(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const { id } = await context.params;
    const bill = await getBill(userIdFrom(request), id);
    if (!bill) {
      return Response.json(
        { error: { code: "BILL_NOT_FOUND", message: "账单不存在" }, request_id: requestId },
        { status: 404 },
      );
    }
    return Response.json({ bill, request_id: requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "账单加载失败";
    return Response.json(
      { error: { code: "BILL_UNAVAILABLE", message }, request_id: requestId },
      { status: message === "SERVICE_AUTHENTICATION_REQUIRED" ? 401 : 500 },
    );
  }
}
