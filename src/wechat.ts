import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { errorText, log, sanitizeText, warn } from "./log.js";
import { readJsonFile, statePath, writePrivateFile } from "./paths.js";
import { splitWechatText, WECHAT_TEXT_LIMIT } from "./text.js";
import type { AccountData, AppConfig, WechatMessage } from "./types.js";

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;
const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

const typingTicketCache = new Map<string, { ticket: string; fetchedAt: number }>();

export interface SentWechatText {
  clientId: string;
  itemMsgId: string;
  text: string;
}

export interface SendTextOptions {
  clientId?: string;
  itemMsgId?: string;
}

export class WechatApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret: number,
    readonly errmsg?: string,
  ) {
    super(`WeChat API ${endpoint} returned ret=${ret}${errmsg ? ` ${errmsg}` : ""}`);
    this.name = "WechatApiError";
  }
}

export function accountPath(): string {
  return statePath("account.json");
}

export function syncPath(): string {
  return statePath("sync_buf.txt");
}

export function loadAccount(): AccountData | null {
  return readJsonFile<AccountData>(accountPath());
}

export function saveAccount(account: AccountData): void {
  writePrivateFile(accountPath(), `${JSON.stringify(account, null, 2)}\n`);
}

function randomWechatUin(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return Buffer.from(String(bytes[0]), "utf8").toString("base64");
}

function headers(token?: string, body?: string): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) result.Authorization = `Bearer ${token}`;
  if (body) result["Content-Length"] = String(Buffer.byteLength(body));
  return result;
}

export async function apiFetch(config: AppConfig, endpoint: string, payload: unknown, token?: string, timeoutMs = 35_000): Promise<unknown> {
  const accountBase = config.wechat.baseUrl.endsWith("/") ? config.wechat.baseUrl : `${config.wechat.baseUrl}/`;
  const url = new URL(endpoint, accountBase).toString();
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(token, body),
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitizeText(text)}`);
    const parsed = text ? JSON.parse(text) : {};
    assertWechatApiSuccess(endpoint, parsed);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function assertWechatApiSuccess(endpoint: string, response: unknown): void {
  if (!isRecord(response) || typeof response.ret !== "number" || response.ret === 0) return;
  throw new WechatApiError(endpoint, response.ret, typeof response.errmsg === "string" ? response.errmsg : undefined);
}

export function isWechatContextTokenStaleError(error: unknown): boolean {
  return error instanceof WechatApiError && error.endpoint === "ilink/bot/sendmessage" && error.ret === -2;
}

export async function sendText(
  config: AppConfig,
  account: AccountData,
  toUserId: string,
  text: string,
  contextToken: string,
  options: SendTextOptions = {},
): Promise<SentWechatText> {
  const clientId = options.clientId || `codex-beeper:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const itemMsgId = options.itemMsgId || clientId;
  await apiFetch(
    { ...config, wechat: { ...config.wechat, baseUrl: account.baseUrl || config.wechat.baseUrl } },
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, msg_id: itemMsgId, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: config.wechat.channelVersion },
    },
    account.token,
    15_000,
  );
  return { clientId, itemMsgId, text };
}

export async function sendLongText(
  config: AppConfig,
  account: AccountData,
  toUserId: string,
  text: string,
  contextToken: string,
  options: { messageIdPrefix?: string; continuationPrefix?: string } = {},
): Promise<SentWechatText[]> {
  const sent: SentWechatText[] = [];
  const continuationPrefix = options.continuationPrefix?.trimEnd();
  const limit = continuationPrefix ? Math.max(200, WECHAT_TEXT_LIMIT - continuationPrefix.length - 2) : WECHAT_TEXT_LIMIT;
  const chunks = splitWechatText(text, limit);
  for (let index = 0; index < chunks.length; index += 1) {
    const itemMsgId = options.messageIdPrefix ? `${options.messageIdPrefix}:${index + 1}` : undefined;
    const chunk = continuationPrefix && index > 0 ? `${continuationPrefix}\n${chunks[index]}` : chunks[index];
    sent.push(await sendText(config, account, toUserId, chunk, contextToken, { itemMsgId }));
  }
  return sent;
}

