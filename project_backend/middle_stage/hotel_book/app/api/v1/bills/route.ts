import {
  database,
  ensureData,
  getBills,
  id,
  isoNow,
  requestIdentityFrom,
  userIdFrom,
} from "../../../../lib/hotel-store";

type BillPayload = {
  action?: "adjust";
  bill_id?: string;
  breakfast?: boolean;
};

export async function GET(request: Request) {
  try {
    return Response.json({
      data: await getBills(userIdFrom(request)),
      request_id: crypto.randomUUID(),
    });
  } catch (error) {
    return Response.json(
      { error: { code: "BILLS_UNAVAILABLE", message: error instanceof Error ? error.message : "账单加载失败" } },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const identity = requestIdentityFrom(request);
    const userId = identity.userId;
    const payload = (await request.json()) as BillPayload;
    if (identity.actorType === "agent") {
      return Response.json(
        {
          error: {
            code: "USER_CONFIRMATION_REQUIRED",
            message: "AI 只能预览调整，账单变更必须由用户确认",
          },
          request_id: requestId,
        },
        { status: 403 },
      );
    }
    if (payload.action !== "adjust" || !payload.bill_id) {
      return Response.json(
        { error: { code: "INVALID_ADJUSTMENT", message: "缺少有效的账单调整内容" }, request_id: requestId },
        { status: 400 },
      );
    }

    const d1 = database();
    const bill = await d1
      .prepare("SELECT * FROM bills WHERE id = ? AND user_id = ?")
      .bind(payload.bill_id, userId)
      .first<Record<string, string | number>>();
    if (!bill || bill.status !== "PENDING_PAYMENT") {
      return Response.json(
        { error: { code: "BILL_NOT_ADJUSTABLE", message: "这笔账单当前不能调整" }, request_id: requestId },
        { status: 409 },
      );
    }

    const items = JSON.parse(String(bill.breakdown)) as Array<{ label: string; amount: number }>;
    const withoutBreakfast = items.filter((item) => item.label !== "双人早餐");
    if (payload.breakfast) withoutBreakfast.push({ label: "双人早餐", amount: 18000 });
    const amount = withoutBreakfast.reduce((sum, item) => sum + item.amount, 0);
    const version = Number(bill.version) + 1;
    const now = isoNow();

    await d1.batch([
      d1
        .prepare("UPDATE bills SET amount = ?, version = ?, breakdown = ? WHERE id = ?")
        .bind(amount, version, JSON.stringify(withoutBreakfast), payload.bill_id),
      d1
        .prepare(`UPDATE payment_authorizations SET status = 'REVOKED'
          WHERE user_id = ? AND status IN ('PENDING', 'GRANTED')`)
        .bind(userId),
      d1
        .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'BILL', ?, ?)")
        .bind(id("activity"), userId, `账单已调整并重新报价，当前版本为 v${version}。旧付款授权已失效。`, now),
    ]);

    return Response.json({
      bill: { id: payload.bill_id, amount, version, breakdown: withoutBreakfast },
      invalidated_authorizations: true,
      request_id: requestId,
    });
  } catch (error) {
    return Response.json(
      { error: { code: "ADJUSTMENT_FAILED", message: error instanceof Error ? error.message : "账单调整失败" }, request_id: requestId },
      { status: 500 },
    );
  }
}
