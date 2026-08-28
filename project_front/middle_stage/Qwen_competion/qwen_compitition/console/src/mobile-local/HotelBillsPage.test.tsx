import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HotelBillsPage from "./HotelBillsPage";

const expenseApi = vi.hoisted(() => ({
  createTripExpense: vi.fn(),
  deleteTripExpense: vi.fn(),
  listTripExpenses: vi.fn(),
  updateTripExpense: vi.fn(),
}));

vi.mock("./runtime", () => ({
  ...expenseApi,
  loadTrips: () => [
    {
      id: "trip-macau-weekend",
      title: "澳门周末行程",
      request: "澳门两日游",
      content: "",
      createdAt: 1,
      status: "active",
    },
  ],
}));

describe("HotelBillsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(
      await screen.findByText("澳门周末行程 · 共 2 项费用"),
    ).toBeTruthy();
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
});
