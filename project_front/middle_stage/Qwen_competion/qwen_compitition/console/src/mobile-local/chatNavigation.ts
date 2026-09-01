import type { ChatNavigationResponse } from "./runtime";

export type ChatNavigationIntent = {
  destination: string;
  mode: "transit" | "driving" | "walking";
};

const ENDING = /[？?。！!，,\s]+$/g;

function cleanDestination(value: string): string {
  return value
    .replace(ENDING, "")
    .replace(/(?:，|,)?(?:步行|走路|驾车|开车|打车|坐车)(?:过去|前往)?$/u, "")
    .trim()
    .slice(0, 100);
}

export function parseChatNavigationIntent(
  text: string,
): ChatNavigationIntent | null {
  const source = text.trim();
  if (!source) return null;
  const mode = /步行|走路|徒步/u.test(source)
    ? "walking"
    : /驾车|开车|打车|的士|出租车|坐车/u.test(source)
      ? "driving"
      : "transit";
  const patterns = [
    /^(?:请问[，,]?\s*)?(?:从(?:我)?(?:这里|这儿|当前位置)\s*)?(?:我\s*)?(?:现在\s*)?(?:应该\s*)?(?:(?:步行|走路|徒步|驾车|开车|打车|坐车)\s*)?(?:怎么|如何|怎样)(?:才能)?(?:去|到|前往)\s*(.+)$/u,
    /^(?:请|麻烦)?(?:帮我)?\s*(?:导航|带我)(?:去|到|前往)?\s*(.+)$/u,
    /^(?:从(?:我)?(?:这里|这儿|当前位置)\s*)?(?:去|到|前往)\s*(.+?)\s*(?:怎么走|如何走|的?路线|怎么导航)$/u,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const destination = cleanDestination(match?.[1] || "");
    if (destination.length >= 2) return { destination, mode };
  }
  return null;
}

const markdownText = (value: string) =>
  value.replace(/([\\`*_{}\[\]()<>#+.!|])/g, "\\$1");

function distanceLabel(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} 公里`
    : `${Math.max(0, Math.round(meters))} 米`;
}

function durationLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function formatTransitOptions(
  options: NonNullable<ChatNavigationResponse["transitOptions"]>,
): string {
  return options.slice(0, 3).map((option, optionIndex) => {
    const transfer = option.transferCount
      ? `换乘 ${option.transferCount} 次`
      : "无需换乘";
    const walking = option.walkingDistanceMeters
      ? `步行约 ${durationLabel(option.walkingDurationSeconds)}（${distanceLabel(
          option.walkingDistanceMeters,
        )}）`
      : "基本无需步行";
    let rideIndex = 0;
    const instructions = option.legs.map((leg, legIndex) => {
      if (leg.kind === "walking") {
        const nextRide = option.legs
          .slice(legIndex + 1)
          .find((item) => item.kind !== "walking");
        const previousRide = [...option.legs]
          .slice(0, legIndex)
          .reverse()
          .find((item) => item.kind !== "walking");
        const walkTime = durationLabel(
          leg.durationSeconds || Math.max(60, (leg.distanceMeters || 0) / 1.2),
        );
        if (!previousRide && nextRide?.fromStop) {
          return `步行约 ${walkTime} 到 **${markdownText(nextRide.fromStop)}** 上车`;
        }
        if (nextRide?.fromStop) {
          return `下车后步行约 ${walkTime} 到 **${markdownText(nextRide.fromStop)}** 换乘`;
        }
        return `下车后步行约 ${walkTime} 到达目的地`;
      }
      const currentRide = rideIndex++;
      const action = currentRide ? "换乘" : "上车乘坐";
      const stopCount = leg.viaStops ? `，途经约 ${leg.viaStops} 站` : "";
      return `在 **${markdownText(leg.fromStop || "上车站")}** ${action} **${markdownText(
        leg.line || (leg.kind === "railway" ? "轨道交通" : "公交车"),
      )}**，到 **${markdownText(leg.toStop || "下车站")}** 下车${stopCount}`;
    });
    return `### 方案 ${optionIndex + 1}${optionIndex === 0 ? "（推荐）" : ""}\n\n- 总耗时：约 ${durationLabel(
      option.durationSeconds,
    )}\n- 步行与换乘：${walking}；${transfer}\n\n${instructions
      .map((instruction, index) => `${index + 1}. ${instruction}`)
      .join("\n")}`;
  }).join("\n\n");
}

export function formatChatNavigation(
  result: ChatNavigationResponse,
  requestedDestination: string,
): string {
  if (!result.available || !result.destination) {
    return result.reason || `暂时无法规划前往“${requestedDestination}”的路线。`;
  }
  const destination = result.destination;
  const mode =
    result.mode === "walking"
      ? "步行"
      : result.mode === "driving"
        ? "驾车"
        : "公共交通";
  const uriMode =
    result.mode === "walking"
      ? "walk"
      : result.mode === "driving"
        ? "car"
        : "bus";
  const navigationUrl =
    `https://uri.amap.com/navigation?to=${destination.longitude},${destination.latitude},` +
    `${encodeURIComponent(destination.name)}&mode=${uriMode}&policy=1&src=LensGo&coordinate=gaode&callnative=1`;
  const transitOptions = result.transitOptions || [];
  const steps = (result.steps || []).slice(0, 6);
  const routeSummary =
    result.mode === "transit" && transitOptions.length
      ? `\n\n## 公交方案对比\n\n${formatTransitOptions(transitOptions)}`
      : steps.length
        ? `\n\n路线摘要：\n\n${steps
            .map((step, index) => `${index + 1}. ${markdownText(step)}`)
            .join("\n")}`
        : "";
  const address = destination.address
    ? `\n- 目的地地址：${markdownText(destination.address)}`
    : "";
  return `已根据你本次提供的手机位置规划路线：\n\n- 目的地：**${markdownText(
    destination.name,
  )}**${address}\n- 出行方式：${mode}\n- 路程：约 ${distanceLabel(
    result.distanceMeters || 0,
  )}\n- 预计时间：约 ${durationLabel(result.durationSeconds || 0)}${routeSummary}\n\n[打开高德地图开始导航](${navigationUrl})\n\n> 来源：${markdownText(
    result.source || "高德地图路线规划",
  )}。当前位置仅用于本次查询，没有写入这条对话。`;
}
