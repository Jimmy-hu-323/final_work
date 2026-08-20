import {
  database,
  ensureData,
  id,
  isoNow,
  requestIdentityFrom,
} from "../../../../../../../lib/hotel-store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

type ConfirmPayload = {
  preview_id?: string;
};

export async function POST(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const { id: billId } = await context.params;
    const identity = requestIdentityFrom(request);
    const userId = identity.userId;
    if (identity.actorType === "agent") {
      return Response.json(
        {
          error: {
            code: "USER_CONFIRMATION_REQUIRED",
            message: "AI 可以生成调整预览，但必须由用户在手机端确认",
          },
          request_id: requestId,
        },
        { status: 403 },
      );
    }
    const payload = (await request.json()) as ConfirmPayload;
    if (!payload.preview_id) {
      return Response.json(
        { error: { code: "PREVIEW_REQUIRED", message: "请先预览账单调整" }, request_id: requestId },
        { status: 400 },
      );
    }

    const d1 = database();
    const preview = await d1
      .prepare(`SELECT * FROM bill_adjustment_quotes
        WHERE id = ? AND bill_id = ? AND user_id = ? AND status = 'PENDING'`)
      .bind(payload.preview_id, billId, userId)
      .first<Record<string, string | number>>();
    const bill = await d1
      .prepare("SELECT * FROM bills WHERE id = ? AND user_id = ?")
      .bind(billId, userId)
      .first<Record<string, string | number>>();

    const expired = !preview || Date.parse(String(preview.expires_at)) <= Date.now();
    const versionChanged =
      !bill || !preview || Number(bill.version) !== Number(preview.base_version);
    if (
      !bill ||
      bill.status !== "PENDING_PAYMENT" ||
      expired ||
      versionChanged
    ) {
      return Response.json(
        {
          error: {
            code: "ADJUSTMENT_PREVIEW_STALE",
            message: "账单或报价已经变化，请重新预览后确认",
          },
          request_id: requestId,
        },
        { status: 409 },
      );
    }

    const version = Number(bill.version) + 1;
    const now = isoNow();
    await d1.batch([
      d1
        .prepare("UPDATE bills SET amount = ?, version = ?, breakdown = ? WHERE id = ? AND version = ?")
        .bind(
          Number(preview.new_amount),
          version,
          String(preview.new_breakdown),
          billId,
          Number(preview.base_version),
        ),
      d1
        .prepare("UPDATE bill_adjustment_quotes SET status = 'CONFIRMED' WHERE id = ?")
        .bind(payload.preview_id),
      d1
        .prepare(`UPDATE payment_authorizations SET status = 'REVOKED'
          WHERE user_id = ? AND status IN ('PENDING', 'GRANTED')`)
        .bind(userId),
      d1
        .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'BILL', ?, ?)")
        .bind(
          id("activity"),
          userId,
          `账单已由用户确认调整为 v${version}，旧付款授权已失效。`,
          now,
        ),
    ]);

    return Response.json({
      bill: {
        id: billId,
        amount: Number(preview.new_amount),
        version,
        breakdown: JSON.parse(String(preview.new_breakdown)),
      },
      invalidated_authorizations: true,
      request_id: requestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "账单调整确认失败";
    return Response.json(
      { error: { code: "ADJUSTMENT_CONFIRM_FAILED", message }, request_id: requestId },
      { status: message === "SERVICE_AUTHENTICATION_REQUIRED" ? 401 : 500 },
    );
  }
}
