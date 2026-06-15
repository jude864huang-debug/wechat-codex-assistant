import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, matchProjectByCwd } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { errorText, log, warn } from "./log.js";
import { statePath } from "./paths.js";
import { inboundMessageKey, StateStore } from "./state.js";
import { classifyApprovalReply, formatNoticeContinuationPrefix, formatNoticeSummary, handleWechatText, sendMentionedImages } from "./router.js";
import { writeDaemonHeartbeat, type DaemonHeartbeat } from "./health.js";
import { startHookServer } from "./hook.js";
import { clearLocalContextTokenStaleNotification, notifyLocalContextTokenStale } from "./local-notify.js";
import { extractText, isWechatContextTokenStaleError, loadAccount, monitorWechat, sendLongText } from "./wechat.js";
import { summarize } from "./text.js";
import { WechatApprovalBroker } from "./approval.js";
import type { HookPayload, NoticeRecord, WechatMessage } from "./types.js";

export async function startDaemon(): Promise<void> {
  const lock = acquireLock();
  const config = loadConfig();
  const loadedAccount = loadAccount();
  if (!loadedAccount) throw new Error("未找到微信登录信息，请先运行 setup。");
  const account = loadedAccount;
  const state = new StateStore();
  const approvals = new WechatApprovalBroker(config, account, state);
  const codex = new CodexClient(config);
  codex.setServerRequestHandler((request) => approvals.request(request));
  await codex.start();
  const startedAt = Date.now();
  let heartbeat: DaemonHeartbeat = { pid: process.pid, startedAt, updatedAt: startedAt };
  const touchHeartbeat = (patch: Partial<DaemonHeartbeat> = {}) => {
    heartbeat = { ...heartbeat, ...patch, pid: process.pid, startedAt, updatedAt: Date.now() };
    writeDaemonHeartbeat(heartbeat);
  };
  touchHeartbeat();
  const heartbeatTimer = setInterval(() => touchHeartbeat(), 30_000);
  heartbeatTimer.unref?.();

  async function processHook(payload: HookPayload): Promise<void> {
    touchHeartbeat({ lastHookPayloadAt: Date.now() });
    const body = String(payload.last_assistant_message || "");
    const sessionId = String(payload.session_id || payload.thread_id || "");
    if (!sessionId || !body) return;
    const threadIdFromPayload = payload.thread_id ? String(payload.thread_id) : "";
    if ([sessionId, threadIdFromPayload].filter(Boolean).some((id) => state.isSelfTurn(id, payload.turn_id, body))) return;
    const durationMs = durationFromPayload(payload);
    if (durationMs != null && durationMs < config.notificationThresholdSeconds * 1000) return;
    const project = matchProjectByCwd(config, payload.cwd);
    const notice = state.createNotice({
      sessionId,
      threadId: payload.thread_id ? String(payload.thread_id) : sessionId,
      turnId: payload.turn_id ? String(payload.turn_id) : undefined,
      cwd: payload.cwd ? String(payload.cwd) : undefined,
      projectAlias: project?.alias,
      title: project?.alias ? `${project.alias} 出话完成` : "Codex 出话完成",
      summary: summarize(body),
      body,
      createdAt: Date.now(),
      durationMs: durationMs || undefined,
      source: "hook",
    });
    try {
      await deliverNotice(state, config, account, notice);
      touchHeartbeat({ lastNoticeDeliveredAt: Date.now() });
    } catch (error) {
      touchHeartbeat({ lastNoticeErrorAt: Date.now() });
      warn(`failed to deliver hook notice ${notice.id}: ${errorText(error)}`);
    }
  }

  startHookServer(processHook);
  for (const queued of state.pendingHooks()) {
    try {
      await processHook(queued.payload);
      state.markHookDelivered(queued.id);
    } catch (error) {
      warn(`failed to restore queued hook ${queued.id}: ${errorText(error)}`);
    }
  }

  const messageQueues = new Map<string, Promise<void>>();
  const activeInboundMessages = new Set<string>();
  const inboundProcessingLeaseMs = config.codexTurnTimeoutMs > 0 ? config.codexTurnTimeoutMs + 60_000 : 24 * 60 * 60 * 1000;
  const staleInboundProcessingBefore = () => Date.now() - inboundProcessingLeaseMs;
  const processWechatMessage = async (message: WechatMessage) => {
    const text = extractText(message);
    const senderId = message.from_user_id;
    const contextToken = message.context_token || "";
    try {
      if (contextToken) {
        touchHeartbeat({ lastWechatMessageAt: Date.now() });
        state.upsertContextToken(senderId, contextToken);
        clearLocalContextTokenStaleNotification();
      }
      if (!text || !contextToken) return;
      await handleWechatText({ config, account, state, codex, approvals }, { senderId, contextToken, text, message });
    } catch (error) {
      warn(`WeChat message handling failed: ${errorText(error)}`);
      if (contextToken && state.isAllowed(senderId)) {
        try {
          await sendLongText(config, account, senderId, `消息处理失败：${errorText(error)}`, contextToken);
        } catch (sendError) {
          warn(`failed to send WeChat error reply: ${errorText(sendError)}`);
          if (isWechatContextTokenStaleError(sendError)) {
            state.markContextTokenStale(senderId, "sendmessage returned ret=-2; send any message to ClawBot/iLink to refresh context_token");
            notifyLocalContextTokenStale();
          }
        }
      }
    }
  };

  const processInboundMessage = async (key: string) => {
    if (activeInboundMessages.has(key)) return;
    const record = state.claimInboundMessage(key, staleInboundProcessingBefore());
    if (!record) return;
    activeInboundMessages.add(key);
    try {
      await processWechatMessage(record.message);
      state.markInboundProcessed(key);
    } catch (error) {
      state.markInboundFailed(key, errorText(error));
      throw error;
    } finally {
      activeInboundMessages.delete(key);
    }
  };

  const scheduleInboundMessage = (key: string) => {
    const record = state.getInboundMessage(key);
    if (!record) return;
    const message = record.message;
    const text = extractText(message);
    const senderId = message.from_user_id;
    const contextToken = message.context_token || "";
    if (contextToken) {
      state.upsertContextToken(senderId, contextToken);
      clearLocalContextTokenStaleNotification();
      if (senderId === (config.ownerSenderId || state.ownerSenderId())) {
        void retryUndeliveredNotices(state, config, account).catch((error) => warn(`retry undelivered notices failed: ${errorText(error)}`));
      }
    }
    if (text && contextToken && isImmediateApprovalMessage(text, senderId, message, approvals)) {
      void processInboundMessage(key).catch((error) => warn(`immediate inbound message failed: ${errorText(error)}`));
      return;
    }
    if (text && contextToken && state.getLatestActiveTurnForSender(senderId)) {
      void processInboundMessage(key).catch((error) => warn(`active-turn inbound message failed: ${errorText(error)}`));
      return;
    }
    const previous = messageQueues.get(senderId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => processInboundMessage(key));
    messageQueues.set(senderId, next);
    void next.finally(() => {
      if (messageQueues.get(senderId) === next) messageQueues.delete(senderId);
    });
  };

  for (const record of state.claimableInboundMessages(100, staleInboundProcessingBefore())) {
    scheduleInboundMessage(record.key);
  }

  await monitorWechat(config, account, async (message) => {
    scheduleInboundMessage(inboundMessageKey(message));
  }, {
    onMessagesReceived: (messages) => {
      state.enqueueInboundMessages(messages);
    },
    onPollSuccess: () => touchHeartbeat({ lastWechatPollAt: Date.now() }),
    onPollError: () => touchHeartbeat({ lastWechatPollErrorAt: Date.now() }),
  });

  clearInterval(heartbeatTimer);
  lock.close();
}

