import { getProject, matchProjectByCwd, resolveUserPath } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { extractReferencedMessageKeys, extractReferencedNoticeIds, hasReferencedMessage, sendLongText, startTyping } from "./wechat.js";
import { extractLocalImagePaths, sendImage } from "./wechat-media.js";
import { StateStore } from "./state.js";
import { markdownToWechatText, summarize } from "./text.js";
import { errorText, warn } from "./log.js";
import path from "node:path";
import type { ApprovalCommandTarget } from "./approval.js";
import type { AccountData, AppConfig, AppServerTransportStatus, NoticeRecord, ProjectConfig, ThreadSummary, WechatContext, WechatMessage } from "./types.js";

export interface RouterDeps extends ApprovalCommandTarget {
  config: AppConfig;
  account: AccountData;
  state: StateStore;
  codex: CodexClient;
}

const HEARTBEAT_MESSAGES = [
  "我还在处理中，这个问题有点复杂，请再稍等一下。",
  "任务还在跑，进展正常，请再等一会儿。",
  "我还在处理，没有卡住，稍后会把结果发出来。",
  "这个任务比预期久一些，还在继续处理。",
  "还在跑，等完成后会直接把结果发到这里。",
];
const ACTIVE_TURN_NO_TIMEOUT_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_TURN_GRACE_MS = 60_000;

export async function handleWechatText(deps: RouterDeps, ctx: WechatContext): Promise<void> {
  deps.state.upsertContextToken(ctx.senderId, ctx.contextToken);
  if (!deps.state.isAllowed(ctx.senderId)) return;
  if (!isRemoteControlAllowed(deps, ctx.senderId)) {
    await reply(deps, ctx, "此安装默认只允许 owner 从微信远程控制 Codex。请在本机调整 wechatSecurity.ownerOnly 后再允许其他账号。");
    return;
  }
  const text = ctx.text.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    await handleCommand(deps, ctx, text);
    return;
  }
  const approvalAction = classifyApprovalReply(text);
  if (approvalAction && deps.approvals?.canResolveReply(ctx.senderId, ctx.message)) {
    const response =
      approvalAction === "approve" ? deps.approvals?.approve(ctx.senderId, undefined, ctx.message) : deps.approvals?.deny(ctx.senderId, undefined, ctx.message);
    await reply(deps, ctx, response || "当前 daemon 不支持微信审批。");
    return;
  }
  const referencedNotice = resolveReferencedNotice(deps, ctx.senderId, ctx.message);
  if (referencedNotice) {
    await continueResolvedThread(deps, ctx, referencedNotice.id, text);
    return;
  }
  if (hasReferencedMessage(ctx.message)) {
    await reply(deps, ctx, "引用的消息无法定位到 Codex 通知，已停止处理，避免跑错项目。请引用带项目标题/短码的 Codex 通知，或使用 /r <noticeId> <问题>。");
    return;
  }
  if (isKeepaliveRefreshText(text)) {
    await reply(deps, ctx, "已刷新微信通道，没有发送给 Codex。");
    return;
  }
  const activeTurn = deps.state.getLatestActiveTurnForSender(ctx.senderId);
  if (activeTurn) {
    await reply(deps, ctx, busyTurnText(activeTurn.state));
    return;
  }
  const chat = deps.state.getChat(ctx.senderId);
  if (chat.pendingNewProject) {
    const project = getProject(deps.config, chat.pendingNewProject);
    if (!project) {
      deps.state.patchChat(ctx.senderId, { pendingNewProject: undefined });
      await reply(deps, ctx, "待新建的项目别名已不存在，请用 /projects 查看可用项目。");
      return;
    }
    if (project.notifyOnly) {
      deps.state.patchChat(ctx.senderId, { pendingNewProject: undefined });
      await reply(deps, ctx, `项目 ${project.alias} 标记为仅通知，不允许从微信远程续写。`);
      return;
    }
    await createAndContinueThread(deps, ctx, project, text);
    return;
  }
  const lastNotice = chat.lastNoticeId ? deps.state.getNotice(chat.lastNoticeId, ctx.senderId) : null;
  if (lastNotice) {
    await continueResolvedThread(deps, ctx, lastNotice.id, text);
    return;
  }
  await reply(
    deps,
    ctx,
    "还没有可续写的最近 Codex 通知。请先引用一条完成通知，或使用 /r <noticeId|threadId|序号> <问题>；新任务用 /new <项目别名> <问题>。",
  );
}

