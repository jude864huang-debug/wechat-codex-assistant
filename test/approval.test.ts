import { afterEach, describe, expect, it, vi } from "vitest";
import { WechatApprovalBroker, formatApprovalPrompt } from "../src/approval.js";
import { defaultConfig } from "../src/config.js";
import { removeStateDbForTests, StateStore } from "../src/state.js";
import type { AccountData, WechatMessage } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wechat approval prompts", () => {
  it("formats command approvals with approve and deny commands", () => {
    const text = formatApprovalPrompt("a1b2c3", "item/commandExecution/requestApproval", {
      command: "npm test",
      cwd: "/tmp/project",
      reason: "需要运行测试",
    });

    expect(text).toContain("Codex 请求微信审批（a1b2c3）");
    expect(text).toContain("类型：命令执行");
    expect(text).toContain("命令：npm test");
    expect(text).toContain("引用本消息回复：同意 / 拒绝");
    expect(text).toContain("兜底命令：/approve a1b2c3 / /deny a1b2c3");
  });

  it("treats quoted approval messages as approval replies even after the in-memory index is absent", () => {
    const db = `/tmp/wechat-codex-approval-${Date.now()}-${Math.random()}.sqlite`;
    removeStateDbForTests(db);
    const state = new StateStore(db);
    const broker = new WechatApprovalBroker(defaultConfig(), testAccount(), state);

    expect(broker.canResolveReply("u@im.wechat", quotedApproval("approval:a1b2c3:1"))).toBe(true);

    state.close();
    removeStateDbForTests(db);
  });

  it("silently returns protocol fallbacks for non-approval server requests", async () => {
    const db = `/tmp/wechat-codex-approval-fallback-${Date.now()}-${Math.random()}.sqlite`;
    removeStateDbForTests(db);
    const state = new StateStore(db);
    state.addAllowed("u@im.wechat", "tester", true);
    state.upsertContextToken("u@im.wechat", "ctx");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const broker = new WechatApprovalBroker({ ...defaultConfig(), ownerSenderId: "u@im.wechat" }, testAccount(), state);

    await expect(
      broker.request({
        method: "item/tool/call",
        params: {
          threadId: "thread",
          turnId: "turn",
          callId: "call",
          namespace: "codex_app",
          tool: "list_threads",
          arguments: { query: "AI票夹", limit: 20 },
        },
      }),
    ).resolves.toEqual({ contentItems: [], success: false });
    expect(fetchMock).not.toHaveBeenCalled();

    state.close();
    removeStateDbForTests(db);
  });

  it("does not require owner context for non-approval fallbacks", async () => {
    const db = `/tmp/wechat-codex-approval-fallback-no-owner-${Date.now()}-${Math.random()}.sqlite`;
    removeStateDbForTests(db);
    const state = new StateStore(db);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const broker = new WechatApprovalBroker(defaultConfig(), testAccount(), state);

    await expect(
      broker.request({
        method: "item/tool/call",
        params: {
          threadId: "thread",
          turnId: "turn",
          callId: "call",
          namespace: "codex_app",
          tool: "list_threads",
          arguments: {},
        },
      }),
    ).resolves.toEqual({ contentItems: [], success: false });
    expect(fetchMock).not.toHaveBeenCalled();

    state.close();
    removeStateDbForTests(db);
  });
});

function quotedApproval(msgId: string): WechatMessage {
  return {
    from_user_id: "u@im.wechat",
    context_token: "ctx",
    message_type: 1,
    item_list: [
      {
        type: 1,
        text_item: { text: "同意" },
        ref_msg: {
          title: "Codex 请求微信审批（a1b2c3）",
          message_item: { type: 1, msg_id: msgId, text_item: { text: "引用本消息回复：同意 / 拒绝" } },
        },
      },
    ],
  };
}

function testAccount(): AccountData {
  return {
    token: "token",
    baseUrl: "https://example.com",
    accountId: "account",
    savedAt: new Date(0).toISOString(),
  };
}