async function retryUndeliveredNotices(
  state: StateStore,
  config: ReturnType<typeof loadConfig>,
  account: NonNullable<ReturnType<typeof loadAccount>>,
): Promise<void> {
  const owner = config.ownerSenderId || state.ownerSenderId();
  if (!owner) return;
  const notices = state.pendingUndeliveredNotices(20);
  for (const notice of notices) {
    try {
      await deliverNotice(state, config, account, notice, { redelivery: true });
    } catch (error) {
      warn(`failed to retry notice ${notice.id}: ${errorText(error)}`);
      if (isWechatContextTokenStaleError(error)) return;
    }
  }
}

function isImmediateApprovalMessage(text: string, senderId: string, message: WechatMessage, approvals: WechatApprovalBroker): boolean {
  const trimmed = text.trim();
  return /^\/(?:approve|deny|approvals)\b/i.test(trimmed) || (Boolean(classifyApprovalReply(trimmed)) && approvals.canResolveReply(senderId, message));
}

async function deliverNotice(
  state: StateStore,
  config: ReturnType<typeof loadConfig>,
  account: NonNullable<ReturnType<typeof loadAccount>>,
  notice: NoticeRecord,
  options: { redelivery?: boolean } = {},
): Promise<void> {
  const owner = config.ownerSenderId || state.ownerSenderId();
  if (!owner) return;
  const chat = state.getChat(owner);
  state.patchChat(owner, { lastNoticeId: notice.id });
  if (chat.muted) return;
  const token = state.getContextToken(owner);
  if (!token) return;
  try {
    const sent = await sendLongText(config, account, owner, formatNoticeSummary(notice, options), token, {
      messageIdPrefix: `notice:${notice.id}`,
      continuationPrefix: formatNoticeContinuationPrefix(notice),
    });
    for (const message of sent) {
      state.recordOutboundNoticeMessage(owner, notice.id, [`client:${message.clientId}`, `item:${message.itemMsgId}`]);
    }
    state.markNoticeDelivered(notice.id);
    await sendMentionedImages({ config, account }, owner, token, notice.body || notice.summary, notice.cwd);
  } catch (error) {
    if (isWechatContextTokenStaleError(error)) {
      state.markContextTokenStale(owner, "sendmessage returned ret=-2; send any message to ClawBot/iLink to refresh context_token");
      notifyLocalContextTokenStale();
    }
    throw error;
  }
}

function durationFromPayload(payload: HookPayload): number | null {
  if (typeof payload.started_at_ms === "number" && typeof payload.completed_at_ms === "number") return payload.completed_at_ms - payload.started_at_ms;
  return null;
}

function acquireLock(): { close: () => void } {
  const file = statePath("daemon.lock");
  cleanupStaleLock(file);
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, `${process.pid}\n`);
    const release = () => {
      try {
        fs.closeSync(fd);
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
    };
    process.on("exit", release);
    return { close: release };
  } catch {
    throw new Error(`daemon already appears to be running (${file})`);
  }
}

function cleanupStaleLock(file: string): void {
  if (!fs.existsSync(file)) return;
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      // stale lock
    }
  }
  fs.rmSync(file, { force: true });
}

export async function retryForever(fn: () => Promise<void>): Promise<void> {
  for (;;) {
    try {
      await fn();
      return;
    } catch (error) {
      warn(`daemon crashed: ${errorText(error)}`);
      await delay(5000);
    }
  }
}
