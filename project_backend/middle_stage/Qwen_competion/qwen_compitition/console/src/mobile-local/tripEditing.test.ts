import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripExpense } from "./runtime";

const runtime = vi.hoisted(() => ({
  listTripExpenses: vi.fn(),
  updateTripExpense: vi.fn(),
}));

vi.mock("./runtime", () => runtime);

import {
  buildEditedTripMarkdown,
  linkedExpenseUpdates,
  syncTripExpensesForStops,
} from "./tripEditing";

function expense(overrides: Partial<TripExpense> = {}): TripExpense {
  return {
    id: "expense-1",
    trip_id: "trip-1",
    category: "ticket",
    title: "景点门票",
    place_name: "大三巴",
    latitude: null,
    longitude: null,
    day: 1,
    unit_amount: 8800,
    quantity: 2,
    amount: 17600,
    currency: "CNY",
    required: true,
    note: "现场取票",
    source: "planner",
    booking_id: null,
    created_at: "2026-08-31T10:00:00Z",
    updated_at: "2026-08-31T10:00:00Z",
    ...overrides,
  };
}

describe("trip editing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("按旧地点和天数更新关联账单，同时保留金额字段", () => {
    const updates = linkedExpenseUpdates(
      [expense()],
      [{ id: "stop-1", name: "大三巴", day: 1 }],
      [{ id: "stop-1", name: "澳门塔", day: 2 }],
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].input).toEqual({
      title: "景点门票",
      category: "ticket",
      placeName: "澳门塔",
      day: 2,
      unitAmount: 8800,
      quantity: 2,
      required: true,
      note: "现场取票",
    });
  });

  it("不会修改地点相同但天数不同的手工账单", () => {
    const updates = linkedExpenseUpdates(
      [expense({ day: 3 })],
      [{ id: "stop-1", name: "大三巴", day: 1 }],
      [{ id: "stop-1", name: "澳门塔", day: 2 }],
    );

    expect(updates).toEqual([]);
  });

  it("地点为空时按同名标题关联手工账单并同步标题", () => {
    const updates = linkedExpenseUpdates(
      [expense({ title: "大三巴", place_name: "", source: "manual" })],
      [{ id: "stop-1", name: "大三巴", day: 1 }],
      [{ id: "stop-1", name: "澳门塔", day: 2 }],
    );

    expect(updates[0]?.input).toMatchObject({
      title: "澳门塔",
      placeName: "澳门塔",
      day: 2,
    });
  });

  it("重建完整规划说明，确保总览和当日视图读取同一份新路线", () => {
    const markdown = buildEditedTripMarkdown("澳门新路线", [
      { id: "stop-2", name: "妈阁庙", day: 2, time: "14:00" },
      {
        id: "stop-1",
        name: "澳门塔",
        day: 1,
        time: "09:30",
        note: "先到观景层",
      },
    ]);

    expect(markdown).toContain("# 澳门新路线");
    expect(markdown.indexOf("第 1 天")).toBeLessThan(
      markdown.indexOf("第 2 天"),
    );
    expect(markdown).toContain("09:30｜澳门塔");
    expect(markdown).toContain("先到观景层");
  });

  it("只修改时间或备注时不访问账单服务", async () => {
    const updated = await syncTripExpensesForStops(
      "trip-1",
      [{ id: "stop-1", name: "大三巴", day: 1, time: "09:00" }],
      [{ id: "stop-1", name: "大三巴", day: 1, time: "10:00" }],
    );

    expect(updated).toBe(0);
    expect(runtime.listTripExpenses).not.toHaveBeenCalled();
  });

  it("后续账单写入失败时回滚已完成的账单", async () => {
    runtime.listTripExpenses.mockResolvedValue({
      expenses: [
        expense(),
        expense({ id: "expense-2", title: "交通", category: "transport" }),
      ],
      summary: {},
    });
    runtime.updateTripExpense
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("服务中断"))
      .mockResolvedValueOnce(undefined);

    await expect(
      syncTripExpensesForStops(
        "trip-1",
        [{ id: "stop-1", name: "大三巴", day: 1 }],
        [{ id: "stop-1", name: "澳门塔", day: 2 }],
      ),
    ).rejects.toThrow("服务中断");

    expect(runtime.updateTripExpense).toHaveBeenLastCalledWith(
      "expense-1",
      expect.objectContaining({ placeName: "大三巴", day: 1 }),
    );
  });
});
