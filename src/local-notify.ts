import fs from "node:fs";
import { spawn } from "node:child_process";
import { statePath } from "./paths.js";

export function notifyLocalIssue(issueKey: string, title: string, subtitle: string, body: string, throttleMs = 30 * 60 * 1000): void {
  if (process.platform !== "darwin") return;
  const marker = statePath(`notify-${safeIssueKey(issueKey)}-at`);
  const now = Date.now();
  try {
    const last = Number(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : 0);
    if (Number.isFinite(last) && now - last < throttleMs) return;
    fs.writeFileSync(marker, `${now}\n`);
  } catch {
    // Best-effort notification throttling only.
  }

  const script = ["display notification", appleScriptString(body), "with title", appleScriptString(title), "subtitle", appleScriptString(subtitle)].join(" ");
  const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
  child.unref();
}

export function clearLocalIssueNotification(issueKey: string): void {
  try {
    fs.rmSync(statePath(`notify-${safeIssueKey(issueKey)}-at`), { force: true });
  } catch {
    // ignore
  }
}

export function notifyLocalContextTokenStale(): void {
  notifyLocalIssue(
    "context-token-stale",
    "Codex Beeper",
    "需要刷新微信会话",
    "微信 iLink context_token 已失效。请给 ClawBot/iLink 发任意消息刷新，否则 Codex 微信通知无法送达。",
  );
}

export function clearLocalContextTokenStaleNotification(): void {
  clearLocalIssueNotification("context-token-stale");
}

function appleScriptString(value: string): string {
  return JSON.stringify(value);
}

function safeIssueKey(issueKey: string): string {
  return issueKey.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "issue";
}