export function startTyping(config: AppConfig, account: AccountData, toUserId: string, contextToken: string): () => void {
  if (!config.wechatProgress.typingEnabled) return () => {};
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let ticket = "";

  const sendStatus = async (status: number) => {
    if (!ticket) return;
    await apiFetch(
      { ...config, wechat: { ...config.wechat, baseUrl: account.baseUrl || config.wechat.baseUrl } },
      "ilink/bot/sendtyping",
      {
        ilink_user_id: toUserId,
        typing_ticket: ticket,
        status,
      },
      account.token,
      10_000,
    );
  };

  void (async () => {
    ticket = await getTypingTicket(config, account, toUserId, contextToken);
    if (!ticket || stopped) return;
    try {
      await sendStatus(TYPING_STATUS_TYPING);
    } catch {
      return;
    }
    interval = setInterval(() => {
      void sendStatus(TYPING_STATUS_TYPING).catch(() => {
        if (interval) clearInterval(interval);
        interval = undefined;
      });
    }, config.wechatProgress.typingKeepaliveMs);
    interval.unref?.();
  })();

  return () => {
    stopped = true;
    if (interval) clearInterval(interval);
    interval = undefined;
    void sendStatus(TYPING_STATUS_CANCEL).catch(() => {});
  };
}

async function getTypingTicket(config: AppConfig, account: AccountData, toUserId: string, contextToken: string): Promise<string> {
  const cacheKey = `${account.accountId}:${toUserId}`;
  const cached = typingTicketCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TYPING_TICKET_TTL_MS) return cached.ticket;
  try {
    const response = (await apiFetch(
      { ...config, wechat: { ...config.wechat, baseUrl: account.baseUrl || config.wechat.baseUrl } },
      "ilink/bot/getconfig",
      { ilink_user_id: toUserId, context_token: contextToken },
      account.token,
      10_000,
    )) as { ret?: number; typing_ticket?: string };
    if (response.ret === 0 && response.typing_ticket) {
      typingTicketCache.set(cacheKey, { ticket: response.typing_ticket, fetchedAt: Date.now() });
      return response.typing_ticket;
    }
  } catch {
    // Typing is best-effort; never block the actual Codex response.
  }
  return "";
}

export function extractText(message: WechatMessage): string {
  for (const item of message.item_list || []) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) return item.text_item.text.trim();
  }
  return "";
}

export function extractReferencedMessageKeys(message: WechatMessage): string[] {
  const keys = new Set<string>();
  for (const item of message.item_list || []) {
    collectRefMessageKeys(item.ref_msg, keys);
  }
  return [...keys];
}

export function hasReferencedMessage(message?: WechatMessage): boolean {
  return Boolean(message?.item_list?.some((item) => hasRefMessage(item.ref_msg)));
}

export function extractReferencedNoticeIds(message: WechatMessage): string[] {
  return extractReferencedIds(message, /\/(?:show|r)\s+([0-9a-f]{6,12})\b/gi);
}

export function extractReferencedApprovalIds(message: WechatMessage): string[] {
  return extractReferencedIds(message, /\/(?:approve|deny)\s+([0-9a-f]{6,12})\b/gi);
}

function extractReferencedIds(message: WechatMessage, commandPattern: RegExp): string[] {
  const ids = new Set<string>();
  for (const text of referencedTexts(message)) {
    const matches = [
      ...[...text.matchAll(commandPattern)].map((match) => ({ index: match.index, id: match[1] })),
      ...[...text.matchAll(/[（(]([0-9a-f]{6,12})[）)]/gi)].map((match) => ({ index: match.index, id: match[1] })),
    ].sort((a, b) => a.index - b.index);
    for (const match of matches) ids.add(match.id.toLowerCase());
  }
  return [...ids];
}

function collectRefMessageKeys(ref: unknown, keys: Set<string>): void {
  if (!isRecord(ref)) return;
  const messageItem = isRecord(ref.message_item) ? ref.message_item : null;
  if (typeof messageItem?.msg_id === "string" && messageItem.msg_id) keys.add(`item:${messageItem.msg_id}`);
  collectRefMessageKeys(messageItem?.ref_msg, keys);
}