async function handleCommand(deps: RouterDeps, ctx: WechatContext, text: string): Promise<void> {
  const [commandRaw, ...rest] = text.split(/\s+/);
  const command = commandRaw.toLowerCase();
  const tail = text.slice(commandRaw.length).trim();
  switch (command) {
    case "/help":
      return reply(deps, ctx, helpText());
    case "/approve": {
      const id = normalizeApprovalId(rest[0]);
      return reply(deps, ctx, deps.approvals?.approve(ctx.senderId, id || undefined, ctx.message) || "当前 daemon 不支持微信审批。");
    }
    case "/deny": {
      const id = normalizeApprovalId(rest[0]);
      return reply(deps, ctx, deps.approvals?.deny(ctx.senderId, id || undefined, ctx.message) || "当前 daemon 不支持微信审批。");
    }
    case "/approvals":
      return reply(deps, ctx, deps.approvals?.list(ctx.senderId) || "当前 daemon 不支持微信审批。");
    case "/projects":
      return reply(
        deps,
        ctx,
        deps.config.projects.length
          ? `项目：\n${deps.config.projects.map(formatProjectLine).join("\n")}`
          : "还没有项目别名。先在本机运行：codex-beeper project add <alias> <path>",
      );
    case "/p": {
      const alias = rest[0];
      const project = getProject(deps.config, alias);
      if (!project) return reply(deps, ctx, `未知项目别名：${alias || "(空)"}`);
      if (isArmNewThreadRequest(rest.slice(1))) return armNextNewThread(deps, ctx, project);
      deps.state.patchChat(ctx.senderId, { currentProject: project.alias, pendingNewProject: undefined });
      return reply(
        deps,
        ctx,
        `默认新建项目已切换为 ${project.alias}。普通文本会默认续写最近一条 Codex 通知；要在 ${project.alias} 新建任务，请发送 /new，或直接 /new ${project.alias} <问题>。`,
      );
    }
    case "/new":
      return newThread(deps, ctx, tail);
    case "/threads":
      return listThreads(deps, ctx, rest[0]);
    case "/show":
      return showNotice(deps, ctx, rest[0] || "last");
    case "/send":
      return sendLocalImage(deps, ctx, tail);
    case "/resume":
      return resumeThread(deps, ctx, rest[0]);
    case "/stop":
      return stopActiveTurn(deps, ctx, rest[0]);
    case "/r": {
      const target = rest[0];
      const query = tail.slice((target || "").length).trim();
      if (!target || !query) return reply(deps, ctx, "用法：/r <noticeId|threadId|序号> <问题>");
      return continueResolvedThread(deps, ctx, target, query);
    }
    case "/mute":
      deps.state.patchChat(ctx.senderId, { muted: true });
      return reply(deps, ctx, "已静音完成通知。你仍可用 /show last 查看最近通知。");
    case "/unmute":
      deps.state.patchChat(ctx.senderId, { muted: false });
      return reply(deps, ctx, "已恢复完成通知。");
    case "/notify":
      return reply(deps, ctx, `通知状态：${deps.state.getChat(ctx.senderId).muted ? "muted" : "on"}，阈值 ${deps.config.notificationThresholdSeconds}s。`);
    default:
      return reply(deps, ctx, "未知命令。发送 /help 查看可用命令。");
  }
}

