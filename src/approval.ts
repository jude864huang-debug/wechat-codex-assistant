import crypto from "node:crypto";
import { approvalForMethod, denialForMethod, fallbackForMethod, isWechatApprovableMethod } from "./codex-client.js";
import { notifyLocalContextTokenStale } from "./local-notify.js";
import { errorText, warn } from "./log.js";
import { extractReferencedApprovalIds, extractReferencedMessageKeys, isWechatContextTokenStaleError, sendLongText } from "./wechat.js";
import type { AccountData, AppConfig, WechatMessage } from "./types.js";
import type { StateStore } from "./state.js";

interface PendingApproval {
  id: string;
  method: string;
  params: any;
  senderId: string;
  resolve: (result: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
  messageKeys: string[];
}

export class WechatApprovalBroker {
  private pending = new Map<string, PendingApproval>();
  private messageIndex = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly account: AccountData,
    private readonly state: StateStore,
  ) {}

  async request(input: { method: string; params: any }): Promise<unknown> {
    if (!isWechatApprovableMethod(input.method)) return fallbackForMethod(input.method);
    if (!this.config.wechatApproval.enabled) return denialForMethod(input.method);
    const owner = this.config.ownerSenderId || this.state.ownerSenderId();
    const token = owner ? this.state.getContextToken(owner) : null;
    if (!owner || !token) return denialForMethod(input.method);

    const id = this.nextId();
    const prompt = formatApprovalPrompt(id, input.method, input.params);
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, false);
        void sendLongText(this.config, this.account, owner, `审批 ${id} 已超时，已自动拒绝。`, token).catch((error) => {
          this.markStaleIfNeeded(owner, error, "sendmessage returned ret=-2 while sending approval timeout notice");
        });
      }, this.config.wechatApproval.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { id, method: input.method, params: input.params, senderId: owner, resolve, timer, createdAt: Date.now(), messageKeys: [] });
      void sendLongText(this.config, this.account, owner, prompt, token, { messageIdPrefix: `approval:${id}` })
        .then((sent) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          const keys = sent.flatMap((message) => [`client:${message.clientId}`, `item:${message.itemMsgId}`]);
          pending.messageKeys = keys;
          for (const key of keys) this.messageIndex.set(messageIndexKey(owner, key), id);
        })
        .catch((error) => {
          this.markStaleIfNeeded(owner, error, "sendmessage returned ret=-2 while sending approval request");
          warn(`failed to send approval request: ${errorText(error)}`);
          this.finish(id, false);
        });
    });
  }

  approve(senderId: string, id?: string, message?: WechatMessage): string {
    const resolved = this.resolveApproval(senderId, id, message);
    if (!resolved.id) return resolved.error;
    this.finish(resolved.id, true);
    return `已批准：${resolved.id}`;
  }

  deny(senderId: string, id?: string, message?: WechatMessage): string {
    const resolved = this.resolveApproval(senderId, id, message);
    if (!resolved.id) return resolved.error;
    this.finish(resolved.id, false);
    return `已拒绝：${resolved.id}`;
  }

  list(senderId: string): string {
    const rows = [...this.pending.values()].filter((item) => item.senderId === senderId);
    if (!rows.length) return "当前没有待审批请求。";
    return rows.map((item) => `${item.id} ${friendlyMethod(item.method)} ${shorten(primaryRequestLine(item.method, item.params), 80)}`).join("\n");
  }

  canResolveReply(senderId: string, message?: WechatMessage): boolean {
    if (message && hasReferencedApproval(message)) return true;
    return [...this.pending.values()].filter((item) => item.senderId === senderId).length === 1;
  }

  private finish(id: string, approved: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    for (const key of pending.messageKeys) this.messageIndex.delete(messageIndexKey(pending.senderId, key));
    pending.resolve(approved ? approvalForMethod(pending.method, pending.params) : denialForMethod(pending.method));
  }

  private resolveApproval(senderId: string, id?: string, message?: WechatMessage): { id?: string; error: string } {
    const normalizedId = normalizeId(id);
    if (normalizedId) return this.resolveExplicitId(senderId, normalizedId);

    if (message) {
      for (const key of extractReferencedMessageKeys(message)) {
        const approvalId = this.messageIndex.get(messageIndexKey(senderId, key)) || approvalIdFromMessageKey(key);
        if (approvalId) return this.resolveExplicitId(senderId, approvalId);
      }
      for (const approvalId of extractReferencedApprovalIds(message)) {
        const resolved = this.resolveExplicitId(senderId, approvalId);
        if (resolved.id) return resolved;
      }
    }

    const rows = [...this.pending.values()].filter((item) => item.senderId === senderId);
    if (!rows.length) return { error: "当前没有待审批请求。" };
    if (rows.length === 1) return { id: rows[0].id, error: "" };
    return { error: `当前有 ${rows.length} 个待审批请求。请引用对应审批消息回复，或使用 /approve <审批码> / /deny <审批码>。` };
  }

  private resolveExplicitId(senderId: string, id: string): { id?: string; error: string } {
    const pending = this.pending.get(id);
    if (!pending) return { error: `找不到待审批请求：${id}` };
    if (pending.senderId !== senderId) return { error: `你不能审批这个请求：${id}` };
    return { id, error: "" };
  }

  private nextId(): string {
    let id = crypto.randomBytes(3).toString("hex");
    while (this.pending.has(id)) id = crypto.randomBytes(3).toString("hex");
    return id;
  }

  private markStaleIfNeeded(owner: string, error: unknown, reason: string): void {
    if (!isWechatContextTokenStaleError(error)) return;
    this.state.markContextTokenStale(owner, `${reason}; send any message to ClawBot/iLink to refresh context_token`);
    notifyLocalContextTokenStale();
  }
}

