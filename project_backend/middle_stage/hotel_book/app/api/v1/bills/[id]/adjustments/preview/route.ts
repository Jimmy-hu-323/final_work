import {
  addMinutes,
  database,
  ensureData,
  id,
  isoNow,
  userIdFrom,
} from "../../../../../../../lib/hotel-store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

type AdjustmentPayload = {
  breakfast?: boolean;
};

export async function POST(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const { id: billId } = await context.params;
    const userId = userIdFrom(request);
    const payload = (await request.json()) as AdjustmentPayload;
    const bill = await database()
      .prepare("SELECT * FROM bills WHERE id = ? AND user_id = ?")
      .bind(billId, userId)
      .first<Record<string, string | number>>();

    if (!bill || bill.status !== "PENDING_PAYMENT") {
      return Response.json(
        { error: { code: "BILL_NOT_ADJUSTABLE", message: "这笔账单当前不能调整" }, request_id: requestId },
        { status: 409 },
      );
    }

    const items = JSON.parse(String(bill.breakdown)) as Array<{ label: string; amount: number }>;
    const newBreakdown = items.filter((item) => item.label !== "双人早餐");
    if (payload.breakfast) {
      newBreakdown.push({ label: "双人早餐", amount: 18000 });
    }
    const newAmount = newBreakdown.reduce((sum, item) => sum + item.amount, 0);
    const quoteId = id("adjustment");
    const expiresAt = addMinutes(5);
    await database()
      .prepare(`INSERT INTO bill_adjustment_quotes
        (id, bill_id, user_id, base_version, breakfast, new_amount, new_breakdown, status, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
      .bind(
        quoteId,
        billId,
        userId,
        Number(bill.version),
        payload.breakfast ? 1 : 0,
        newAmount,
        JSON.stringify(newBreakdown),
        expiresAt,
        isoNow(),
      )
      .run();

    return Response.json({
      preview: {
        id: quoteId,
        bill_id: billId,
        base_version: Number(bill.version),
        current_amount: Number(bill.amount),
        new_amount: newAmount,
        delta_amount: newAmount - Number(bill.amount),
        breakdown: newBreakdown,
        breakfast: Boolean(payload.breakfast),
        expires_at: expiresAt,
      },
      request_id: requestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "账单调整预览失败";
    return Response.json(
      { error: { code: "ADJUSTMENT_PREVIEW_FAILED", message }, request_id: requestId },
      { status: message === "SERVICE_AUTHENTICATION_REQUIRED" ? 401 : 500 },
    );
  }
}
