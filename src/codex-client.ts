import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { resolveUserPath } from "./config.js";
import { errorText, log, warn } from "./log.js";
import type { AppConfig, AppServerTransportModeUsed, AppServerTransportStatus, ThreadSummary, TurnResult, WechatRuntimeConfig } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type NotificationHandler = (method: string, params: any) => void;
type ApprovalDeniedHandler = (method: string, params: any) => void;
export type ServerRequestHandler = (request: { method: string; params: any }) => Promise<unknown>;

interface AppServerSpawnSpec {
  command: string;
  args: string[];
  label: string;
}

const REQUEST_TIMEOUT_MS = 120_000;
const PROXY_HANDSHAKE_TIMEOUT_MS = 5_000;
const INTERRUPT_TIMEOUT_MS = 10_000;

export class CodexClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notifications = new Set<NotificationHandler>();
  private approvalDeniedHandlers = new Set<ApprovalDeniedHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private initialized = false;
  private transportStatusValue: AppServerTransportStatus;

  constructor(private readonly config: AppConfig) {
    this.transportStatusValue = inspectAppServerTransport(config);
  }

  transportStatus(): AppServerTransportStatus {
    return { ...this.transportStatusValue };
  }

  async start(): Promise<void> {
    if (this.proc) return;
    await this.startSelectedTransport();
  }

  async stop(): Promise<void> {
    this.resetProcess(new Error("codex app-server stopped"));
  }

  private async startSelectedTransport(): Promise<void> {
    const mode = this.config.appServerTransport.mode;
    if (mode !== "spawn") {
      const socketPath = resolveUserPath(this.config.appServerTransport.desktopProxySocket);
      const socket = desktopProxySocketState(socketPath);
      if (socket.ready) {
        try {
          await this.startProcess("desktop-proxy", PROXY_HANDSHAKE_TIMEOUT_MS);
          this.transportStatusValue = {
            configuredMode: mode,
            modeUsed: "desktop-proxy",
            liveDesktopUpdates: true,
            reason: "connected to Desktop/shared app-server proxy",
            socketPath,
          };
          log(`codex app-server initialized via desktop-proxy (${socketPath})`);
          return;
        } catch (error) {
          const reason = `desktop proxy handshake failed: ${errorText(error)}`;
          this.resetProcess(new Error(reason));
          if (!this.config.appServerTransport.fallbackToSpawn) {
            this.transportStatusValue = {
              configuredMode: mode,
              modeUsed: "none",
              liveDesktopUpdates: false,
              reason,
              socketPath,
            };
            throw new Error(reason);
          }
          warn(`${reason}; falling back to spawn`);
          await this.startSpawn(reason, socketPath);
          return;
        }
      }
      const reason = socket.reason;
      if (!this.config.appServerTransport.fallbackToSpawn) {
        this.transportStatusValue = {
          configuredMode: mode,
          modeUsed: "none",
          liveDesktopUpdates: false,
          reason,
          socketPath,
        };
        throw new Error(reason);
      }
      await this.startSpawn(reason, socketPath);
      return;
    }

    await this.startSpawn("configured spawn transport");
  }

  private async startSpawn(reason: string, socketPath?: string): Promise<void> {
    await this.startProcess("spawn", REQUEST_TIMEOUT_MS);
    this.transportStatusValue = {
      configuredMode: this.config.appServerTransport.mode,
      modeUsed: "spawn",
      liveDesktopUpdates: false,
      reason: reason === "configured spawn transport" ? reason : `${reason}; falling back to spawn`,
      socketPath,
    };
    log(`codex app-server initialized via spawn (${this.transportStatusValue.reason})`);
  }

  private async startProcess(mode: Exclude<AppServerTransportModeUsed, "none">, initializeTimeoutMs: number): Promise<void> {
    const spec = buildAppServerSpawnSpec(this.config, mode);
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = child;
    child.stderr.on("data", (data) => warn(`${spec.label}: ${String(data).trim()}`));
    child.on("exit", (code, signal) => {
      const error = new Error(`${spec.label} exited: ${code ?? signal}`);
      this.rejectPending(error);
      if (this.proc === child) {
        this.proc = null;
        this.initialized = false;
      }
    });
    child.on("error", (error) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      if (this.proc === child) {
        this.proc = null;
        this.initialized = false;
      }
    });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    try {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "codex_beeper",
            title: "Codex Beeper",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
        0,
        initializeTimeoutMs,
      );
      this.sendNotification("initialized", {});
      this.initialized = true;
    } catch (error) {
      if (this.proc === child) this.resetProcess(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  onApprovalDenied(handler: ApprovalDeniedHandler): () => void {
    this.approvalDeniedHandlers.add(handler);
    return () => this.approvalDeniedHandlers.delete(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  async startThread(cwd: string): Promise<string> {
    await this.start();
    const runtime = threadRuntimeParams(this.config.wechatRuntime);
    const response = (await this.request("thread/start", {
      cwd,
      sandbox: runtime.sandbox,
      serviceName: "codex-beeper",
      approvalPolicy: runtime.approvalPolicy,
      config: {
        web_search: "disabled",
      },
    })) as { thread?: { id?: string } };
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("thread/start did not return thread.id");
    return threadId;
  }

  async resumeThread(threadId: string, cwd?: string): Promise<void> {
    await this.start();
    await this.request("thread/resume", { threadId, cwd: cwd || null, ...threadRuntimeParams(this.config.wechatRuntime) });
  }

  async listThreads(cwd?: string, limit = 10): Promise<ThreadSummary[]> {
    await this.start();
    const response = (await this.request("thread/list", {
      limit,
      sortKey: "updatedAt",
      sortDirection: "desc",
      cwd: cwd || null,
      archived: false,
      useStateDbOnly: false,
    })) as { data?: any[] };
    return (response.data || []).map((thread) => ({
      id: thread.id,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
    }));
  }

  async readThread(threadId: string): Promise<any> {
    await this.start();
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  async runTurn(params: { threadId: string; prompt: string; cwd?: string; timeoutMs?: number; onTurnId?: (turnId: string) => void }): Promise<TurnResult> {
    await this.start();
    let finalText = "";
    let turnId: string | undefined;
    let deniedRequests = 0;
    const updateTurnId = (id?: string) => {
      if (!id || id === turnId) return;
      turnId = id;
      params.onTurnId?.(id);
    };
    const offApproval = this.onApprovalDenied(() => {
      deniedRequests += 1;
    });
    try {
      return await new Promise<TurnResult>((resolve, reject) => {
        let off = () => {};
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const settle = (result?: TurnResult, error?: Error) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          off();
          if (error) reject(error);
          else resolve(result!);
        };
        const timeoutMs = params.timeoutMs ?? this.config.codexTurnTimeoutMs;
        timeout =
          timeoutMs > 0
            ? setTimeout(() => {
                const message = `Codex turn timed out after ${Math.round(timeoutMs / 1000)}s`;
                settle(undefined, new Error(message));
                void this.interruptTimedOutTurn(params.threadId, turnId, message);
              }, timeoutMs)
            : undefined;
        timeout?.unref?.();
        off = this.onNotification((method, event) => {
          if (event?.threadId !== params.threadId) return;
          if (method === "turn/started") updateTurnId(event.turn?.id);
          if (method === "item/agentMessage/delta") {
            updateTurnId(event.turnId);
            finalText += event.delta || "";
          }
          if (method === "item/completed" && event.item?.type === "agentMessage") {
            finalText = event.item.text || finalText;
          }
          if (method === "turn/completed") {
            updateTurnId(event.turn?.id);
            settle({ threadId: params.threadId, turnId, text: finalText.trim(), deniedRequests });
          }
          if (method === "error") {
            settle(undefined, new Error(event?.message || event?.error?.message || "codex turn failed"));
          }
        });
        this.request("turn/start", {
          threadId: params.threadId,
          cwd: params.cwd || null,
          approvalPolicy: this.config.wechatRuntime.approvalPolicy,
          sandboxPolicy: turnSandboxPolicy(this.config.wechatRuntime, params.cwd),
          input: [{ type: "text", text: params.prompt, text_elements: [] }],
        })
          .then((response: any) => {
            updateTurnId(response?.turn?.id);
          })
          .catch((error) => {
            settle(undefined, error instanceof Error ? error : new Error(String(error)));
          });
      });
    } finally {
      offApproval();
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.request("turn/interrupt", { threadId, turnId }, 0, INTERRUPT_TIMEOUT_MS);
  }

  private async interruptTimedOutTurn(threadId: string, turnId: string | undefined, message: string): Promise<void> {
    if (!turnId) {
      warn(`${message}; turn id was not available, restarting app-server transport`);
      this.resetProcess(new Error(message));
      return;
    }
    try {
      await this.interruptTurn(threadId, turnId);
    } catch (error) {
      warn(`turn/interrupt failed after timeout: ${errorText(error)}; restarting app-server transport`);
      this.resetProcess(new Error(message));
    }
  }

  private async request(method: string, params?: unknown, attempt = 0, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.proc) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const payload = { id, method, params };
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs).unref();
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    try {
      return await response;
    } catch (error) {
      if (String(errorText(error)).includes("-32001") && attempt < 5) {
        await delay(250 * 2 ** attempt + Math.floor(Math.random() * 100));
        return this.request(method, params, attempt + 1, timeoutMs);
      }
      throw error;
    }
  }

  private sendNotification(method: string, params: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      warn(`invalid JSON from codex app-server: ${line.slice(0, 200)}`);
      return;
    }
    if (message.id != null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      return;
    }
    if (message.id != null && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      for (const handler of this.notifications) handler(message.method, message.params);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private resetProcess(error: Error): void {
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    this.rejectPending(error);
    if (proc && !proc.killed) proc.kill("SIGTERM");
  }

  private async handleServerRequest(message: { id: number; method: string; params: any }): Promise<void> {
    let result: unknown;
    try {
      result = this.serverRequestHandler ? await this.serverRequestHandler({ method: message.method, params: message.params }) : fallbackForMethod(message.method);
    } catch (error) {
      warn(`server request handler failed: ${errorText(error)}`);
      result = fallbackForMethod(message.method);
    }
    this.proc?.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
    if (isWechatApprovableMethod(message.method) && isDenialResult(message.method, result)) {
      for (const handler of this.approvalDeniedHandlers) handler(message.method, message.params);
    }
  }
}

export function threadRuntimeParams(runtime: WechatRuntimeConfig): { approvalPolicy: WechatRuntimeConfig["approvalPolicy"]; sandbox: WechatRuntimeConfig["sandbox"] } {
  return {
    approvalPolicy: runtime.approvalPolicy,
    sandbox: runtime.sandbox,
  };
}

export function turnSandboxPolicy(runtime: WechatRuntimeConfig, cwd?: string): unknown {
  if (runtime.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (!cwd) return null;
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: runtime.networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function buildAppServerSpawnSpec(config: AppConfig, mode: Exclude<AppServerTransportModeUsed, "none">): AppServerSpawnSpec {
  if (mode === "desktop-proxy") {
    return {
      command: config.codexBin,
      args: ["app-server", "proxy", "--sock", resolveUserPath(config.appServerTransport.desktopProxySocket)],
      label: "codex app-server proxy",
    };
  }
  const configArgs = config.codexAppServerConfigOverrides.flatMap((override) => ["-c", override]);
  return {
    command: config.codexBin,
    args: ["app-server", ...configArgs],
    label: "codex app-server",
  };
}

export function inspectAppServerTransport(config: AppConfig): AppServerTransportStatus {
  const configuredMode = config.appServerTransport.mode;
  const socketPath = resolveUserPath(config.appServerTransport.desktopProxySocket);
  if (configuredMode === "spawn") {
    return {
      configuredMode,
      modeUsed: "spawn",
      liveDesktopUpdates: false,
      reason: "configured spawn transport",
      socketPath,
    };
  }

  const socket = desktopProxySocketState(socketPath);
  if (socket.ready) {
    return {
      configuredMode,
      modeUsed: "desktop-proxy",
      liveDesktopUpdates: true,
      reason: "desktop proxy socket exists; initialize handshake will confirm on daemon start",
      socketPath,
    };
  }

  if (config.appServerTransport.fallbackToSpawn) {
    return {
      configuredMode,
      modeUsed: "spawn",
      liveDesktopUpdates: false,
      reason: `${socket.reason}; falling back to spawn`,
      socketPath,
    };
  }

  return {
    configuredMode,
    modeUsed: "none",
    liveDesktopUpdates: false,
    reason: socket.reason,
    socketPath,
  };
}

export function desktopLiveUpdateDoctorStatus(status: AppServerTransportStatus): "ready" | "unavailable" | "fallback" {
  if (status.liveDesktopUpdates) return "ready";
  if (status.modeUsed === "spawn") return "fallback";
  return "unavailable";
}

function desktopProxySocketState(socketPath: string): { ready: boolean; reason: string } {
  try {
    const stat = fs.statSync(socketPath);
    if (!stat.isSocket()) return { ready: false, reason: `desktop proxy path is not a socket: ${socketPath}` };
    return { ready: true, reason: "desktop proxy socket exists" };
  } catch {
    return { ready: false, reason: `desktop proxy socket not found: ${socketPath}` };
  }
}

export function denialForMethod(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
      return { decision: "denied" };
    case "applyPatchApproval":
      return { decision: "denied" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/permissions/requestApproval":
      return {
        permissions: {},
        scope: "turn",
        strictAutoReview: true,
      };
    default:
      return { error: "Denied by Codex Beeper safety policy" };
  }
}

export function fallbackForMethod(method: string): unknown {
  switch (method) {
    case "item/tool/call":
      return { contentItems: [], success: false };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    default:
      return denialForMethod(method);
  }
}

export function approvalForMethod(method: string, params?: any): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "accept" };
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    case "execCommandApproval":
      return { decision: "approved" };
    case "applyPatchApproval":
      return { decision: "approved" };
    case "item/permissions/requestApproval":
      return {
        permissions: {
          network: params?.permissions?.network || undefined,
          fileSystem: params?.permissions?.fileSystem || undefined,
        },
        scope: "turn",
        strictAutoReview: true,
      };
    default:
      return denialForMethod(method);
  }
}

export function isWechatApprovableMethod(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
    "item/permissions/requestApproval",
  ].includes(method);
}

function isDenialResult(method: string, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  if (method === "item/tool/requestUserInput") return true;
  if (method === "item/permissions/requestApproval" && value.permissions && typeof value.permissions === "object") {
    const permissions = value.permissions as Record<string, unknown>;
    return !permissions.network && !permissions.fileSystem;
  }
  return (
    value.decision === "decline" ||
    value.decision === "denied" ||
    value.decision === "timed_out" ||
    "error" in value ||
    value.action === "decline"
  );
}