export interface ApprovalCommandTarget {
  approvals?: {
    approve(senderId: string, id?: string, message?: WechatMessage): string;
    deny(senderId: string, id?: string, message?: WechatMessage): string;
    list(senderId: string): string;
    canResolveReply(senderId: string, message?: WechatMessage): boolean;
  };
}

export function formatApprovalPrompt(id: string, method: string, params: any): string {
  return [
    `Codex 请求微信审批（${id}）`,
    `类型：${friendlyMethod(method)}`,
    primaryRequestLine(method, params),
    detailLines(method, params),
    "",
    `引用本消息回复：同意 / 拒绝`,
    `兜底命令：/approve ${id} / /deny ${id}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function friendlyMethod(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return "命令执行";
    case "item/fileChange/requestApproval":
      return "文件写入权限";
    case "applyPatchApproval":
      return "应用补丁";
    case "item/permissions/requestApproval":
      return "权限提升";
    case "mcpServer/elicitation/request":
      return "MCP 交互";
    case "item/tool/requestUserInput":
      return "用户输入";
    default:
      return method;
  }
}

function primaryRequestLine(method: string, params: any): string {
  if (method === "item/commandExecution/requestApproval") return `命令：${params?.command || "(未知)"}`;
  if (method === "execCommandApproval") return `命令：${Array.isArray(params?.command) ? params.command.join(" ") : "(未知)"}`;
  if (method === "item/fileChange/requestApproval") return `路径：${params?.grantRoot || params?.cwd || "(未知)"}`;
  if (method === "applyPatchApproval") return `文件：${Object.keys(params?.fileChanges || {}).join(", ") || "(未知)"}`;
  if (method === "item/permissions/requestApproval") return `请求：${formatPermissions(params?.permissions)}`;
  return `内容：${shorten(JSON.stringify(params || {}), 300)}`;
}

function detailLines(method: string, params: any): string {
  const lines: string[] = [];
  const cwd = params?.cwd || params?.conversationId || params?.threadId;
  if (cwd) lines.push(`上下文：${cwd}`);
  if (params?.reason) lines.push(`原因：${params.reason}`);
  if (method === "item/commandExecution/requestApproval" && params?.networkApprovalContext) {
    lines.push(`网络：${shorten(JSON.stringify(params.networkApprovalContext), 300)}`);
  }
  if (method === "applyPatchApproval" && params?.grantRoot) lines.push(`授权根目录：${params.grantRoot}`);
  return lines.join("\n");
}

function formatPermissions(value: any): string {
  if (!value) return "(未知)";
  const parts: string[] = [];
  if (value.network) parts.push(`network=${JSON.stringify(value.network)}`);
  if (value.fileSystem) parts.push(`fileSystem=${JSON.stringify(value.fileSystem)}`);
  return shorten(parts.join("; ") || JSON.stringify(value), 300);
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function normalizeId(value?: string): string {
  return (value || "").trim().toLowerCase();
}

function messageIndexKey(senderId: string, messageKey: string): string {
  return `${senderId}\n${messageKey}`;
}

function hasReferencedApproval(message: WechatMessage): boolean {
  return extractReferencedApprovalIds(message).length > 0 || extractReferencedMessageKeys(message).some((key) => Boolean(approvalIdFromMessageKey(key)));
}

function approvalIdFromMessageKey(key: string): string | null {
  const match = key.match(/^item:approval:([0-9a-f]{6,12})(?::\d+)?$/i);
  return match?.[1]?.toLowerCase() || null;
}
