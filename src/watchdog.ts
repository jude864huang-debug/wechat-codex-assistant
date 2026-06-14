import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "./config.js";
import { heartbeatAgeMs, readDaemonHeartbeat } from "./health.js";
import { desktopHookReadiness, hookStatus, installLaunchdService, servicePlistPath, serviceStatus } from "./hook.js";
import { notifyLocalIssue, clearLocalIssueNotification } from "./local-notify.js";
import { ensureDir, statePath, writePrivateFile } from "./paths.js";
import { StateStore } from "./state.js";

const DAEMON_LABEL = "com.codex.wechat";
const WATCHDOG_LABEL = "com.codex.wechat.watchdog";
const DEFAULT_INTERVAL_SECONDS = 120;
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export interface WatchdogRunResult {
  checkedAt: number;
  actions: string[];
  issues: string[];
  daemonServiceLoaded: boolean;
  watchdogServiceLoaded: boolean;
  heartbeatAgeMs: number | null;
  undeliveredNotices: number;
}

export function watchdogPlist(label = WATCHDOG_LABEL, projectRoot?: string, intervalSeconds = DEFAULT_INTERVAL_SECONDS): string {
  const cli = projectRoot ? path.join(projectRoot, "dist", "cli.js") : process.argv[1] && fs.existsSync(process.argv[1]) ? path.resolve(process.argv[1]) : new URL("./cli.js", import.meta.url).pathname;
  const logPath = statePath("watchdog.log");
  const envPath = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${xmlEscape(cli)}</string><string>watchdog</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${Math.max(30, Math.floor(intervalSeconds))}</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${process.env.HOME || ""}</string>
    <key>PATH</key><string>${xmlEscape(envPath)}</string>
  </dict>
</dict>
</plist>
`;
}

export function installWatchdogService(label = WATCHDOG_LABEL, projectRoot?: string): { plistPath: string; loaded: boolean; detail: string } {
  const plistPath = servicePlistPath(label);
  ensureDir(path.dirname(plistPath));
  writePrivateFile(plistPath, watchdogPlist(label, projectRoot));
  if (process.platform !== "darwin") return { plistPath, loaded: false, detail: "launchd is macOS only" };
  const target = launchdTarget();
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
    return { plistPath, loaded: false, detail: String(error) };
  }
}

export function uninstallWatchdogService(label = WATCHDOG_LABEL): void {
  const plistPath = servicePlistPath(label);
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", launchdTarget(), plistPath], { stdio: "ignore" });
    } catch {
      // Not loaded.
    }
  }
  fs.rmSync(plistPath, { force: true });
}

export function watchdogStatus(label = WATCHDOG_LABEL): { installed: boolean; loaded: boolean; plistPath: string; detail: string } {
  return serviceStatus(label);
}

export function runWatchdog(): WatchdogRunResult {
  const checkedAt = Date.now();
  const actions: string[] = [];
  const issues: string[] = [];
  const config = loadConfig();
  const state = new StateStore();

  const daemonService = serviceStatus(DAEMON_LABEL);
  let daemonServiceLoaded = daemonService.loaded;
  if (!daemonService.loaded) {
    issues.push("daemon service is not loaded");
    notifyLocalIssue("daemon-not-loaded", "Codex Beeper", "后台服务未运行", "已检测到 Codex Beeper daemon 没有 loaded，正在尝试自动拉起。");
    const installed = installLaunchdService(DAEMON_LABEL);
    actions.push(`service install: ${installed.loaded ? "loaded" : installed.detail}`);
    daemonServiceLoaded = installed.loaded;
  } else {
    clearLocalIssueNotification("daemon-not-loaded");
  }

  const heartbeat = readDaemonHeartbeat();
  const age = heartbeatAgeMs(checkedAt, heartbeat);
  if (!heartbeat || age == null || age > HEARTBEAT_STALE_MS) {
    issues.push("daemon heartbeat is stale");
    notifyLocalIssue("daemon-heartbeat-stale", "Codex Beeper", "daemon 心跳异常", "Codex Beeper daemon 心跳已超时，正在尝试重启后台服务。");
    if (daemonServiceLoaded) {
      const kicked = kickstartLaunchdService(DAEMON_LABEL);
      actions.push(`service kickstart: ${kicked.ok ? "ok" : kicked.detail}`);
    }
  } else {
    clearLocalIssueNotification("daemon-heartbeat-stale");
  }

  const hook = hookStatus();
  if (!hook.installed || hook.hooksFeature !== "enabled") {
    issues.push("Stop hook is not installed or enabled");
    notifyLocalIssue("hook-not-ready", "Codex Beeper", "Stop hook 未就绪", "Codex Stop hook 未安装或 hooks feature 未启用，Desktop 完成通知不会进入微信。");
  } else {
    clearLocalIssueNotification("hook-not-ready");
  }

  const desktop = desktopHookReadiness();
  if (desktop.status !== "ready") {
    issues.push(`desktop hook readiness: ${desktop.status}`);
    notifyLocalIssue("desktop-hook-not-ready", "Codex Beeper", "Desktop hook 未就绪", `Codex Desktop hook 状态是 ${desktop.status}。${desktop.reason}`);
  } else {
    clearLocalIssueNotification("desktop-hook-not-ready");
  }

  const owner = config.ownerSenderId || state.ownerSenderId();
  const tokenStatus = owner ? state.getContextTokenStatus(owner) : { stale: false };
  if (owner && tokenStatus.stale) {
    issues.push("owner context token is stale");
    notifyLocalIssue(
      "context-token-stale",
      "Codex Beeper",
      "需要刷新微信会话",
      "微信 iLink context_token 已失效。请给 ClawBot/iLink 发任意消息刷新，刷新后会自动补发未送达通知。",
    );
  } else {
    clearLocalIssueNotification("context-token-stale");
  }

  const undeliveredNotices = state.countUndeliveredNotices();
  if (undeliveredNotices > 0) {
    issues.push(`${undeliveredNotices} undelivered notice(s)`);
    notifyLocalIssue("undelivered-notices", "Codex Beeper", "有通知尚未送达", `当前有 ${undeliveredNotices} 条微信通知未送达。若微信会话已失效，请给 ClawBot/iLink 发任意消息刷新。`);
  } else {
    clearLocalIssueNotification("undelivered-notices");
  }

  state.close();
  return {
    checkedAt,
    actions,
    issues,
    daemonServiceLoaded,
    watchdogServiceLoaded: watchdogStatus().loaded,
    heartbeatAgeMs: age,
    undeliveredNotices,
  };
}

function kickstartLaunchdService(label: string): { ok: boolean; detail: string } {
  if (process.platform !== "darwin") return { ok: false, detail: "launchd is macOS only" };
  try {
    execFileSync("launchctl", ["kickstart", "-k", `${launchdTarget()}/${label}`], { stdio: "ignore" });
    return { ok: true, detail: "ok" };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

function launchdTarget(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
