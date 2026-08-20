export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    openapi: "3.1.0",
    info: {
      title: "旅屿 Hotel Booking API",
      version: "0.2.0",
      description: "供用户界面与 AI Agent 共用的酒店搜索、预订、账单和受限付款授权 API。",
    },
    servers: [{ url: `${origin}/api/v1` }],
    paths: {
      "/hotels/search": {
        get: {
          operationId: "search_hotels",
          summary: "搜索指定日期内可订酒店",
          parameters: [
            { name: "check_in", in: "query", required: true, schema: { type: "string", format: "date" } },
            { name: "check_out", in: "query", required: true, schema: { type: "string", format: "date" } },
          ],
          responses: { "200": { description: "可订酒店列表" } },
        },
      },
      "/bookings": {
        post: {
          operationId: "create_booking",
          summary: "创建待支付订单和账单",
          responses: { "201": { description: "订单与账单已创建" }, "409": { description: "库存发生变化" } },
        },
      },
      "/quotes": {
        post: {
          operationId: "create_booking_quote",
          summary: "生成十分钟有效的酒店报价",
          responses: {
            "201": { description: "报价已生成" },
            "409": { description: "库存或价格不可用" },
          },
        },
      },
      "/bills": {
        get: {
          operationId: "list_bills",
          summary: "读取用户授权范围内的账单列表",
          responses: { "200": { description: "账单列表" } },
        },
      },
      "/bills/{id}": {
        get: {
          operationId: "get_bill",
          summary: "读取单笔最终账单和当前版本",
          responses: {
            "200": { description: "账单详情" },
            "404": { description: "账单不存在" },
          },
        },
      },
      "/bills/{id}/adjustments/preview": {
        post: {
          operationId: "preview_bill_adjustment",
          summary: "预览早餐等可选项对账单的影响，不修改账单",
          responses: { "200": { description: "五分钟有效的调整预览" } },
        },
      },
      "/bills/{id}/adjustments/confirm": {
        post: {
          operationId: "confirm_bill_adjustment",
          summary: "由用户确认调整并提升账单版本",
          responses: {
            "200": { description: "账单已调整，旧付款授权已废止" },
            "403": { description: "AI 无权确认账单调整" },
            "409": { description: "预览过期或账单版本已变化" },
          },
        },
      },
      "/payment-authorizations": {
        post: {
          operationId: "request_payment_authorization",
          summary: "AI 请求用户授予指定账单的一次性付款权限",
          responses: { "201": { description: "授权请求已创建" } },
        },
      },
      "/payment-sessions": {
        post: {
          operationId: "execute_authorized_payment",
          summary: "由用户付款，或由 AI 使用有效的一次性授权付款",
          responses: {
            "200": { description: "模拟支付成功" },
            "403": { description: "AI 缺少或使用了无效付款授权" },
          },
        },
      },
    },
  });
}
