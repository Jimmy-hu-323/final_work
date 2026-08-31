import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  deleteTripExpenses: vi.fn(),
  loadTrips: vi.fn(),
  saveTrips: vi.fn(),
}));

vi.mock("./runtime", () => runtime);

import { deleteTripAndBills } from "./tripDeletion";

describe("deleteTripAndBills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.loadTrips.mockReturnValue([
      { id: "trip-delete", title: "删除行程" },
      { id: "trip-keep", title: "保留行程" },
    ]);
  });

  it("先删除关联账单，再删除本地行程", async () => {
    runtime.deleteTripExpenses.mockResolvedValue(5);

    const result = await deleteTripAndBills("trip-delete");

    expect(runtime.deleteTripExpenses).toHaveBeenCalledWith("trip-delete");
    expect(runtime.saveTrips).toHaveBeenCalledWith([
      { id: "trip-keep", title: "保留行程" },
    ]);
    expect(runtime.deleteTripExpenses.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.saveTrips.mock.invocationCallOrder[0],
    );
    expect(result.removedExpenseCount).toBe(5);
  });

  it("账单删除失败时保留本地行程", async () => {
    runtime.deleteTripExpenses.mockRejectedValue(new Error("账单服务不可用"));

    await expect(deleteTripAndBills("trip-delete")).rejects.toThrow(
      "账单服务不可用",
    );
    expect(runtime.loadTrips).not.toHaveBeenCalled();
    expect(runtime.saveTrips).not.toHaveBeenCalled();
  });
});