async function newThread(deps: RouterDeps, ctx: WechatContext, tail: string): Promise<void> {
  const parts = tail.split(/\s+/).filter(Boolean);
  const first = parts[0];
  let project = getProject(deps.config, first);
  let prompt = project ? tail.slice(first.length).trim() : tail;
  if (!project) {
    const chat = deps.state.getChat(ctx.senderId);
    project = getProject(deps.config, chat.currentProject);
  }
  if (!project) return reply(deps, ctx, "请指定项目别名：/new <alias> <问题>");
  if (project.notifyOnly) return reply(deps, ctx, `项目 ${project.alias} 标记为仅通知，不允许从微信远程续写。`);
  if (!prompt) {
    return armNextNewThread(deps, ctx, project);
  }
  await createAndContinueThread(deps, ctx, project, prompt);
}

async function armNextNewThread(deps: RouterDeps, ctx: WechatContext, project: ProjectConfig): Promise<void> {
  if (project.notifyOnly) return reply(deps, ctx, `项目 ${project.alias} 标记为仅通知，不允许从微信远程续写。`);
  deps.state.patchChat(ctx.senderId, { currentProject: project.alias, pendingNewProject: project.alias });
  return reply(deps, ctx, `下一条消息会在项目 ${project.alias} 中新建 Codex thread。`);
}

function isArmNewThreadRequest(tokens: string[]): boolean {
  return tokens.some((token) => ["/new", "new"].includes(token.toLowerCase()));
}

async function createAndContinueThread(deps: RouterDeps, ctx: WechatContext, project: ProjectConfig, prompt: string): Promise<void> {
  const threadId = await deps.codex.startThread(project.path);
  try {
    await continueThread(deps, ctx, project, threadId, prompt, { resumeFirst: false });
  } catch (error) {
    if (isMissingRolloutError(error)) {
      deps.state.patchChat(ctx.senderId, { currentProject: project.alias, currentThread: undefined, pendingNewProject: undefined });
      await replyMissingRollout(deps, ctx, threadId, error, project);
      return;
    }
    throw error;
  }
}

async function listThreads(deps: RouterDeps, ctx: WechatContext, alias?: string): Promise<void> {
  const project = getProject(deps.config, alias) || getProject(deps.config, deps.state.getChat(ctx.senderId).currentProject);
  const threads = await deps.codex.listThreads(project?.path, 10);
  deps.state.saveRecentThreads(ctx.senderId, threads);
  if (!threads.length) return reply(deps, ctx, "没有找到最近 thread。");
  const lines = threads.map((thread, index) => `${index + 1}. ${thread.name || thread.preview || thread.id}\n   ${thread.id}`);
  await reply(deps, ctx, `最近 thread：\n${lines.join("\n")}\n\n用 /resume <序号> 绑定。`);
}

async function showNotice(deps: RouterDeps, ctx: WechatContext, id: string): Promise<void> {
  const notice = deps.state.getNotice(id, ctx.senderId);
  if (!notice) return reply(deps, ctx, `找不到通知：${id}`);
  await reply(deps, ctx, notice.body || notice.summary);
  await sendMentionedImages(deps, ctx.senderId, ctx.contextToken, notice.body || notice.summary, notice.cwd);
}

async function sendLocalImage(deps: RouterDeps, ctx: WechatContext, tail: string): Promise<void> {
  if (!tail) return reply(deps, ctx, "用法：/send <图片路径>");
  const project = getProject(deps.config, deps.state.getChat(ctx.senderId).currentProject);
  const filePath = resolveImagePath(tail, project?.path);
  if (!deps.config.wechatSecurity.allowLocalImageSend) {
    return reply(deps, ctx, "本机图片发送当前已关闭。请在 ~/.codex-wechat/config.json 中设置 wechatSecurity.allowLocalImageSend=true。");
  }
  if (!isAllowedLocalMediaPath(deps.config, filePath, project?.path)) {
    return reply(deps, ctx, "图片路径不在当前项目目录或 wechatSecurity.allowedMediaRoots 中，已拒绝发送。");
  }
  try {
    await sendImage(deps.config, deps.account, ctx.senderId, filePath, ctx.contextToken);
  } catch (error) {
    await reply(deps, ctx, `图片发送失败：${errorText(error)}`);
  }
}

