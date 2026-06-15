import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inboundMessageKey, removeStateDbForTests, StateStore } from "../src/state.js";

function tempDb(name: string): string {
  return path.join(os.tmpdir(), `wechat-codex-${name}-${Date.now()}-${Math.random()}.sqlite`);
}

describe("StateStore", () => {
  it("stores allowlist, context tokens, chat state, notices, and self turns", () => {
    const db = tempDb("state");
    removeStateDbForTests(db);
    const store = new StateStore(db);
    store.addAllowed("u@im.wechat", "U", true);
    expect(store.isAllowed("u@im.wechat")).toBe(true);
    expect(store.ownerSenderId()).toBe("u@im.wechat");
    store.upsertContextToken("u@im.wechat", "ctx");
    expect(store.getContextToken("u@im.wechat")).toBe("ctx");
    expect(store.getContextTokenUpdatedAt("u@im.wechat")).toBeGreaterThan(0);
    store.markContextTokenStale("u@im.wechat", "ret=-2");
    expect(store.getContextTokenStatus("u@im.wechat")).toMatchObject({ stale: true, reason: "ret=-2" });
    store.upsertContextToken("u@im.wechat", "ctx2");
    expect(store.getContextToken("u@im.wechat")).toBe("ctx2");
    expect(store.getContextTokenStatus("u@im.wechat").stale).toBe(false);
    store.patchChat("u@im.wechat", { currentProject: "p", currentThread: "t", pendingNewProject: "p", muted: true });
    expect(store.getChat("u@im.wechat").muted).toBe(true);
    expect(store.getChat("u@im.wechat").pendingNewProject).toBe("p");
    store.patchChat("u@im.wechat", { pendingNewProject: undefined });
    expect(store.getChat("u@im.wechat").pendingNewProject).toBeUndefined();
    const notice = store.createNotice({
      sessionId: "s",
      threadId: "t",
      turnId: "turn",
      title: "done",
      summary: "summary",
      body: "body",
      createdAt: 1,
      source: "hook",
    });
    store.patchChat("u@im.wechat", { lastNoticeId: notice.id });
    expect(store.getNotice("last", "u@im.wechat")?.body).toBe("body");
    expect(store.pendingUndeliveredNotices()).toHaveLength(1);
    expect(store.countUndeliveredNotices()).toBe(1);
    store.markNoticeDelivered(notice.id);
    expect(store.pendingUndeliveredNotices()).toHaveLength(0);
    expect(store.countUndeliveredNotices()).toBe(0);
    store.recordOutboundNoticeMessage("u@im.wechat", notice.id, ["item:notice:abc123:1", "client:c1"]);
    expect(store.getNoticeIdByOutboundMessageKey("u@im.wechat", "item:notice:abc123:1")).toBe(notice.id);
    store.recordSelfTurn("t", "prompt", "turn", "assistant body");
    expect(store.isSelfTurn("t", "turn")).toBe(true);
    expect(store.isSelfTurn("different-session-id", "turn")).toBe(true);
    expect(store.isSelfTurn("different-session-id", undefined, "assistant body")).toBe(true);
    store.close();
    removeStateDbForTests(db);
  });

  it("migrates old chat_state tables without relying on column order", () => {
    const db = tempDb("state-migration");
    removeStateDbForTests(db);
    const raw = new DatabaseSync(db);
    raw.exec(`
      CREATE TABLE chat_state (
        sender_id TEXT PRIMARY KEY,
        current_project TEXT,
        current_thread TEXT,
        muted INTEGER NOT NULL DEFAULT 0,
        last_notice_id TEXT
      );
    `);
    raw.close();

    const store = new StateStore(db);
    store.patchChat("u@im.wechat", { currentProject: "p", currentThread: "t", pendingNewProject: "p2", muted: true, lastNoticeId: "n" });
    expect(store.getChat("u@im.wechat")).toMatchObject({
      currentProject: "p",
      currentThread: "t",
      pendingNewProject: "p2",
      muted: true,
      lastNoticeId: "n",
    });
    store.close();
    removeStateDbForTests(db);
  });

  it("stores inbound messages durably and idempotently until processed", () => {
    const db = tempDb("inbound");
    removeStateDbForTests(db);
    const store = new StateStore(db);
    const message = {
      message_id: 42,
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      message_type: 1,
      item_list: [{ type: 1, msg_id: "m1", text_item: { text: "继续" } }],
    };

    const keys = store.enqueueInboundMessages([message, message]);
    expect(keys).toEqual(["message:42", "message:42"]);
    expect(inboundMessageKey(message)).toBe("message:42");
    expect(store.pendingInboundMessages()).toHaveLength(1);
    expect(store.getInboundMessage("message:42")?.message.item_list?.[0]?.text_item?.text).toBe("继续");

    store.markInboundProcessing("message:42");
    expect(store.getInboundMessage("message:42")?.attempts).toBe(1);
    store.markInboundFailed("message:42", "temporary failure");
    expect(store.pendingInboundMessages()[0]?.lastError).toBe("temporary failure");
    store.markInboundProcessed("message:42");
    expect(store.pendingInboundMessages()).toHaveLength(0);
    expect(store.getInboundMessage("message:42")).toBeNull();

    store.close();
    removeStateDbForTests(db);
  });

  it("deduplicates replayed inbound text even when message ids differ", () => {
    const db = tempDb("inbound-duplicate-text");
    removeStateDbForTests(db);
    const store = new StateStore(db);
    const first = {
      message_id: 100,
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      message_type: 1,
      item_list: [{ type: 1, msg_id: "m100", text_item: { text: "这个消息重放层的bug需要被解决" } }],
    };
    const replay = {
      message_id: 101,
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      message_type: 1,
      item_list: [{ type: 1, msg_id: "m101", text_item: { text: "  这个消息重放层的bug需要被解决  " } }],
    };
    const otherSender = {
      ...replay,
      message_id: 102,
      from_user_id: "other@im.wechat",
      item_list: [{ type: 1, msg_id: "m102", text_item: { text: "这个消息重放层的bug需要被解决" } }],
    };

    store.enqueueInboundMessages([first]);
    store.markInboundProcessing("message:100");
    store.enqueueInboundMessages([replay, otherSender]);

    expect(store.pendingInboundMessages().map((record) => record.key)).toEqual(["message:100", "message:102"]);
    expect(store.getInboundMessage("message:101")).toBeNull();

    store.close();
    removeStateDbForTests(db);
  });

  it("claims inbound messages once until an in-flight processing lease is stale", () => {
    const db = tempDb("inbound-claim");
    removeStateDbForTests(db);
    const store = new StateStore(db);
    const message = {
      message_id: 200,
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      message_type: 1,
      item_list: [{ type: 1, msg_id: "m200", text_item: { text: "生成一页的 PDF 版并截图" } }],
    };

    store.enqueueInboundMessages([message]);
    const first = store.claimInboundMessage("message:200", Date.now() - 1000);
    expect(first?.attempts).toBe(1);
    expect(store.claimInboundMessage("message:200", Date.now() - 1000)).toBeNull();
    expect(store.claimableInboundMessages(100, Date.now() - 1000)).toHaveLength(0);

    const staleRetry = store.claimInboundMessage("message:200", Date.now() + 1000);
    expect(staleRetry?.attempts).toBe(2);

    store.markInboundProcessed("message:200");
    expect(store.claimInboundMessage("message:200", Date.now() + 1000)).toBeNull();

    store.close();
    removeStateDbForTests(db);
  });

  it("tracks active turns and clears expired locks", () => {
    const db = tempDb("active-turns");
    removeStateDbForTests(db);
    const store = new StateStore(db);
    const first = store.tryAcquireActiveTurn({
      threadId: "thread-1",
      senderId: "u@im.wechat",
      projectAlias: "p",
      prompt: "继续",
      expiresAt: Date.now() + 60_000,
    });

    expect(first.acquired).toBe(true);
    expect(store.getActiveTurn("thread-1")?.state).toBe("active");
    store.updateActiveTurnId("thread-1", "turn-1");
    expect(store.getLatestActiveTurnForSender("u@im.wechat")?.turnId).toBe("turn-1");

    const second = store.tryAcquireActiveTurn({
      threadId: "thread-1",
      senderId: "u@im.wechat",
      prompt: "hi",
      expiresAt: Date.now() + 60_000,
    });
    expect(second.acquired).toBe(false);
    expect(second.turn.turnId).toBe("turn-1");

    store.markActiveTurnStopping("thread-1");
    expect(store.getActiveTurn("thread-1")?.state).toBe("stopping");
    store.releaseActiveTurn("thread-1");
    expect(store.getActiveTurn("thread-1")).toBeNull();

    store.tryAcquireActiveTurn({
      threadId: "expired-thread",
      senderId: "u@im.wechat",
      prompt: "old",
      expiresAt: Date.now() - 1,
    });
    store.clearExpiredActiveTurns();
    expect(store.getActiveTurn("expired-thread")).toBeNull();

    store.close();
    removeStateDbForTests(db);
  });
});
