import { beforeEach, describe, expect, it, vi } from "vitest";
import { renameTrip } from "./tripRenaming";

const runtime = vi.hoisted(() => ({
  loadTrips: vi.fn(),
  saveTrips: vi.fn(),
}));

vi.mock("./runtime", () => runtime);

describe("trip renaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.loadTrips.mockReturnValue([
      {
        id: "trip-rename",
        title: "旧行程名称",
        request: "澳门两日游",
        content: "# 旧行程名称\n\n原安排说明",
        createdAt: 1,
        status: "planned",
      },
      {
        id: "trip-keep",
        title: "保留名称",
        request: "澳门一日游",
        content: "",
        createdAt: 2,
        status: "planned",
      },
    ]);
  });

  it("只更新共享行程名称并保持账单关联使用的行程 id", () => {
    const renamed = renameTrip("trip-rename", "  澳门文化漫游  ");

    expect(renamed).toMatchObject({
      id: "trip-rename",
      title: "澳门文化漫游",
      content: "# 澳门文化漫游\n\n原安排说明",
    });
    expect(runtime.saveTrips).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "trip-rename",
        title: "澳门文化漫游",
        updatedAt: expect.any(Number),
      }),
      expect.objectContaining({ id: "trip-keep", title: "保留名称" }),
    ]);
  });

  it("拒绝空名称且不覆盖现有行程", () => {
    expect(() => renameTrip("trip-rename", "   ")).toThrow("请输入行程名称");
    expect(runtime.saveTrips).not.toHaveBeenCalled();
  });
});