function hasRefMessage(ref: unknown): boolean {
  if (!isRecord(ref)) return false;
  return true;
}

function referencedTexts(message: WechatMessage): string[] {
  const texts: string[] = [];
  for (const item of message.item_list || []) collectRefTexts(item.ref_msg, texts);
  return texts;
}

function collectRefTexts(ref: unknown, texts: string[]): void {
  if (!isRecord(ref)) return;
  if (typeof ref.title === "string") texts.push(ref.title);
  const messageItem = isRecord(ref.message_item) ? ref.message_item : null;
  const textItem = isRecord(messageItem?.text_item) ? messageItem.text_item : null;
  if (typeof textItem?.text === "string") texts.push(textItem.text);
  collectRefTexts(messageItem?.ref_msg, texts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function getUpdates(config: AppConfig, account: AccountData, syncBuf: string): Promise<{ syncBuf: string; messages: WechatMessage[] }> {
  const response = (await apiFetch(
    { ...config, wechat: { ...config.wechat, baseUrl: account.baseUrl || config.wechat.baseUrl } },
    "ilink/bot/getupdates",
    {
      get_updates_buf: syncBuf,
      base_info: { channel_version: config.wechat.channelVersion },
    },
    account.token,
    38_000,
  )) as { get_updates_buf?: string; msgs?: WechatMessage[] };
  return {
    syncBuf: response.get_updates_buf || syncBuf,
    messages: (response.msgs || []).filter((message) => message.message_type === MSG_TYPE_USER),
  };
}

export async function monitorWechat(
  config: AppConfig,
  account: AccountData,
  onMessage: (message: WechatMessage) => Promise<void>,
  options?:
    | AbortSignal
    | {
        signal?: AbortSignal;
        onMessagesReceived?: (messages: WechatMessage[]) => void | Promise<void>;
        onPollSuccess?: () => void;
        onPollError?: (error: unknown) => void;
      },
): Promise<void> {
  const signal = options instanceof AbortSignal ? options : options?.signal;
  const onMessagesReceived = options instanceof AbortSignal ? undefined : options?.onMessagesReceived;
  const onPollSuccess = options instanceof AbortSignal ? undefined : options?.onPollSuccess;
  const onPollError = options instanceof AbortSignal ? undefined : options?.onPollError;
  let syncBuf = "";
  try {
    if (fs.existsSync(syncPath())) syncBuf = fs.readFileSync(syncPath(), "utf8");
  } catch {
    syncBuf = "";
  }
  log("WeChat monitor started");
  while (!signal?.aborted) {
    try {
      const result = await getUpdates(config, account, syncBuf);
      if (result.messages.length) await onMessagesReceived?.(result.messages);
      syncBuf = result.syncBuf;
      writePrivateFile(syncPath(), syncBuf);
      onPollSuccess?.();
      for (const message of result.messages) await onMessage(message);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") continue;
      onPollError?.(error);
      warn(`WeChat poll failed: ${errorText(error)}`);
      await delay(3000);
    }
  }
}

export async function loginWithQr(config: AppConfig, printQr: (qr: string) => void | Promise<void>): Promise<AccountData> {
  const qrResponse = (await fetch(`${config.wechat.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`).then((response) => response.json())) as {
    qrcode: string;
    qrcode_img_content: string;
  };
  await printQr(qrResponse.qrcode_img_content);
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    const status = (await fetch(`${config.wechat.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrResponse.qrcode)}`, {
      headers: { "iLink-App-ClientVersion": "1" },
    }).then((response) => response.json())) as {
      status: "wait" | "scaned" | "confirmed" | "expired";
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };
    if (status.status === "expired") throw new Error("QR code expired");
    if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id) throw new Error("WeChat did not return complete bot credentials");
      const account: AccountData = {
        token: status.bot_token,
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl || config.wechat.baseUrl,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };
      saveAccount(account);
      return account;
    }
    await delay(1000);
  }
  throw new Error("QR login timed out");
}
