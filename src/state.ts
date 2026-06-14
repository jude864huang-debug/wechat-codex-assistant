import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { statePath } from "./paths.js";
import type { HookPayload, NoticeRecord, ThreadSummary, WechatMessage } from "./types.js";
import { stableHash } from "./text.js";

export interface ChatState {
  senderId: string;
  currentProject?: string;
  currentThread?: string;
  pendingNewProject?: string;
  muted: boolean;
  lastNoticeId?: string;
}

export interface ContextTokenStatus {
  stale: boolean;
  reason?: string;
  updatedAt?: number;
}

export interface InboundMessageRecord {
  key: string;
  senderId: string;
  message: WechatMessage;
  createdAt: number;
  attempts: number;
  processingAt?: number;
  processedAt?: number;
  lastError?: string;
}

export class StateStore {
  private db: DatabaseSync;

  constructor(dbPath = statePath("state.sqlite")) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS allowlist (
        sender_id TEXT PRIMARY KEY,
        nickname TEXT,
        is_owner INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_tokens (
        sender_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_state (
        sender_id TEXT PRIMARY KEY,
        current_project TEXT,
        current_thread TEXT,
        pending_new_project TEXT,
        muted INTEGER NOT NULL DEFAULT 0,
        last_notice_id TEXT
      );
      CREATE TABLE IF NOT EXISTS notices (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        cwd TEXT,
        project_alias TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER,
        delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS self_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        message_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_hash)
      );
      CREATE TABLE IF NOT EXISTS recent_lists (
        sender_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (sender_id, kind)
      );
      CREATE TABLE IF NOT EXISTS hook_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbound_notice_messages (
        sender_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        notice_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (sender_id, message_key)
      );
      CREATE TABLE IF NOT EXISTS context_token_status (
        sender_id TEXT PRIMARY KEY,
        stale INTEGER NOT NULL,
        reason TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound_messages (
        message_key TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        processing_at INTEGER,
        processed_at INTEGER,
        last_error TEXT
      );
    `);
    this.ensureColumn("chat_state", "pending_new_project", "TEXT");
  }

  upsertContextToken(senderId: string, token: string): void {
    this.db
      .prepare("INSERT INTO context_tokens VALUES (?, ?, ?) ON CONFLICT(sender_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at")
      .run(senderId, token, Date.now());
    this.clearContextTokenStale(senderId);
  }

  getContextToken(senderId: string): string | null {
    const row = this.db.prepare("SELECT token FROM context_tokens WHERE sender_id = ?").get(senderId) as { token?: string } | undefined;
    return row?.token || null;
  }

  getContextTokenUpdatedAt(senderId: string): number | null {
    const row = this.db.prepare("SELECT updated_at as updatedAt FROM context_tokens WHERE sender_id = ?").get(senderId) as { updatedAt?: number } | undefined;
    return row?.updatedAt || null;
  }

  markContextTokenStale(senderId: string, reason: string): void {
    this.db
      .prepare(
        "INSERT INTO context_token_status (sender_id, stale, reason, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(sender_id) DO UPDATE SET stale = 1, reason = excluded.reason, updated_at = excluded.updated_at",
      )
      .run(senderId, reason, Date.now());
  }

  clearContextTokenStale(senderId: string): void {
    this.db.prepare("DELETE FROM context_token_status WHERE sender_id = ?").run(senderId);
  }

  getContextTokenStatus(senderId: string): ContextTokenStatus {
    const row = this.db.prepare("SELECT stale, reason, updated_at as updatedAt FROM context_token_status WHERE sender_id = ?").get(senderId) as
      | { stale?: number; reason?: string; updatedAt?: number }
      | undefined;
    return {
      stale: Boolean(row?.stale),
      reason: row?.reason || undefined,
      updatedAt: row?.updatedAt || undefined,
    };
  }

  addAllowed(senderId: string, nickname = senderId.split("@")[0], isOwner = false): void {
    this.db
      .prepare("INSERT INTO allowlist VALUES (?, ?, ?, ?) ON CONFLICT(sender_id) DO UPDATE SET nickname = excluded.nickname, is_owner = excluded.is_owner")
      .run(senderId, nickname, isOwner ? 1 : 0, Date.now());
  }

  isAllowed(senderId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM allowlist WHERE sender_id = ?").get(senderId));
  }

  listAllowed(): Array<{ senderId: string; nickname?: string; isOwner: boolean }> {
    return (this.db
      .prepare("SELECT sender_id as senderId, nickname, is_owner as isOwner FROM allowlist ORDER BY created_at")
      .all() as Array<{ senderId: string; nickname?: string; isOwner: number | boolean }>).map((row) => ({
      senderId: row.senderId,
      nickname: row.nickname,
      isOwner: Boolean(row.isOwner),
    }));
  }

  ownerSenderId(): string | null {
    const row = this.db.prepare("SELECT sender_id as senderId FROM allowlist WHERE is_owner = 1 LIMIT 1").get() as { senderId?: string } | undefined;
    return row?.senderId || null;
  }

  getChat(senderId: string): ChatState {
    const row = this.db.prepare("SELECT * FROM chat_state WHERE sender_id = ?").get(senderId) as
      | { sender_id: string; current_project?: string; current_thread?: string; pending_new_project?: string; muted: number; last_notice_id?: string }
      | undefined;
    return {
      senderId,
      currentProject: row?.current_project || undefined,
      currentThread: row?.current_thread || undefined,
      pendingNewProject: row?.pending_new_project || undefined,
      muted: Boolean(row?.muted),
      lastNoticeId: row?.last_notice_id || undefined,
    };
  }

  patchChat(senderId: string, patch: Partial<Omit<ChatState, "senderId">>): ChatState {
    const current = this.getChat(senderId);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "INSERT INTO chat_state (sender_id, current_project, current_thread, pending_new_project, muted, last_notice_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sender_id) DO UPDATE SET current_project = excluded.current_project, current_thread = excluded.current_thread, pending_new_project = excluded.pending_new_project, muted = excluded.muted, last_notice_id = excluded.last_notice_id",
      )
      .run(senderId, next.currentProject || null, next.currentThread || null, next.pendingNewProject || null, next.muted ? 1 : 0, next.lastNoticeId || null);
    return next;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createNotice(input: Omit<NoticeRecord, "id">): NoticeRecord {
    let id = crypto.randomBytes(3).toString("hex");
    while (this.getNotice(id)) id = crypto.randomBytes(3).toString("hex");
    const notice: NoticeRecord = { ...input, id };
    this.db
      .prepare(
        "INSERT INTO notices (id, session_id, thread_id, turn_id, cwd, project_alias, title, summary, body, source, created_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        notice.id,
        notice.sessionId,
        notice.threadId || null,
        notice.turnId || null,
        notice.cwd || null,
        notice.projectAlias || null,
        notice.title,
        notice.summary,
        notice.body,
        notice.source,
        notice.createdAt,
        notice.durationMs || null,
      );
    return notice;
  }

  getNotice(idOrLast: string, senderId?: string): NoticeRecord | null {
    const id = idOrLast === "last" && senderId ? this.getChat(senderId).lastNoticeId : idOrLast;
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM notices WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToNotice(row);
  }

  markNoticeDelivered(id: string): void {
    this.db.prepare("UPDATE notices SET delivered = 1 WHERE id = ?").run(id);
  }

  pendingUndeliveredNotices(limit = 20): NoticeRecord[] {
    return this.db
      .prepare("SELECT * FROM notices WHERE delivered = 0 ORDER BY created_at ASC LIMIT ?")
      .all(limit)
      .map((row) => rowToNotice(row as Record<string, unknown>));
  }

  countUndeliveredNotices(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM notices WHERE delivered = 0").get() as { count?: number } | undefined;
    return Number(row?.count || 0);
  }

  recordOutboundNoticeMessage(senderId: string, noticeId: string, messageKeys: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO outbound_notice_messages (sender_id, message_key, notice_id, created_at) VALUES (?, ?, ?, ?)",
    );
    const createdAt = Date.now();
    for (const key of new Set(messageKeys.filter(Boolean))) stmt.run(senderId, key, noticeId, createdAt);
  }

  getNoticeIdByOutboundMessageKey(senderId: string, messageKey: string): string | null {
    const row = this.db
      .prepare("SELECT notice_id as noticeId FROM outbound_notice_messages WHERE sender_id = ? AND message_key = ?")
      .get(senderId, messageKey) as { noticeId?: string } | undefined;
    return row?.noticeId || null;
  }

  recordSelfTurn(threadId: string, prompt: string, turnId?: string, assistantBody?: string): void {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO self_turns VALUES (?, ?, ?, ?)");
    const createdAt = Date.now();
    stmt.run(threadId, turnId || null, stableHash(prompt), createdAt);
    if (assistantBody?.trim()) stmt.run(threadId, turnId || null, stableHash(assistantBody), createdAt);
  }

  isSelfTurn(threadIdOrSessionId?: string, turnId?: string, body = ""): boolean {
    if (!threadIdOrSessionId) return false;
    const recentCutoff = Date.now() - 10 * 60 * 1000;
    if (turnId) {
      const byTurn = this.db.prepare("SELECT 1 FROM self_turns WHERE thread_id = ? AND turn_id = ?").get(threadIdOrSessionId, turnId);
      if (byTurn) return true;
      const byRecentTurn = this.db.prepare("SELECT 1 FROM self_turns WHERE turn_id = ? AND created_at >= ?").get(turnId, recentCutoff);
      if (byRecentTurn) return true;
    }
    if (body) {
      const hash = stableHash(body);
      const byHash = this.db.prepare("SELECT 1 FROM self_turns WHERE thread_id = ? AND message_hash = ?").get(threadIdOrSessionId, hash);
      if (byHash) return true;
      const byRecentHash = this.db.prepare("SELECT 1 FROM self_turns WHERE message_hash = ? AND created_at >= ?").get(hash, recentCutoff);
      if (byRecentHash) return true;
    }
    return false;
  }

  saveRecentThreads(senderId: string, threads: ThreadSummary[]): void {
    this.db
      .prepare("INSERT INTO recent_lists VALUES (?, 'threads', ?, ?) ON CONFLICT(sender_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(senderId, JSON.stringify(threads), Date.now());
  }

  getRecentThreadByIndex(senderId: string, index: number): ThreadSummary | null {
    const row = this.db.prepare("SELECT payload FROM recent_lists WHERE sender_id = ? AND kind = 'threads'").get(senderId) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    const threads = JSON.parse(row.payload) as ThreadSummary[];
    return threads[index - 1] || null;
  }

  enqueueInboundMessages(messages: WechatMessage[]): string[] {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO inbound_messages (message_key, sender_id, payload, created_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    const keys: string[] = [];
    for (const message of messages) {
      const key = inboundMessageKey(message);
      keys.push(key);
      stmt.run(key, message.from_user_id, JSON.stringify(message), now);
    }
    return keys;
  }

  getInboundMessage(key: string): InboundMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM inbound_messages WHERE message_key = ? AND processed_at IS NULL").get(key) as Record<string, unknown> | undefined;
    return row ? rowToInboundMessage(row) : null;
  }

  pendingInboundMessages(limit = 100): InboundMessageRecord[] {
    return this.db
      .prepare("SELECT * FROM inbound_messages WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT ?")
      .all(limit)
      .map((row) => rowToInboundMessage(row as Record<string, unknown>));
  }

  markInboundProcessing(key: string): void {
    this.db
      .prepare("UPDATE inbound_messages SET processing_at = ?, attempts = attempts + 1 WHERE message_key = ? AND processed_at IS NULL")
      .run(Date.now(), key);
  }

  markInboundProcessed(key: string): void {
    this.db.prepare("UPDATE inbound_messages SET processed_at = ?, processing_at = NULL WHERE message_key = ?").run(Date.now(), key);
  }

  markInboundFailed(key: string, error: string): void {
    this.db
      .prepare("UPDATE inbound_messages SET processing_at = NULL, last_error = ? WHERE message_key = ? AND processed_at IS NULL")
      .run(error.slice(0, 1000), key);
  }

  enqueueHook(payload: HookPayload): void {
    this.db.prepare("INSERT INTO hook_queue (payload, created_at) VALUES (?, ?)").run(JSON.stringify(payload), Date.now());
  }

  pendingHooks(): Array<{ id: number; payload: HookPayload }> {
    return this.db
      .prepare("SELECT id, payload FROM hook_queue WHERE delivered = 0 ORDER BY id LIMIT 100")
      .all()
      .map((row) => ({ id: Number((row as { id: number }).id), payload: JSON.parse(String((row as { payload: string }).payload)) as HookPayload }));
  }

  markHookDelivered(id: number): void {
    this.db.prepare("UPDATE hook_queue SET delivered = 1 WHERE id = ?").run(id);
  }
}

export function inboundMessageKey(message: WechatMessage): string {
  if (message.message_id != null) return `message:${message.message_id}`;
  if (message.client_id) return `client:${message.client_id}`;
  if (message.seq != null) return `seq:${message.seq}`;
  const itemIds = (message.item_list || [])
    .map((item) => item.msg_id)
    .filter(Boolean)
    .join(",");
  if (itemIds) return `items:${message.from_user_id}:${itemIds}`;
  return `hash:${stableHash(JSON.stringify(message))}`;
}

function rowToNotice(row: Record<string, unknown>): NoticeRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    threadId: row.thread_id ? String(row.thread_id) : undefined,
    turnId: row.turn_id ? String(row.turn_id) : undefined,
    cwd: row.cwd ? String(row.cwd) : undefined,
    projectAlias: row.project_alias ? String(row.project_alias) : undefined,
    title: String(row.title),
    summary: String(row.summary),
    body: String(row.body),
    source: String(row.source) as NoticeRecord["source"],
    createdAt: Number(row.created_at),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
  };
}

function rowToInboundMessage(row: Record<string, unknown>): InboundMessageRecord {
  return {
    key: String(row.message_key),
    senderId: String(row.sender_id),
    message: JSON.parse(String(row.payload)) as WechatMessage,
    createdAt: Number(row.created_at),
    attempts: Number(row.attempts || 0),
    processingAt: row.processing_at == null ? undefined : Number(row.processing_at),
    processedAt: row.processed_at == null ? undefined : Number(row.processed_at),
    lastError: row.last_error ? String(row.last_error) : undefined,
  };
}

export function removeStateDbForTests(file: string): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      // ignore
    }
  }
}
