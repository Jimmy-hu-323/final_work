import {
  addMinutes,
  database,
  ensureData,
  id,
  isoNow,
  requestIdentityFrom,
  getAuthorizations,
} from "../../../../lib/hotel-store";

type AuthorizationPayload = {
  action?: "request" | "grant" | "revoke";
  bill_ids?: string[];
  authorization_id?: string;
  agent_name?: string;
};

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const identity = requestIdentityFrom(request);
    return Response.json({
      data: await getAuthorizations(identity.userId),
      request_id: requestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "付款授权加载失败";
    return Response.json(
      { error: { code: "AUTHORIZATIONS_UNAVAILABLE", message }, request_id: requestId },
      { status: message === "SERVICE_AUTHENTICATION_REQUIRED" ? 401 : 500 },
    );
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureData();
    const identity = requestIdentityFrom(request);
    const userId = identity.userId;
    const payload = (await request.json()) as AuthorizationPayload;
    const d1 = database();

    if (payload.action === "request") {
      const billIds = [...new Set(payload.bill_ids || [])];
      if (!billIds.length) {
        return Response.json(
          { error: { code: "NO_BILLS_SELECTED", message: "请至少选择一笔待支付账单" }, request_id: requestId },
          { status: 400 },
        );
      }
      const placeholders = billIds.map(() => "?").join(",");
      const { results } = await d1
        .prepare(`SELECT id, amount, currency, version FROM bills
          WHERE id IN (${placeholders}) AND user_id = ? AND status = 'PENDING_PAYMENT'`)
        .bind(...billIds, userId)
        .all<Record<string, string | number>>();
      if (results.length !== billIds.length) {
        return Response.json(
          { error: { code: "BILL_SET_CHANGED", message: "部分账单状态已变化，请刷新后重试" }, request_id: requestId },
          { status: 409 },
        );
      }
      const currencies = new Set(results.map((row) => String(row.currency)));
      if (currencies.size !== 1) {
        return Response.json(
          { error: { code: "MULTIPLE_CURRENCIES", message: "不同币种账单不能合并授权" }, request_id: requestId },
          { status: 400 },
        );
      }
      const authorizationId = id("pauth");
      const amount = results.reduce((sum, row) => sum + Number(row.amount), 0);
      const versions = Object.fromEntries(results.map((row) => [String(row.id), Number(row.version)]));
      const agentName = payload.agent_name?.trim() || "LensGo 旅行助手";
      const now = isoNow();
      await d1.batch([
        d1
          .prepare(`INSERT INTO payment_authorizations
            (id, user_id, agent_name, bill_ids, max_amount, currency, quote_versions, status, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
          .bind(
            authorizationId,
            userId,
            agentName,
            JSON.stringify(billIds),
            amount,
            String(results[0].currency),
            JSON.stringify(versions),
            addMinutes(5),
            now,
          ),
        d1
          .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'AI', ?, ?)")
          .bind(id("activity"), userId, `${agentName} 请求一次性付款授权，等待你确认。`, now),
      ]);
      return Response.json(
        {
          authorization: {
            id: authorizationId,
            status: "PENDING",
            bill_ids: billIds,
            max_amount: amount,
            currency: String(results[0].currency),
            expires_at: addMinutes(5),
          },
          request_id: requestId,
        },
        { status: 201 },
      );
    }

    if ((payload.action === "grant" || payload.action === "revoke") && payload.authorization_id) {
      if (identity.actorType === "agent") {
        return Response.json(
          {
            error: {
              code: "USER_CONFIRMATION_REQUIRED",
              message: "AI 不能批准或撤销自己的付款授权，必须由用户在手机端操作",
            },
            request_id: requestId,
          },
          { status: 403 },
        );
      }
      const status = payload.action === "grant" ? "GRANTED" : "REVOKED";
      const current = await d1
        .prepare("SELECT * FROM payment_authorizations WHERE id = ? AND user_id = ?")
        .bind(payload.authorization_id, userId)
        .first<Record<string, string | number>>();
      if (!current || current.status !== "PENDING") {
        return Response.json(
          { error: { code: "AUTHORIZATION_NOT_PENDING", message: "该授权请求已失效或已处理" }, request_id: requestId },
          { status: 409 },
        );
      }
      const expiresAt = addMinutes(5);
      await d1.batch([
        d1
          .prepare("UPDATE payment_authorizations SET status = ?, expires_at = ? WHERE id = ?")
          .bind(status, expiresAt, payload.authorization_id),
        d1
          .prepare("INSERT INTO activities (id, user_id, kind, message, created_at) VALUES (?, ?, 'SECURITY', ?, ?)")
          .bind(
            id("activity"),
            userId,
            status === "GRANTED"
              ? "你已授予 AI 一次性、限额、5 分钟有效的付款权限。"
              : "你已拒绝并撤销 AI 付款授权。",
            isoNow(),
          ),
      ]);
      return Response.json({
        authorization: { id: payload.authorization_id, status, expires_at: expiresAt },
        request_id: requestId,
      });
    }

    return Response.json(
      { error: { code: "INVALID_AUTHORIZATION_ACTION", message: "无效的付款授权操作" }, request_id: requestId },
      { status: 400 },
    );
  } catch (error) {
    return Response.json(
      { error: { code: "AUTHORIZATION_FAILED", message: error instanceof Error ? error.message : "授权操作失败" }, request_id: requestId },
      { status: 500 },
    );
  }
}
