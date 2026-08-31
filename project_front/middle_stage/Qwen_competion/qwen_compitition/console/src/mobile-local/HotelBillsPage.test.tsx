import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HotelBillsPage from "./HotelBillsPage";

const expenseApi = vi.hoisted(() => ({
  createTripExpense: vi.fn(),
  deleteTripExpense: vi.fn(),
  listTripExpenses: vi.fn(),
  updateTripExpense: vi.fn(),
  trips: [] as Array<Record<string, unknown>>,
}));

vi.mock("./runtime", () => ({
  ...expenseApi,
  loadTrips: () => expenseApi.trips,
}));

describe("HotelBillsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expenseApi.trips = [
      {
        id: "trip-macau-weekend",
        title: "澳门周末行程",
        request: "澳门两日游",
        content: "",
        createdAt: 1,
        status: "active",
      },
    ];
    expenseApi.listTripExpenses.mockResolvedValue({
      expenses: [
        {
          id: "expense-hotel",
          trip_id: "trip-macau-weekend",
          category: "hotel",
          title: "酒店住宿",
          place_name: "澳门半岛",
          latitude: null,
          longitude: null,
          day: 1,
          unit_amount: 30000,
          quantity: 1,
          amount: 30000,
          currency: "CNY",
          required: true,
          note: "一晚",
          source: "agent",
          booking_id: null,
          created_at: "2026-08-21T00:00:00Z",
          updated_at: "2026-08-21T00:00:00Z",
        },
        {
          id: "expense-ticket",
          trip_id: "trip-macau-weekend",
          category: "ticket",
          title: "澳门旅游塔门票",
          place_name: "澳门旅游塔",
          latitude: null,
          longitude: null,
          day: 2,
          unit_amount: 3500,
          quantity: 2,
          amount: 7000,
          currency: "CNY",
          required: false,
          note: "观光层",
          source: "user",
          booking_id: null,
          created_at: "2026-08-21T00:00:00Z",
          updated_at: "2026-08-21T00:00:00Z",
        },
      ],
      summary: {
        total: 37000,
        required_total: 30000,
        optional_total: 7000,
        by_category: { hotel: 30000, ticket: 7000 },
        count: 2,
        currency: "CNY",
      },
    });
  });

  it("按所选行程展示总预算和可编辑费用明细", async () => {
    render(<HotelBillsPage />);

    expect(await screen.findByText("澳门周末行程 · 共 2 项费用")).toBeTruthy();
    expect(screen.getByText("¥370.00")).toBeTruthy();
    expect(screen.getByText("酒店住宿")).toBeTruthy();
    expect(screen.getByText("澳门旅游塔门票")).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑酒店住宿" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除酒店住宿" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
    expect(expenseApi.listTripExpenses).toHaveBeenCalledWith(
      "trip-macau-weekend",
    );
  });

  it("行程删除后立即清空对应账单选择", async () => {
    render(<HotelBillsPage />);
    await screen.findByText("澳门周末行程 · 共 2 项费用");

    expenseApi.trips = [];
    act(() => window.dispatchEvent(new Event("lensgo-trips-changed")));

    expect(
      await screen.findByText("还没有可选择的行程；请先在“旅程”栏目保存行程"),
    ).toBeTruthy();
  });

  it("行程重命名后立即同步账单中的行程名称", async () => {
    render(<HotelBillsPage />);
    await screen.findByText("澳门周末行程 · 共 2 项费用");

    expenseApi.trips = expenseApi.trips.map((trip) => ({
      ...trip,
      title: "澳门文化漫游",
    }));
    act(() => window.dispatchEvent(new Event("lensgo-trips-changed")));

    expect(await screen.findByText("澳门文化漫游 · 共 2 项费用")).toBeTruthy();
    expect(expenseApi.listTripExpenses).toHaveBeenLastCalledWith(
      "trip-macau-weekend",
    );
  });
});
