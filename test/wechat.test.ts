import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  extractReferencedApprovalIds,
  extractReferencedMessageKeys,
  extractReferencedNoticeIds,
  hasReferencedMessage,
  isWechatContextTokenStaleError,
  monitorWechat,
  sendLongText,
  syncPath,
} from "../src/wechat.js";
import { defaultConfig } from "../src/config.js";
import type { WechatMessage } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CODEX_WECHAT_HOME;
});

describe("WeChat referenced messages", () => {
  it("extracts referenced item message keys", () => {
    const message = refMessage({
      title: "Codex 完成",
      message_item: {
        type: 1,
        msg_id: "notice:ab2ac3:1",
        text_item: { text: "查看：/show ab2ac3" },
      },
    });

    expect(extractReferencedMessageKeys(message)).toEqual(["item:notice:ab2ac3:1"]);
  });

  it("extracts notice ids from referenced title and text", () => {
    const message = refMessage({
      title: "WeChat-Codex项目（cebf35）已出话：",
      message_item: {
        type: 1,
        text_item: { text: "查看：/show ab2ac3" },
      },
    });

    expect(extractReferencedNoticeIds(message)).toEqual(["cebf35", "ab2ac3"]);
  });

  it("detects quoted messages even when notice ids cannot be resolved", () => {
    expect(hasReferencedMessage(refMessage({ title: "普通引用" }))).toBe(true);
    expect(
      hasReferencedMessage({
        from_user_id: "u@im.wechat",
        context_token: "ctx",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "继续" } }],
      }),
    ).toBe(false);
  });

  it("extracts approval ids from referenced approval prompts", () => {
    const message = refMessage({
      title: "Codex 请求微信审批（a1b2c3）",
      message_item: {
        type: 1,
        msg_id: "approval:a1b2c3:1",
        text_item: { text: "批准：/approve a1b2c3\n拒绝：/deny a1b2c3" },
      },
    });

    expect(extractReferencedMessageKeys(message)).toEqual(["item:approval:a1b2c3:1"]);
    expect(extractReferencedApprovalIds(message)).toEqual(["a1b2c3"]);
  });
});

describe("WeChat API responses", () => {
  it("throws on non-zero business ret values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: -2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const error = await apiFetch(defaultConfig(), "ilink/bot/sendmessage", {}, "token").catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("WeChat API ilink/bot/sendmessage returned ret=-2");
    expect(isWechatContextTokenStaleError(error)).toBe(true);
  });

  it("accepts responses without ret fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ msgs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(apiFetch(defaultConfig(), "ilink/bot/getupdates", {}, "token")).resolves.toEqual({ msgs: [] });
  });

  it("adds notice identity to continuation chunks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await sendLongText(defaultConfig(), testAccount(), "u@im.wechat", "a".repeat(1900), "ctx", {
      messageIdPrefix: "notice:abc123",
      continuationPrefix: "续 WeChat-Codex项目（abc123）：",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondPayload.msg.item_list[0].msg_id).toBe("notice:abc123:2");
    expect(secondPayload.msg.item_list[0].text_item.text).toContain("（abc123）");
  });

  it("runs the durable receive hook before advancing the sync buffer", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-monitor-"));
    process.env.CODEX_WECHAT_HOME = home;
    const controller = new AbortController();
    const calls: string[] = [];
    const message: WechatMessage = {
      message_id: 9,
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: "继续" } }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0, get_updates_buf: "next-sync", msgs: [message] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      await monitorWechat(
        defaultConfig(),
        testAccount(),
        async () => {
          calls.push("message");
          expect(fs.readFileSync(syncPath(), "utf8")).toBe("next-sync");
          controller.abort();
        },
        {
          signal: controller.signal,
          onMessagesReceived: () => {
            calls.push("received");
            expect(fs.existsSync(syncPath())).toBe(false);
          },
        },
      );

      expect(calls).toEqual(["received", "message"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function testAccount() {
  return {
    token: "token",
    baseUrl: "https://ilinkai.weixin.qq.com",
    accountId: "account",
    savedAt: new Date(0).toISOString(),
  };
}

function refMessage(ref_msg: NonNullable<NonNullable<WechatMessage["item_list"]>[number]["ref_msg"]>): WechatMessage {
  return {
    from_user_id: "u@im.wechat",
    context_token: "ctx",
    message_type: 1,
    item_list: [
      {
        type: 1,
        text_item: { text: "继续这个" },
        ref_msg,
      },
    ],
  };
}