async function resumeThread(deps: RouterDeps, ctx: WechatContext, target?: string): Promise<void> {
  if (!target) return reply(deps, ctx, "用法：/resume <noticeId|threadId|序号>");
  const resolved = resolveThread(deps, ctx.senderId, target);
  if (!resolved.threadId) return reply(deps, ctx, `无法解析 thread：${target}`);
  try {
    await deps.codex.resumeThread(resolved.threadId, resolved.project?.path);
  } catch (error) {
    if (isMissingRolloutError(error)) {
      await replyMissingRollout(deps, ctx, resolved.threadId, error);
      return;
    }
    throw error;
  }
  deps.state.patchChat(ctx.senderId, {
    currentThread: resolved.threadId,
    currentProject: resolved.project?.alias || deps.state.getChat(ctx.senderId).currentProject,
  });
  await reply(deps, ctx, `已绑定 thread：${resolved.threadId}。续写请使用 /r <noticeId|threadId|序号> <问题>，或引用完成通知直接回复。${formatDesktopLiveUpdateNote(deps.codex.transportStatus())}`);
}

async function stopActiveTurn(deps: RouterDeps, ctx: WechatContext, target?: string): Promise<void> {
  let active = target ? null : deps.state.getLatestActiveTurnForSender(ctx.senderId);
  if (target) {
    const resolved = resolveThread(deps, ctx.senderId, target);
    if (!resolved.threadId) {
      await reply(deps, ctx, `无法解析 thread：${target}`);
      return;
    }
    active = deps.state.getActiveTurn(resolved.threadId);
  }
  if (!active) {
    await reply(deps, ctx, "当前没有正在跑的任务。");
    return;
  }
  if (active.state === "stopping") {
    await reply(deps, ctx, "当前任务正在停止中，请稍等完成通知或错误提示。");
    return;
  }
  if (!active.turnId) {
    await reply(deps, ctx, "当前任务正在启动，还没有可停止的 turn id。请稍后再发送 /stop。");
    return;
  }
  try {
    await deps.codex.interruptTurn(active.threadId, active.turnId);
    deps.state.markActiveTurnStopping(active.threadId);
    await reply(deps, ctx, `已发送停止请求：${shortThreadId(active.threadId)}。`);
  } catch (error) {
    await reply(deps, ctx, `停止请求失败：${errorText(error)}`);
  }
}

async function continueResolvedThread(deps: RouterDeps, ctx: WechatContext, target: string, prompt: string): Promise<void> {
  const resolved = resolveThread(deps, ctx.senderId, target);
  if (!resolved.threadId) return reply(deps, ctx, `无法解析 thread：${target}`);
  if (resolved.project?.notifyOnly) return reply(deps, ctx, `项目 ${resolved.project.alias} 标记为仅通知，不允许从微信远程续写。`);
  try {
    await continueThread(deps, ctx, resolved.project, resolved.threadId, prompt);
  } catch (error) {
    if (isMissingRolloutError(error)) {
      await replyMissingRollout(deps, ctx, resolved.threadId, error);
      return;
    }
    throw error;
  }
}

