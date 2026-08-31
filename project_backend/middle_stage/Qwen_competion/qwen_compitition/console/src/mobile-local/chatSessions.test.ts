import { describe, expect, it, vi } from "vitest";
import {
  buildChatHistoryGroups,
  createChatSession,
  linkChatSessionToTrip,
  type LocalChatSession,
} from "./chatSessions";
import type { LocalTrip } from "./runtime";

vi.mock("./runtime", () => ({
  createId: () => "chat-created",
  loadMessages: () => [],
}));
vi.mock("./qwenpaw", () => ({ loadQwenPawSessionId: () => "remote" }));
vi.mock("./tripSync", () => ({
  stripAgentControlContent: (value: string) => value,
}));

const session = (
  id: string,
  updatedAt: number,
  tripId?: string,
): LocalChatSession => ({
  id,
  title: id,
  messages: [],
  model: "model",
  remoteSessionId: `remote-${id}`,
  tripId,
  tripTitle: tripId ? `旧名称-${tripId}` : undefined,
  createdAt: updatedAt,
  updatedAt,
});

describe("chat trip folders", () => {
  it("文件夹内新建对话会直接绑定指定行程", () => {
    expect(
      createChatSession("model", [], {
        tripId: "trip-active",
        tripTitle: "澳门文化之旅",
      }),
    ).toMatchObject({
      id: "chat-created",
      tripId: "trip-active",
      tripTitle: "澳门文化之旅",
    });
  });

  it("开始行程时只把对应规划会话放入文件夹", () => {
    const linked = linkChatSessionToTrip(
      [session("planning", 1), session("ordinary", 2)],
      "planning",
      { id: "trip-active", title: "澳门文化之旅" },
    );
    expect(linked[0]).toMatchObject({
      tripId: "trip-active",
      tripTitle: "澳门文化之旅",
    });
    expect(linked[1].tripId).toBeUndefined();
  });

  it("固定分开行程文件夹和其他对话，并以当前行程名称为准", () => {
    const trips: LocalTrip[] = [
      {
        id: "trip-completed",
        title: "已结束行程",
        request: "",
        content: "",
        createdAt: 1,
        startedAt: 10,
        status: "completed",
      },
      {
        id: "trip-active",
        title: "已重命名的澳门之旅",
        request: "",
        content: "",
        createdAt: 2,
        startedAt: 20,
        status: "active",
      },
    ];
    const groups = buildChatHistoryGroups(
      [
        session("普通对话", 40),
        session("行程对话", 30, "trip-active"),
        session("已删除行程对话", 50, "trip-removed"),
      ],
      trips,
    );

    expect(groups.folders.map((folder) => folder.tripId)).toEqual([
      "trip-active",
      "trip-removed",
      "trip-completed",
    ]);
    expect(groups.folders[0].title).toBe("已重命名的澳门之旅");
    expect(groups.folders[1]).toMatchObject({
      title: "旧名称-trip-removed",
      orphaned: true,
    });
    expect(groups.otherSessions.map((item) => item.id)).toEqual(["普通对话"]);
  });
});
