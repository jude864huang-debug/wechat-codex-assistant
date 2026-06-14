import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import {
  classifyApprovalReply,
  formatDesktopLiveUpdateNote,
  formatNoticeContinuationPrefix,
  formatNoticeSummary,
  handleWechatText,
  resolveReferencedNotice,
  type RouterDeps,
} from "../src/router.js";
import { removeStateDbForTests, StateStore } from "../src/state.js";
import type { AccountData, NoticeRecord, WechatMessage } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notice formatting", () => {
  it("expands the body and falls back to cwd basename", () => {
    const notice: NoticeRecord = {
      id: "ab2ac3",
      sessionId: "s",
      turnId: "t",
      cwd: "/Users/qqk/Documents/Wechat-Codex",
      title: "Codex 出话完成",
      summary: "已经处理到“配置后稳定可收”的状态。当前本机结果：daemon service installed and loaded。",
      body: "## Full body\nUse `code`",
      source: "hook",
      createdAt: Date.now(),
    };

    const text = formatNoticeSummary(notice);

    expect(text).toContain("Wechat-Codex项目（ab2ac3）已出话：");
    expect(text).toContain("Full body");
    expect(text).toContain("code");
    expect(text).not.toContain("/show");
    expect(text).not.toContain("/r");
    expect(text).not.toContain("未匹配项目");
    expect(text).not.toContain("/Users/qqk/Documents/Wechat-Codex");
  });

  it("prefers configured project alias over cwd basename", () => {
    const notice: NoticeRecord = {
      id: "cebf35",
      sessionId: "s",
      cwd: "/Users/qqk/Documents/Wechat-Codex",
      projectAlias: "WeChat-Codex",
      title: "Codex 出话完成",
      summary: "通知格式已简化。",
      body: "full body",
      source: "hook",
      createdAt: Date.now(),
    };

    expect(formatNoticeSummary(notice)).toContain("WeChat-Codex项目（cebf35）已出话：");
    expect(formatNoticeContinuationPrefix(notice)).toContain("WeChat-Codex项目（cebf35）");
  });
});

describe("desktop live update notice", () => {
  it("adds a reopen hint when transport is not live", () => {
    expect(
      formatDesktopLiveUpdateNote({
        configuredMode: "auto",
        modeUsed: "spawn",
        liveDesktopUpdates: false,
        reason: "fallback",
      }),
    ).toContain("Desktop 未接入共享 app-server");
  });

  it("stays quiet when transport supports live Desktop updates", () => {
    expect(
      formatDesktopLiveUpdateNote({
        configuredMode: "auto",
        modeUsed: "desktop-proxy",
        liveDesktopUpdates: true,
        reason: "connected",
      }),
    ).toBe("");
  });
});