async function continueThread(
  deps: RouterDeps,
  ctx: WechatContext,
  project: ProjectConfig | undefined,
  threadId: string,
  prompt: string,
  options: { resumeFirst?: boolean } = {},
): Promise<void> {
  const lock = deps.state.tryAcquireActiveTurn({
    threadId,
    senderId: ctx.senderId,
    projectAlias: project?.alias,
    prompt,
    expiresAt: activeTurnExpiresAt(deps.config.codexTurnTimeoutMs),
  });
  if (!lock.acquired) {
    await reply(deps, ctx, busyTurnText(lock.turn.state));
    return;
  }
  deps.state.patchChat(ctx.senderId, { currentThread: threadId, currentProject: project?.alias, pendingNewProject: undefined });

  const progress = startWechatProgress(deps, ctx);
  let result;
  try {
    if (options.resumeFirst !== false) await deps.codex.resumeThread(threadId, project?.path);
    deps.state.recordSelfTurn(threadId, prompt);
    result = await deps.codex.runTurn({
      threadId,
      prompt,
      cwd: project?.path,
      timeoutMs: deps.config.codexTurnTimeoutMs,
      onTurnId: (turnId) => {
        deps.state.updateActiveTurnId(threadId, turnId);
        deps.state.recordSelfTurn(threadId, prompt, turnId);
      },
    });
  } finally {
    progress.stop();
    deps.state.releaseActiveTurn(threadId);
  }
  deps.state.recordSelfTurn(threadId, prompt, result.turnId, result.text);
  deps.state.patchChat(ctx.senderId, { currentThread: threadId, currentProject: project?.alias, pendingNewProject: undefined });
  const approvalNote = result.deniedRequests
    ? "\n\n注意：本轮有用户确认请求被拒绝或超时，相关操作没有执行。"
    : "";
  const body = `${result.text || "(Codex 未返回文本)"}${approvalNote}${formatDesktopLiveUpdateNote(deps.codex.transportStatus())}`;
  const notice = deps.state.createNotice({
    sessionId: threadId,
    threadId,
    turnId: result.turnId,
    cwd: project?.path,
    projectAlias: project?.alias,
    title: project?.alias ? `${project.alias} 出话完成` : "Codex 出话完成",
    summary: summarize(body),
    body,
    createdAt: Date.now(),
    source: "wechat",
  });
  deps.state.patchChat(ctx.senderId, { lastNoticeId: notice.id });
  await replyNotice(deps, ctx, notice);
}

