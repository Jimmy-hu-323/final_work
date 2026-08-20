import {
  database,
  ensureData,
  id,
  isoNow,
  requestIdentityFrom,
} from "../../../../lib/hotel-store";

type PaymentPayload = {
  bill_ids?: string[];
  actor?: "user" | "ai";
  authorization_id?: string;
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const identity = requestIdentityFrom(request);
    const userId = identity.userId;
    const payload = (await request.json()) as PaymentPayload;
    const actor =
      identity.serviceAuthenticated
        ? identity.actorType === "agent"
          ? "ai"
          : "user"
        : payload.actor || "user";
    const billIds = [...new Set(payload.bill_ids || [])];
    if (!billIds.length) {
      return Response.json(
        { error: { code: "NO_BILLS_SELECTED", message: "请选择需要支付的账单" }, request_id: requestId },
        { status: 400 },
      );
    }

    const d1 = database();
    const placeholders = billIds.map(() => "?").join(",");
    const { results } = await d1
      .prepare(`SELECT id, booking_id, amount, currency, version FROM bills
        WHERE id IN (${placeholders}) AND user_id = ? AND status = 'PENDING_PAYMENT'`)
      .bind(...billIds, userId)
      .all<Record<string, string | number>>();
    if (results.length !== billIds.length) {
      return Response.json(
        { error: { code: "BILL_SET_CHANGED", message: "部分账单已经支付、关闭或发生变化" }, request_id: requestId },
        { status: 409 },
      );
    }

    let authorizationId: string | null = null;
    if (actor === "ai") {
      if (!payload.authorization_id) {
        return Response.json(
          {
            error: {
              code: "PAYMENT_AUTHORIZATION_REQUIRED",
              message: "AI 没有付款权限，请由用户在账单中心授权",
              retryable: false,
            },
            request_id: requestId,
          },
          { status: 403 },
        );
      }
      const authorization = await d1
        .prepare(`SELECT * FROM payment_authorizations
          WHERE id = ? AND user_id = ? AND status = 'GRANTED'`)
        .bind(payload.authorization_id, userId)
        .first<Record<string, string | number>>();
      const total = results.reduce((sum, row) => sum + Number(row.amount), 0);
      const versions = Object.fromEntries(results.map((row) => [String(row.id), Number(row.version)]));
      const expectedBillIds = authorization ? JSON.parse(String(authorization.bill_ids)).sort() : [];
      const expectedVersions = authorization ? JSON.parse(String(authorization.quote_versions)) : {};
      const expired = !authorization || Date.parse(String(authorization.expires_at)) <= Date.now();
      const mismatch =
        JSON.stringify(expectedBillIds) !== JSON.stringify([...billIds].sort()) ||
        JSON.stringify(expectedVersions) !== JSON.stringify(versions) ||
        total > Number(authorization?.max_amount || 0);

      if (expired || mismatch) {
        return Response.json(
          {
            error: {
              code: "PAYMENT_AUTHORIZATION_INVALID",
              message: "付款授权已过期，或账单金额、版本发生变化",
              retryable: false,
            },
            request_id: requestId,
          },
          { status: 403 },
        );
      }
      authorizationId = payload.authorization_id;
    }

    const now = isoNow();
    const totalAmount = results.reduce((sum, row) => sum + Number(row.amount), 0);
    const updates = results.flatMap((row) => [
      d1.prepare("UPDATE bills SET status = 'PAID' WHERE id = ?").bind(row.id),
      d1.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").bind(row.booking_id),
    ]);
    if (authorizationId) {
      updates.push(
        d1.prepare("UPDATE payment_authorizations SET status = 'USED' WHERE id = ?").bind(authorizationId),
      );
    }
    updates.push(
      d1
        .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'PAYMENT', ?, ?)")
        .bind(
          id("activity"),
          userId,
          `${actor === "ai" ? "AI 已使用一次性授权" : "你已"}完成 ¥${(totalAmount / 100).toFixed(2)} 模拟付款。`,
          now,
        ),
    );
    await d1.batch(updates);

    return Response.json({
      payment: {
        id: id("payment"),
        status: "SUCCEEDED",
        amount: totalAmount,
        currency: String(results[0].currency),
        paid_at: now,
        mode: "SIMULATED",
      },
      request_id: requestId,
    });
  } catch (error) {
    return Response.json(
      { error: { code: "PAYMENT_FAILED", message: error instanceof Error ? error.message : "付款失败" }, request_id: requestId },
      { status: 500 },
    );
  }
}