describe("referenced notification routing", () => {
  it("blocks non-owner remote control by default even when allowlisted", async () => {
    const db = tempDb("router-owner-only");
    removeStateDbForTests(db);
    const state = new StateStore(db);
    state.addAllowed("owner@im.wechat", "owner", true);
    state.addAllowed("guest@im.wechat", "guest", false);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const codex = {
      resumeThread: vi.fn(),
      runTurn: vi.fn(),
      transportStatus: () => ({ configuredMode: "auto", modeUsed: "spawn", liveDesktopUpdates: false, reason: "test" }),
    } as unknown as RouterDeps["codex"];

    await handleWechatText(
      { config: { ...defaultConfig(), ownerSenderId: "owner@im.wechat" }, account: testAccount(), state, codex },
      {
        senderId: "guest@im.wechat",
        contextToken: "ctx",
        text: "/projects",
        message: {
          from_user_id: "guest@im.wechat",
          context_token: "ctx",
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: "/projects" } }],
        },
      },
    );

    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.runTurn).not.toHaveBeenCalled();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.msg.item_list[0].text_item.text).toContain("默认只允许 owner");

    state.close();
    removeStateDbForTests(db);
  });

  it("resolves quoted notification by outbound message key", () => {
    const db = tempDb("router-ref");
    removeStateDbForTests(db);
    const state = new StateStore(db);
    const notice = state.createNotice({
      sessionId: "s",
      threadId: "t",
      title: "done",
      summary: "summary",
      body: "body",
      source: "hook",
      createdAt: 1,
    });
    state.recordOutboundNoticeMessage("u@im.wechat", notice.id, ["item:notice:ab2ac3:1"]);

    expect(resolveReferencedNotice({ state }, "u@im.wechat", quotedMessage("notice:ab2ac3:1"))?.id).toBe(notice.id);

    state.close();
    removeStateDbForTests(db);
  });

  it("fails closed instead of falling back to the current chat when a quote cannot be resolved", async () => {
    const db = tempDb("router-unresolved-ref");
    removeStateDbForTests(db);
    const state = new StateStore(db);
    state.addAllowed("u@im.wechat", "tester", true);
    state.patchChat("u@im.wechat", { currentProject: "ai推广培训", currentThread: "wrong-thread" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const codex = {
      resumeThread: vi.fn(),
      runTurn: vi.fn(),
      transportStatus: () => ({ configuredMode: "auto", modeUsed: "spawn", liveDesktopUpdates: false, reason: "test" }),
    } as unknown as RouterDeps["codex"];
    const config = {
      ...defaultConfig(),
      projects: [{ alias: "ai推广培训", path: "/Users/qqk/Documents/My_Projects/AI推广培训" }],
    };

    await handleWechatText(
      { config, account: testAccount(), state, codex },
      {
        senderId: "u@im.wechat",
        contextToken: "ctx",
        text: "继续处理",
        message: quotedMessage("unknown-message-id"),
      },
    );

    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.runTurn).not.toHaveBeenCalled();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.msg.item_list[0].text_item.text).toContain("已停止处理");

    state.close();
    removeStateDbForTests(db);
  });

  it("continues the last notice for unquoted regular text instead of the sticky current chat", async () => {
    const db = tempDb("router-last-notice");
    removeStateDbForTests(db);
    const state = new StateStore(db);
    state.addAllowed("u@im.wechat", "tester", true);
    const notice = state.createNotice({
      sessionId: "right-thread",
      threadId: "right-thread",
      cwd: "/Users/qqk/Documents/Wechat-Codex",
      projectAlias: "WeChat-Codex",
      title: "done",
      summary: "summary",
      body: "body",
      source: "hook",
      createdAt: 1,
    });
    state.patchChat("u@im.wechat", {
      currentProject: "ai推广培训",
      currentThread: "wrong-thread",
      lastNoticeId: notice.id,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const codex = {
      resumeThread: vi.fn(),
      runTurn: vi.fn(async (params: { threadId: string; cwd?: string; onTurnId?: (turnId: string) => void }) => {
        params.onTurnId?.("turn-ok");
        return { threadId: params.threadId, turnId: "turn-ok", text: "完成", deniedRequests: 0 };
      }),
      transportStatus: () => ({ configuredMode: "auto", modeUsed: "spawn", liveDesktopUpdates: false, reason: "test" }),
    } as unknown as RouterDeps["codex"];
    const config = {
      ...defaultConfig(),
      wechatProgress: { typingEnabled: false, typingKeepaliveMs: 5000, heartbeatAfterMs: 0 },
      projects: [
        { alias: "ai推广培训", path: "/Users/qqk/Documents/My_Projects/AI推广培训" },
        { alias: "WeChat-Codex", path: "/Users/qqk/Documents/Wechat-Codex" },
      ],
    };

    await handleWechatText(
      { config, account: testAccount(), state, codex },
      {
        senderId: "u@im.wechat",
        contextToken: "ctx",
        text: "继续处理",
        message: {
          from_user_id: "u@im.wechat",
          context_token: "ctx",
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: "继续处理" } }],
        },
      },
    );

    expect(codex.resumeThread).toHaveBeenCalledWith("right-thread", "/Users/qqk/Documents/Wechat-Codex");
    expect(codex.runTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "right-thread", cwd: "/Users/qqk/Documents/Wechat-Codex" }));
    expect(state.getChat("u@im.wechat").currentProject).toBe("WeChat-Codex");

    state.close();
    removeStateDbForTests(db);
  });

  it("does not continue the sticky current chat when there is no last notice", async () => {
    const db = tempDb("router-unquoted");
    removeStateDbForTests(db);
    const state = new StateStore(db);
    state.addAllowed("u@im.wechat", "tester", true);
    state.patchChat("u@im.wechat", { currentProject: "ai推广培训", currentThread: "wrong-thread" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const codex = {
      resumeThread: vi.fn(),
      runTurn: vi.fn(),
      transportStatus: () => ({ configuredMode: "auto", modeUsed: "spawn", liveDesktopUpdates: false, reason: "test" }),
    } as unknown as RouterDeps["codex"];
    const config = {
      ...defaultConfig(),
      projects: [{ alias: "ai推广培训", path: "/Users/qqk/Documents/My_Projects/AI推广培训" }],
    };

    await handleWechatText(
      { config, account: testAccount(), state, codex },
      {
        senderId: "u@im.wechat",
        contextToken: "ctx",
        text: "继续处理",
        message: {
          from_user_id: "u@im.wechat",
          context_token: "ctx",
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: "继续处理" } }],
        },
      },
    );

    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.runTurn).not.toHaveBeenCalled();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.msg.item_list[0].text_item.text).toContain("还没有可续写的最近 Codex 通知");

    state.close();
    removeStateDbForTests(db);
  });
});

describe("approval reply classification", () => {
  it("recognizes explicit approval and denial replies", () => {
    expect(classifyApprovalReply("同意")).toBe("approve");
    expect(classifyApprovalReply("批准")).toBe("approve");
    expect(classifyApprovalReply("approve")).toBe("approve");
    expect(classifyApprovalReply("拒绝")).toBe("deny");
    expect(classifyApprovalReply("不同意")).toBe("deny");
    expect(classifyApprovalReply("deny")).toBe("deny");
  });

  it("does not treat ambiguous regular messages as approvals", () => {
    expect(classifyApprovalReply("好")).toBeNull();
    expect(classifyApprovalReply("可以继续解释一下")).toBeNull();
  });
});

function quotedMessage(msgId: string): WechatMessage {
  return {
    from_user_id: "u@im.wechat",
    context_token: "ctx",
    message_type: 1,
    item_list: [
      {
        type: 1,
        text_item: { text: "帮我继续" },
        ref_msg: {
          title: "Codex 完成",
          message_item: { type: 1, msg_id: msgId, text_item: { text: "查看：/show ab2ac3" } },
        },
      },
    ],
  };
}

function tempDb(name: string): string {
  return path.join(os.tmpdir(), `wechat-codex-${name}-${Date.now()}-${Math.random()}.sqlite`);
}

function testAccount(): AccountData {
  return {
    token: "token",
    baseUrl: "https://ilinkai.weixin.qq.com",
    accountId: "account",
    savedAt: new Date(0).toISOString(),
  };
}
