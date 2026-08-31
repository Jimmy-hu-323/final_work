import { describe, expect, it } from "vitest";
import {
  budgetExpensesFromMarkdown,
  extractAgentTripProposal,
  proposalFromRemoteItinerary,
  stripAgentControlContent,
} from "./tripSync";

describe("trip sync", () => {
  it("accepts the documented LensGo trip update block", () => {
    const proposal =
      extractAgentTripProposal(`已完成规划。\n\n\`\`\`lensgo-trip-update
{"tripId":"new","title":"澳门一日游","markdown":"# 澳门一日游","stops":[{"id":"s1","name":"大三巴","day":1,"time":"09:00","longitude":113.545,"latitude":22.197}]}
\`\`\``);
    expect(proposal?.title).toBe("澳门一日游");
    expect(proposal?.stops?.[0]).toMatchObject({
      name: "大三巴",
      longitude: 113.545,
      latitude: 22.197,
    });
  });

  it("parses structured planning expenses into bill inputs", () => {
    const proposal = extractAgentTripProposal(`\`\`\`lensgo-trip-update
{"tripId":"new","title":"澳门一日游","markdown":"# 澳门一日游","stops":[{"id":"s1","name":"大三巴","day":1}],"expenses":[{"title":"大三巴门票","category":"ticket","placeName":"大三巴","day":1,"amountYuan":88.5,"quantity":2,"required":true}]}
\`\`\``);

    expect(proposal?.expenses).toEqual([
      expect.objectContaining({
        title: "大三巴门票",
        category: "ticket",
        placeName: "大三巴",
        day: 1,
        unitAmount: 8850,
        quantity: 2,
      }),
    ]);
  });

  it("falls back to Markdown budget rows and does not duplicate the total", () => {
    const expenses = budgetExpensesFromMarkdown(
      "## 预算\n- 大三巴门票：80元\n- 午餐：120元\n- 合计：200元",
      [{ id: "s1", name: "大三巴", day: 1 }],
    );

    expect(expenses).toHaveLength(2);
    expect(expenses.map((expense) => expense.unitAmount)).toEqual([
      8000, 12000,
    ]);
    expect(expenses[0]).toMatchObject({
      category: "ticket",
      placeName: "大三巴",
    });
  });

  it("does not turn a trip budget summary into another bill", () => {
    const expenses = budgetExpensesFromMarkdown(
      "**1人 · 9月1日 · 预算500元 · 全程步行**\n\n## 预算明细（约450元，留50元弹性）\n- 早餐35 + 午餐80 + 下午茶55 + 手信150 + 弹性130 = 450元",
      [],
    );

    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      unitAmount: 45000,
      category: "meal",
    });
  });

  it("hides trip bridge payloads and internal comments from chat", () => {
    const reply = `行程已经准备好了。

\`\`\`lensgo-trip-update
{"tripId":"new","title":"澳门一日游","markdown":"# 澳门一日游","stops":[{"id":"s1","name":"大三巴","day":1,"time":"09:00"}]}
\`\`\`

<!-- [输出 lensgo-trip-update 代码块等待用户确认写入] -->`;
    expect(stripAgentControlContent(reply)).toBe("行程已经准备好了。");
  });

  it("hides an incomplete streaming control block", () => {
    expect(
      stripAgentControlContent(
        '正在生成。\n\n```lensgo-trip-update\n{"tripId":"new"',
      ),
    ).toBe("正在生成。");
  });

  it("keeps ordinary JSON examples visible", () => {
    const reply = '示例：\n\n```json\n{"city":"澳门"}\n```';
    expect(stripAgentControlContent(reply)).toBe(reply);
  });

  it("converts the server AMap snapshot to a mappable local trip", () => {
    const proposal = proposalFromRemoteItinerary({
      title: "澳门文化之旅",
      destination: "澳门",
      day_count: 1,
      updated_at: "2026-08-06T10:00:00+08:00",
      days: [
        {
          day_number: 1,
          title: "澳门半岛",
          activities: [
            {
              order: 1,
              name: "大三巴牌坊",
              location: "113.5456,22.1975",
              arrive_time: "09:00",
            },
          ],
        },
      ],
    });
    expect(proposal?.tripId).toBe("new");
    expect(proposal?.stops?.[0]).toMatchObject({
      longitude: 113.5456,
      latitude: 22.1975,
    });
    expect(proposal?.content).toContain("第 1 天");
  });
});
