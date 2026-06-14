import fs from "node:fs";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { log, warn } from "./log.js";
import { codexHome, ensureDir, statePath, writePrivateFile } from "./paths.js";
import { StateStore } from "./state.js";
import type { HookPayload } from "./types.js";

export function hookSocketPath(): string {
  return statePath("hook.sock");
}

export function parseHookPayload(raw: string): HookPayload {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as HookPayload;
}

export async function postHookPayload(payload: HookPayload, store = new StateStore()): Promise<boolean> {
  const data = `${JSON.stringify(payload)}\n`;
  const socket = hookSocketPath();
  const sent = await new Promise<boolean>((resolve) => {
    const client = net.createConnection(socket, () => {
      client.end(data);
      resolve(true);
    });
    client.on("error", () => resolve(false));
    client.setTimeout(1000, () => {
      client.destroy();
      resolve(false);
    });
  });
  if (!sent) store.enqueueHook(payload);
  return sent;
}

export function startHookServer(onPayload: (payload: HookPayload) => Promise<void>): net.Server {
  const socket = hookSocketPath();
  try {
    fs.rmSync(socket, { force: true });
  } catch {
    // ignore
  }
  const server = net.createServer((connection) => {
    let raw = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      raw += chunk;
    });
    connection.on("end", () => {
      try {
        void onPayload(parseHookPayload(raw)).catch((error) => {
          warn(`failed to process hook payload: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        warn(`failed to process hook payload: ${String(error)}`);
      }
    });
  });
  server.listen(socket, () => log(`hook socket listening: ${socket}`));
  return server;
}

export function hooksJsonPath(): string {
  return path.join(codexHome(), "hooks.json");
}

export function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

export function cliEntryPath(projectRoot?: string): string {
  if (projectRoot) return path.join(projectRoot, "dist", "cli.js");
  if (process.argv[1] && fs.existsSync(process.argv[1])) return path.resolve(process.argv[1]);
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

export function hookCommand(projectRoot?: string): string {
  const cli = cliEntryPath(projectRoot);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} hook-post`;
}

export function installHook(projectRoot?: string): void {
  ensureDir(codexHome());
  const featureChanged = enableHooksFeature();
  const file = hooksJsonPath();
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
  const data = JSON.parse(raw) as any;
  data.hooks ||= {};
  data.hooks.Stop ||= [];
  const command = hookCommand(projectRoot);
  const existing = JSON.stringify(data.hooks.Stop).includes("wechat-codex");
  let changed = false;
  if (!existing) {
    data.hooks.Stop.push({
      hooks: [
        {
          type: "command",
          command,
          command_windows: command,
          timeout: 10,
          statusMessage: "wechat-codex: Notifying WeChat",
        },
      ],
    });
    changed = true;
  }
  if (changed) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    writePrivateFile(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  if (changed || featureChanged) {
    markHookConfigUpdated();
  }
}

export async function trustInstalledHook(cwd = process.cwd()): Promise<{ key: string; currentHash: string; trustStatus: string }> {
  const hook = await readWechatHookMetadata(cwd);
  if (!hook) throw new Error("未找到 wechat-codex Stop hook，请先运行 hook install。");
  upsertHookTrustState(hook.key, hook.currentHash);
  const verified = await readWechatHookMetadata(cwd);
  if (!verified) throw new Error("写入 trust 后无法重新读取 wechat-codex Stop hook。");
  return { key: verified.key, currentHash: verified.currentHash, trustStatus: verified.trustStatus };
}

export function uninstallHook(): void {
  const file = hooksJsonPath();
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as any;
  const stop = Array.isArray(data.hooks?.Stop) ? data.hooks.Stop : [];
  data.hooks.Stop = stop.filter((group: unknown) => !JSON.stringify(group).includes("wechat-codex"));
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  writePrivateFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function hookStatus(): { installed: boolean; hooksFeature: "enabled" | "disabled" | "unknown"; hooksJson: string; configToml: string } {
  const hooksRaw = fs.existsSync(hooksJsonPath()) ? fs.readFileSync(hooksJsonPath(), "utf8") : "";
  const configRaw = fs.existsSync(codexConfigPath()) ? fs.readFileSync(codexConfigPath(), "utf8") : "";
  let hooksFeature: "enabled" | "disabled" | "unknown" = "unknown";
  if (/^\s*hooks\s*=\s*true\s*$/m.test(configRaw) || /^\s*codex_hooks\s*=\s*true\s*$/m.test(configRaw)) hooksFeature = "enabled";
  if (/^\s*hooks\s*=\s*false\s*$/m.test(configRaw) || /^\s*codex_hooks\s*=\s*false\s*$/m.test(configRaw)) hooksFeature = "disabled";
  return {
    installed: hooksRaw.includes("wechat-codex"),
    hooksFeature,
    hooksJson: hooksJsonPath(),
    configToml: codexConfigPath(),
  };
}

export function upsertHookTrustState(key: string, currentHash: string): void {
  const file = codexConfigPath();
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const header = `[hooks.state."${tomlStringContent(key)}"]`;
  const block = `${header}\ntrusted_hash = "${tomlStringContent(currentHash)}"`;
  let next = current;
  const escapedHeader = escapeRegExp(header);
  const existingBlock = new RegExp(`${escapedHeader}\\ntrusted_hash\\s*=\\s*"[^"]*"`, "m");
  if (existingBlock.test(next)) {
    next = next.replace(existingBlock, block);
  } else {
    next += `${next.endsWith("\n") || next.length === 0 ? "" : "\n"}\n${block}\n`;
  }
  if (current !== next) {
    if (current) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    writePrivateFile(file, next);
    markHookConfigUpdated();
  }
}

function enableHooksFeature(): boolean {
  const file = codexConfigPath();
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let next = current;
  if (!/^\s*\[features\]\s*$/m.test(next)) {
    next += `${next.endsWith("\n") || next.length === 0 ? "" : "\n"}\n[features]\nhooks = true\n`;
  } else if (/^\s*hooks\s*=\s*(true|false)\s*$/m.test(next)) {
    next = next.replace(/^\s*hooks\s*=\s*(true|false)\s*$/m, "hooks = true");
  } else {
    const lines = next.split("\n");
    const idx = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
    lines.splice(idx + 1, 0, "hooks = true");
    next = lines.join("\n");
  }
  if (current === next) return false;
  if (current) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  writePrivateFile(file, next);
  return true;
}

export function launchdPlist(label = "com.codex.wechat", projectRoot?: string): string {
  const cli = cliEntryPath(projectRoot);
  const logPath = statePath("daemon.log");
  const envPath = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${cli}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${os.homedir()}</string>
    <key>PATH</key><string>${xmlEscape(envPath)}</string>
  </dict>
</dict>
</plist>
`;
}

export function servicePlistPath(label = "com.codex.wechat"): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export interface DesktopHookReadiness {
  platform: NodeJS.Platform;
  status: "ready" | "restart-recommended" | "desktop-not-running" | "app-server-not-found" | "unknown";
  reason: string;
  appServerPid?: number;
  appServerStartedAt?: number;
  hookConfigUpdatedAt?: number;
}

export function desktopHookReadiness(): DesktopHookReadiness {
  const hookConfigUpdatedAt = hookConfigUpdatedAtMs();
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      status: "unknown",
      reason: "Desktop process freshness check is currently implemented for macOS only.",
      hookConfigUpdatedAt,
    };
  }
  const processes = listProcesses();
  const desktopRunning = processes.some((proc) => proc.command.includes("/Applications/Codex.app/Contents/MacOS/Codex"));
  if (!desktopRunning) {
    return {
      platform: process.platform,
      status: "desktop-not-running",
      reason: "Codex Desktop is not running. It will load the hook config on next launch.",
      hookConfigUpdatedAt,
    };
  }
  const appServer = processes
    .filter((proc) => proc.command.includes("/Applications/Codex.app/Contents/Resources/codex app-server"))
    .filter((proc) => proc.command.includes("--analytics-default-enabled"))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!appServer) {
    return {
      platform: process.platform,
      status: "app-server-not-found",
      reason: "Codex Desktop is running, but its main app-server process was not found.",
      hookConfigUpdatedAt,
    };
  }
  if (hookConfigUpdatedAt && appServer.startedAt + 1000 < hookConfigUpdatedAt) {
    return {
      platform: process.platform,
      status: "restart-recommended",
      reason: "Codex Desktop started before the hook/trust config changed, so it may not emit Stop hooks until restarted.",
      appServerPid: appServer.pid,
      appServerStartedAt: appServer.startedAt,
      hookConfigUpdatedAt,
    };
  }
  return {
    platform: process.platform,
    status: "ready",
    reason: "Codex Desktop app-server started after the hook/trust config was last changed.",
    appServerPid: appServer.pid,
    appServerStartedAt: appServer.startedAt,
    hookConfigUpdatedAt,
  };
}

export async function restartCodexDesktop(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("desktop restart is currently supported on macOS only.");
  try {
    execFileSync("osascript", ["-e", 'quit app "Codex"'], { stdio: "ignore" });
  } catch {
    // The app may already be closed.
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stillRunning = listProcesses().some((proc) => proc.command.includes("/Applications/Codex.app/Contents/Resources/codex app-server"));
    if (!stillRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  execFileSync("open", ["-a", "Codex"], { stdio: "ignore" });
}

export function serviceStatus(label = "com.codex.wechat"): { installed: boolean; loaded: boolean; plistPath: string; detail: string } {
  const plistPath = servicePlistPath(label);
  const installed = fs.existsSync(plistPath);
  if (process.platform !== "darwin") return { installed, loaded: false, plistPath, detail: "launchd is macOS only" };
  try {
    const output = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { installed, loaded: true, plistPath, detail: firstMeaningfulLine(output) || "loaded" };
  } catch {
    return { installed, loaded: false, plistPath, detail: "not loaded" };
  }
}

export function installLaunchdService(label = "com.codex.wechat", projectRoot?: string): { plistPath: string; loaded: boolean; detail: string } {
  const plistPath = servicePlistPath(label);
  ensureDir(path.dirname(plistPath));
  writePrivateFile(plistPath, launchdPlist(label, projectRoot));
  if (process.platform !== "darwin") return { plistPath, loaded: false, detail: "launchd is macOS only" };
  const target = `gui/${process.getuid?.() ?? 501}`;
  try {
    execFileSync("launchctl", ["bootout", target, plistPath], { stdio: "ignore" });
  } catch {
    // Not loaded yet.
  }
  try {
    execFileSync("launchctl", ["bootstrap", target, plistPath], { stdio: "ignore" });
    execFileSync("launchctl", ["enable", `${target}/${label}`], { stdio: "ignore" });
    execFileSync("launchctl", ["kickstart", "-k", `${target}/${label}`], { stdio: "ignore" });
    return { plistPath, loaded: true, detail: "loaded" };
  } catch (error) {
    try {
      execFileSync("launchctl", ["load", plistPath], { stdio: "ignore" });
      return { plistPath, loaded: true, detail: "loaded via launchctl load" };
    } catch {
      return { plistPath, loaded: false, detail: String(error) };
    }
  }
}

export function uninstallLaunchdService(label = "com.codex.wechat"): void {
  const plistPath = servicePlistPath(label);
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: "ignore" });
    } catch {
      try {
        execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
      } catch {
        // Not loaded.
      }
    }
  }
  fs.rmSync(plistPath, { force: true });
}

async function readWechatHookMetadata(cwd: string): Promise<{ key: string; currentHash: string; trustStatus: string } | null> {
  const client = await AppServerClient.start();
  try {
    await client.request("initialize", {
      clientInfo: { name: "wechat_codex_hook_trust", title: "WeChat Codex Hook Trust", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    const response = (await client.request("hooks/list", { cwds: [path.resolve(cwd)] })) as {
      data?: Array<{ hooks?: Array<{ key: string; command?: string | null; currentHash: string; trustStatus: string }> }>;
    };
    for (const entry of response.data || []) {
      for (const hook of entry.hooks || []) {
        if (hook.key === `${hooksJsonPath()}:stop:0:0` || (hook.command || "").includes("wechat-codex") || (hook.command || "").includes("hook-post")) {
          return { key: hook.key, currentHash: hook.currentHash, trustStatus: hook.trustStatus };
        }
      }
    }
    return null;
  } finally {
    client.stop();
  }
}

class AppServerClient {
  private nextId = 1;
  private pending = new Map<number, (message: any) => void>();

  private constructor(private readonly proc: ChildProcessWithoutNullStreams) {}

  static async start(): Promise<AppServerClient> {
    const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const client = new AppServerClient(proc);
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id == null) return;
      const resolve = client.pending.get(message.id);
      if (resolve) {
        client.pending.delete(message.id);
        resolve(message);
      }
    });
    return client;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000).unref();
    });
    this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const message = await response;
    if (message.error) throw new Error(JSON.stringify(message.error));
    return message.result;
  }

  notify(method: string, params: unknown): void {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  stop(): void {
    this.proc.kill("SIGTERM");
  }
}

function tomlStringContent(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function latestMtime(files: string[]): number | undefined {
  const times = files
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.statSync(file).mtimeMs);
  return times.length ? Math.max(...times) : undefined;
}

function hookConfigMarkerPath(): string {
  return statePath("hook-config-updated-at");
}

function markHookConfigUpdated(): void {
  writePrivateFile(hookConfigMarkerPath(), `${Date.now()}\n`);
}

function hookConfigUpdatedAtMs(): number | undefined {
  const marker = hookConfigMarkerPath();
  if (fs.existsSync(marker)) {
    const value = Number(fs.readFileSync(marker, "utf8").trim());
    if (Number.isFinite(value) && value > 0) return value;
  }
  return latestMtime([hooksJsonPath(), codexConfigPath()]);
}

function listProcesses(): Array<{ pid: number; startedAt: number; command: string }> {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,lstart=,command="], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parsePsLine)
      .filter((proc): proc is { pid: number; startedAt: number; command: string } => Boolean(proc));
  } catch {
    return [];
  }
}

function parsePsLine(line: string): { pid: number; startedAt: number; command: string } | null {
  const match = /^(\d+)\s+(.{24})\s+(.+)$/.exec(line);
  if (!match) return null;
  const startedAt = Date.parse(match[2]);
  if (!Number.isFinite(startedAt)) return null;
  return { pid: Number(match[1]), startedAt, command: match[3] };
}

function firstMeaningfulLine(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("{") && !line.startsWith("}")) || "";
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