function startWechatProgress(deps: RouterDeps, ctx: WechatContext): { stop: () => void } {
  const stopTyping = startTyping(deps.config, deps.account, ctx.senderId, ctx.contextToken);
  const heartbeatAfterMs = deps.config.wechatProgress.heartbeatAfterMs;
  if (heartbeatAfterMs <= 0) return { stop: stopTyping };

  let stopped = false;
  let heartbeatInFlight = false;
  let lastSentAt = Date.now();
  const checkEveryMs = Math.max(2000, Math.min(30_000, Math.floor(heartbeatAfterMs / 10)));
  const timer = setInterval(() => {
    if (stopped || heartbeatInFlight || Date.now() - lastSentAt < heartbeatAfterMs) return;
    heartbeatInFlight = true;
    const message = HEARTBEAT_MESSAGES[Math.floor(Math.random() * HEARTBEAT_MESSAGES.length)];
    void sendLongText(deps.config, deps.account, ctx.senderId, message, ctx.contextToken)
      .then(() => {
        lastSentAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, checkEveryMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stopTyping();
    },
  };
}

function isKeepaliveRefreshText(text: string): boolean {
  return text.trim() === "1";
}

function activeTurnExpiresAt(timeoutMs: number): number {
  const ttl = timeoutMs > 0 ? timeoutMs + ACTIVE_TURN_GRACE_MS : ACTIVE_TURN_NO_TIMEOUT_TTL_MS;
  return Date.now() + ttl;
}

function busyTurnText(state: "active" | "stopping"): string {
  if (state === "stopping") return "当前任务正在停止中，本条没有发送给 Codex。请等待完成通知或错误提示。";
  return "当前任务还在跑，本条没有发送给 Codex。可发送 /stop 停止当前任务，或等待完成后再继续。";
}

function resolveThread(deps: RouterDeps, senderId: string, target: string): { threadId?: string; project?: ProjectConfig; notice?: NoticeRecord } {
  const notice = deps.state.getNotice(target, senderId);
  if (notice?.threadId || notice?.sessionId) {
    return {
      threadId: notice.threadId || notice.sessionId,
      project: getProject(deps.config, notice.projectAlias) || matchProjectByCwd(deps.config, notice.cwd),
      notice,
    };
  }
  if (/^\d+$/.test(target)) {
    const thread = deps.state.getRecentThreadByIndex(senderId, Number(target));
    return { threadId: thread?.id, project: thread?.cwd ? matchProjectByCwd(deps.config, thread.cwd) : undefined };
  }
  return { threadId: target, project: getProject(deps.config, deps.state.getChat(senderId).currentProject) };
}

function isMissingRolloutError(error: unknown): boolean {
  return /no rollout found for thread id/i.test(errorText(error));
}

async function replyMissingRollout(deps: RouterDeps, ctx: WechatContext, attemptedThreadId: string, error: unknown, newThreadProject?: ProjectConfig): Promise<void> {
  const text = errorText(error);
  const missingThreadId = text.match(/no rollout found for thread id ([0-9a-f-]+)/i)?.[1] || attemptedThreadId;
  const chat = deps.state.getChat(ctx.senderId);
  if (chat.currentThread === attemptedThreadId || chat.currentThread === missingThreadId) {
    deps.state.patchChat(ctx.senderId, { currentThread: undefined, pendingNewProject: undefined });
  }
  const lastNotice = chat.lastNoticeId ? deps.state.getNotice(chat.lastNoticeId, ctx.senderId) : null;
  const retryHint = lastNotice
    ? `最近可用通知是 ${lastNotice.id}，请发送：/r ${lastNotice.id} <问题>，或直接引用那条完成通知回复。`
    : "请引用一条 Codex 完成通知回复；如果是新任务，请使用 /new <项目别名> <问题>。";
  if (newThreadProject) {
    await reply(
      deps,
      ctx,
      `新建 Codex thread 首轮启动失败，当前 app-server 找不到刚创建的 rollout（${shortThreadId(missingThreadId)}），本次没有继续执行。请重试：/new ${newThreadProject.alias} <问题>。`,
    );
    return;
  }
  await reply(
    deps,
    ctx,
    `这个 Codex thread 已失效，当前 app-server 找不到对应 rollout（${shortThreadId(missingThreadId)}），本次没有继续执行。${retryHint}`,
  );
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}...${threadId.slice(-4)}` : threadId;
}

export function resolveReferencedNotice(deps: Pick<RouterDeps, "state">, senderId: string, message?: WechatMessage): NoticeRecord | null {
  if (!message) return null;
  for (const key of extractReferencedMessageKeys(message)) {
    const noticeId = deps.state.getNoticeIdByOutboundMessageKey(senderId, key);
    const notice = noticeId ? deps.state.getNotice(noticeId, senderId) : null;
    if (notice) return notice;
  }
  for (const noticeId of extractReferencedNoticeIds(message)) {
    const notice = deps.state.getNotice(noticeId, senderId);
    if (notice) return notice;
  }
  return null;
}

async function reply(deps: RouterDeps, ctx: WechatContext, text: string): Promise<void> {
  await sendLongText(deps.config, deps.account, ctx.senderId, markdownToWechatText(text), ctx.contextToken);
}

async function replyNotice(deps: RouterDeps, ctx: WechatContext, notice: NoticeRecord): Promise<void> {
  const sent = await sendLongText(deps.config, deps.account, ctx.senderId, formatNoticeSummary(notice), ctx.contextToken, {
    messageIdPrefix: `notice:${notice.id}`,
    continuationPrefix: formatNoticeContinuationPrefix(notice),
  });
  for (const message of sent) {
    deps.state.recordOutboundNoticeMessage(ctx.senderId, notice.id, [`client:${message.clientId}`, `item:${message.itemMsgId}`]);
  }
  deps.state.markNoticeDelivered(notice.id);
  await sendMentionedImages(deps, ctx.senderId, ctx.contextToken, notice.body || notice.summary, notice.cwd);
}

export function formatNoticeSummary(notice: NoticeRecord, options: { redelivery?: boolean } = {}): string {
  const project = notice.projectAlias || projectNameFromCwd(notice.cwd);
  const prefix = options.redelivery ? "【补发】" : "";
  const title = project ? `${prefix}${project}项目（${notice.id}）已出话：` : `${prefix}Codex（${notice.id}）已出话：`;
  const body = markdownToWechatText(notice.body || notice.summary || "(Codex 未返回正文)");
  return `${title}\n${body}`;
}

export function formatNoticeContinuationPrefix(notice: NoticeRecord): string {
  const project = notice.projectAlias || projectNameFromCwd(notice.cwd) || "Codex";
  return `续 ${project}项目（${notice.id}）：`;
}

export function formatDesktopLiveUpdateNote(status: AppServerTransportStatus): string {
  return status.liveDesktopUpdates ? "" : "\n\n提示：微信追问/回复的内容，需要重开 Codex Desktop 才能刷新。";
}

function projectNameFromCwd(cwd?: string): string {
  if (!cwd) return "";
  const normalized = cwd.replace(/\/+$/, "");
  const name = normalized.split("/").filter(Boolean).pop();
  return name || "";
}

function formatProjectLine(project: ProjectConfig): string {
  const source = project.source === "auto" ? "自动" : "手动";
  const suffix = project.notifyOnly ? "，仅通知" : "";
  return `- ${project.alias} (${source}${suffix}): ${project.path}`;
}

function helpText(): string {
  return [
    "/projects - 列出项目别名",
    "/p <alias> - 设置 /new 默认项目",
    "/p <alias> /new - 设置默认项目，并让下一条普通消息新建 Codex thread",
    "/new <alias> <问题> - 新建 Codex thread",
    "/new - 下一条普通消息新建 Codex thread",
    "/threads [alias] - 列出最近 thread",
    "/resume <noticeId|threadId|序号> - 绑定或打开 thread",
    "/stop [noticeId|threadId|序号] - 停止当前正在跑的微信任务",
    "/show <noticeId|last> - 展开完成通知",
    "/send <图片路径> - 发送本机图片到微信",
    "/r <noticeId|threadId|序号> <问题> - 继续指定 thread",
    "普通文本默认续写最近一条 Codex 完成通知；如有消息堆积，请引用完成通知或使用 /r <noticeId> <问题>。",
    "/approve [审批码] - 批准 Codex 用户确认请求",
    "/deny [审批码] - 拒绝 Codex 用户确认请求",
    "/approvals - 查看待审批请求",
    "/mute / /unmute - 静音或恢复完成通知",
    "/notify status - 查看通知状态",
  ].join("\n");
}

function normalizeApprovalId(value?: string): string {
  return (value || "").trim().toLowerCase();
}

export function classifyApprovalReply(text: string): "approve" | "deny" | null {
  const normalized = text.trim().toLowerCase();
  if (/^(同意|批准|允许|approve|approved|yes|y)$/i.test(normalized)) return "approve";
  if (/^(拒绝|不同意|不批准|不允许|deny|denied|no|n)$/i.test(normalized)) return "deny";
  return null;
}

export async function sendMentionedImages(deps: Pick<RouterDeps, "config" | "account">, senderId: string, contextToken: string, text: string, cwd?: string): Promise<void> {
  if (!deps.config.wechatSecurity.autoSendLocalImages) return;
  for (const imagePath of extractLocalImagePaths(text, cwd)) {
    if (!isAllowedLocalMediaPath(deps.config, imagePath, cwd)) continue;
    try {
      await sendImage(deps.config, deps.account, senderId, imagePath, contextToken);
    } catch (error) {
      warn(`failed to send image ${imagePath}: ${errorText(error)}`);
    }
  }
}

function resolveImagePath(input: string, cwd?: string): string {
  const trimmed = input.trim().replace(/^file:\/\//, "");
  if (trimmed.startsWith("~/")) return path.join(process.env.HOME || "", trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return trimmed;
  if (cwd) return path.resolve(cwd, trimmed);
  return path.resolve(trimmed);
}

function isRemoteControlAllowed(deps: Pick<RouterDeps, "config" | "state">, senderId: string): boolean {
  if (!deps.config.wechatSecurity.ownerOnly) return true;
  const owner = deps.config.ownerSenderId || deps.state.ownerSenderId();
  return !owner || senderId === owner;
}

function isAllowedLocalMediaPath(config: AppConfig, filePath: string, cwd?: string): boolean {
  const resolved = path.resolve(filePath);
  const roots = [
    ...(cwd ? [cwd] : []),
    ...config.wechatSecurity.allowedMediaRoots.map(resolveUserPath),
  ];
  return roots.some((root) => isPathInside(resolved, root));
}

function isPathInside(filePath: string, root: string): boolean {
  const normalizedFile = path.resolve(filePath);
  const normalizedRoot = path.resolve(root);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${path.sep}`);
}
