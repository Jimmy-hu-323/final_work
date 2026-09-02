import { describe, expect, it } from "vitest";
import { formatChatNavigation, parseChatNavigationIntent } from "./chatNavigation";

describe("chat navigation", () => {
  it.each([
    ["怎么去大三巴？", "大三巴", "transit"],
    ["从当前位置步行怎么去澳门大学", "澳门大学", "walking"],
    ["帮我导航到妈阁庙", "妈阁庙", "transit"],
    ["去黑沙海滩怎么走", "黑沙海滩", "transit"],
    ["打车怎么去澳门塔", "澳门塔", "driving"],
  ])("recognizes %s", (text, destination, mode) => {
    expect(parseChatNavigationIntent(text)).toEqual({ destination, mode });
  });

  it("does not intercept ordinary travel planning", () => {
    expect(parseChatNavigationIntent("我想去大三巴拍照")).toBeNull();
  });

  it("formats route details without persisting origin coordinates", () => {
    const text = formatChatNavigation(
      {
        available: true,
        mode: "walking",
        destination: {
          name: "大三巴牌坊",
          address: "澳门大三巴街",
          latitude: 22.1975,
          longitude: 113.5409,
        },
        distanceMeters: 1500,
        durationSeconds: 1200,
        steps: ["向北步行"],
        source: "高德地图实时路线规划",
      },
      "大三巴",
    );
    expect(text).toContain("1.5 公里");
    expect(text).toContain("20 分钟");
    expect(text).toContain("打开高德地图开始导航");
    expect(text).not.toContain("from=");
  });

  it("formats public transport and opens AMap in bus mode", () => {
    const text = formatChatNavigation(
      {
        available: true,
        mode: "transit",
        destination: {
          name: "大三巴牌坊",
          address: "澳门大三巴街",
          latitude: 22.1975,
          longitude: 113.5409,
        },
        distanceMeters: 3000,
        durationSeconds: 1800,
        steps: ["向左转后步行 100 米"],
        transitOptions: [
          {
            durationSeconds: 1800,
            walkingDurationSeconds: 400,
            walkingDistanceMeters: 500,
            transferCount: 0,
            legs: [
              { kind: "walking", durationSeconds: 240, distanceMeters: 300 },
              {
                kind: "bus",
                line: "25路",
                fromStop: "新口岸",
                toStop: "新马路",
                viaStops: 8,
                busReport: {
                  dataType: "mock",
                  source: "LensGo 模拟巴士发布器",
                  disclaimer: "模拟报站，仅用于功能演示，不可作为实际乘车依据。",
                  stopName: "新口岸",
                  routeNo: "25",
                  arrivals: [
                    {
                      vehicleId: "demo-25-01",
                      etaMinutes: 4,
                      stopsAway: 2,
                      occupancyLevel: 2,
                    },
                  ],
                },
              },
              { kind: "walking", durationSeconds: 160, distanceMeters: 200 },
            ],
          },
          {
            durationSeconds: 2100,
            walkingDurationSeconds: 200,
            walkingDistanceMeters: 240,
            transferCount: 1,
            legs: [
              { kind: "bus", line: "17路", fromStop: "A站", toStop: "B站" },
              { kind: "bus", line: "8A路", fromStop: "B站", toStop: "C站" },
            ],
          },
        ],
        source: "高德地图实时路线规划",
      },
      "大三巴",
    );
    expect(text).toContain("出行方式：公共交通");
    expect(text).toContain("公交方案对比");
    expect(text).toContain("方案 1（推荐）");
    expect(text).toContain("步行约 7 分钟（500 米）");
    expect(text).toContain("在 **新口岸** 上车乘坐 **25路**");
    expect(text).toContain("**预计到站**：demo-25-01：约 4 分钟，2 站，车内适中");
    expect(text).not.toContain("不可作为实际乘车依据");
    expect(text).toContain("无需换乘");
    expect(text).toContain("方案 2");
    expect(text).toContain("换乘 1 次");
    expect(text).not.toContain("向左转后步行");
    expect(text).toContain("mode=bus");
  });
});
