import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { desktopLiveUpdateDoctorStatus, inspectAppServerTransport } from "./codex-client.js";
import { configPath, isUnsupportedServiceTierOverride, loadConfig } from "./config.js";
import { codexConfigPath, desktopHookReadiness, hookStatus, serviceStatus } from "./hook.js";
import { heartbeatAgeMs, readDaemonHeartbeat } from "./health.js";
import { loadAccount } from "./wechat.js";
import { StateStore } from "./state.js";

export function doctor(): string {
  const lines: string[] = [];
  const config = loadConfig();
  lines.push("Codex Beeper doctor");
  lines.push(`config: ${fs.existsSync(configPath()) ? "ok" : "missing"} (${configPath()})`);
  try {
    lines.push(`codex: ${execFileSync("codex", ["--version"], { encoding: "utf8" }).trim()}`);
  } catch {
    lines.push("codex: missing");
  }
  try {
    execFileSync("codex", ["app-server", "generate-ts", "--out", "/tmp/codex-beeper-doctor-schema"], { encoding: "utf8" });
    lines.push("app-server schema: ok");
  } catch (error) {
    lines.push(`app-server schema: failed (${String(error)})`);
  }
  const hook = hookStatus();
  lines.push(`hook installed: ${hook.installed ? "yes" : "no"} (${hook.hooksJson})`);
  lines.push(`hooks feature: ${hook.hooksFeature} (${hook.configToml})`);
  const persistedOverrides = persistedCodexOverrides();
  const unsupportedOverrides = persistedOverrides.filter(isUnsupportedServiceTierOverride);
  lines.push(`app-server overrides: ${persistedOverrides.length ? persistedOverrides.join(", ") : "none"}`);
  if (unsupportedOverrides.length) lines.push("action: remove unsupported app-server service_tier overrides from Codex Beeper config");
  const globalServiceTier = globalCodexServiceTier();
  lines.push(`global Codex service_tier: ${globalServiceTier || "unset"}`);
  if (globalServiceTier && ["default", "flex"].includes(globalServiceTier)) {
    lines.push("action: remove global `service_tier` from ~/.codex/config.toml; current Codex rejects default/flex in this path");
  }
  const globalRuntime = globalCodexRuntime();
  lines.push(`global Codex runtime: sandbox=${globalRuntime.sandboxMode || "unset"} approval=${globalRuntime.approvalPolicy || "unset"}`);
  lines.push(
    `wechat runtime: sandbox=${config.wechatRuntime.sandbox} approval=${config.wechatRuntime.approvalPolicy} network=${config.wechatRuntime.networkAccess}`,
  );
  lines.push(
    `wechat security: ownerOnly=${config.wechatSecurity.ownerOnly} allowLocalImageSend=${config.wechatSecurity.allowLocalImageSend} autoSendLocalImages=${config.wechatSecurity.autoSendLocalImages}`,
  );
  if (config.wechatRuntime.sandbox === "danger-full-access" && config.wechatRuntime.approvalPolicy === "never") {
    lines.push("action: review high-risk WeChat runtime; `danger-full-access + never` lets the owner WeChat account run full-access Codex turns remotely");
  }
  if (!config.wechatSecurity.ownerOnly) {
    lines.push("action: ownerOnly is disabled; review every allowlisted sender before publishing or sharing this setup");
  }
  if (config.wechatSecurity.allowedMediaRoots.length) {
    lines.push("action: local image sending has extra allowedMediaRoots; keep them narrow and avoid sensitive project roots");
  }
  if (globalRuntime.sandboxMode === "danger-full-access" && config.wechatRuntime.sandbox !== "danger-full-access") {
    lines.push("note: WeChat-initiated turns are more restricted than Codex Desktop global sandbox_mode");
  }
  if (globalRuntime.approvalPolicy === "never" && config.wechatRuntime.approvalPolicy !== "never") {
    lines.push("note: WeChat-initiated turns may still request WeChat approvals because approvalPolicy differs from global Codex");
  }
  const desktop = desktopHookReadiness();
  lines.push(`desktop hook readiness: ${desktop.status} (${desktop.reason})`);
  if (desktop.status === "restart-recommended") lines.push("action: run `codex-beeper desktop restart` before relying on Desktop completion notifications");
  const appServerTransport = inspectAppServerTransport(config);
  lines.push(
    `desktop live update: ${desktopLiveUpdateDoctorStatus(appServerTransport)} (${appServerTransport.reason}; mode=${appServerTransport.modeUsed})`,
  );
  const service = serviceStatus();
  lines.push(`daemon service: ${service.installed ? "installed" : "missing"}, ${service.loaded ? "loaded" : "not loaded"} (${service.plistPath})`);
  if (!service.loaded) lines.push("action: run `codex-beeper service install` so the WeChat daemon survives logout/crash/reboot");
  const watchdog = serviceStatus("com.codex.wechat.watchdog");
  lines.push(`watchdog service: ${watchdog.installed ? "installed" : "missing"}, ${watchdog.loaded ? "loaded" : "not loaded"} (${watchdog.plistPath})`);
  if (!watchdog.loaded) lines.push("action: run `codex-beeper watchdog install` so daemon failures can be detected and repaired");
  const heartbeat = readDaemonHeartbeat();
  const age = heartbeatAgeMs(Date.now(), heartbeat);
  lines.push(`daemon heartbeat: ${age == null ? "missing" : age > 2 * 60 * 1000 ? `stale, updated ${formatAge(age)} ago` : `ok, updated ${formatAge(age)} ago`}`);
  lines.push(`wechat account: ${loadAccount() ? "ok" : "missing"}`);
  const state = new StateStore();
  const owner = config.ownerSenderId || state.ownerSenderId();
  lines.push(`owner sender: ${owner || "missing"}`);
  if (owner && state.getContextToken(owner)) {
    const tokenStatus = state.getContextTokenStatus(owner);
    const updatedAt = state.getContextTokenUpdatedAt(owner);
    const age = updatedAt ? `, updated ${formatAge(Date.now() - updatedAt)} ago` : "";
    lines.push(`owner context token: ${tokenStatus.stale ? "stale" : "ok"}${age}`);
    if (tokenStatus.stale) {
      lines.push(`action: send any message to ClawBot/iLink from the owner WeChat account to refresh context_token (${tokenStatus.reason || "sendmessage failed"})`);
    }
  } else {
    lines.push("owner context token: missing");
  }
  const undelivered = state.countUndeliveredNotices();
  lines.push(`undelivered notices: ${undelivered}`);
  if (undelivered > 0) lines.push("note: undelivered notices will be retried after the owner refreshes context_token");
  const allowed = state.listAllowed();
  lines.push(`allowlist: ${allowed.length}`);
  if (config.wechatSecurity.ownerOnly && allowed.some((entry) => !entry.isOwner)) {
    lines.push("note: non-owner allowlist entries cannot start WeChat remote Codex turns while ownerOnly=true");
  }
  lines.push(`projects: ${config.projects.length} (${config.autoDiscoverCodexProjects ? "auto-discovery on" : "auto-discovery off"})`);
  if (config.autoDiscoverCodexProjects) lines.push(`project roots: ${config.projectRoots.join(", ")}`);
  for (const project of config.projects) {
    lines.push(`project ${project.alias}: ${fs.existsSync(project.path) ? "ok" : "missing"} ${project.path} ${project.source || "manual"}${project.notifyOnly ? " notifyOnly" : ""}`);
  }
  lines.push("Day 0 gates: run manual spikes before relying on Desktop notifications:");
  lines.push("- Desktop Stop hook payload observed: not recorded by doctor");
  lines.push("- hook session_id/threadId mapping verified: not recorded by doctor");
  lines.push("- app-server-created thread visible in Desktop: not guaranteed");
  lines.push("- concurrent Desktop/daemon resume transcript integrity: not guaranteed");
  state.close();
  return lines.join("\n");
}

function persistedCodexOverrides(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { codexAppServerConfigOverrides?: unknown };
    return Array.isArray(raw.codexAppServerConfigOverrides) ? raw.codexAppServerConfigOverrides.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function globalCodexServiceTier(): string | null {
  try {
    const raw = fs.readFileSync(codexConfigPath(), "utf8");
    const match = /^\s*service_tier\s*=\s*["']?([^"'\n]+)["']?\s*$/m.exec(raw);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function globalCodexRuntime(): { sandboxMode: string | null; approvalPolicy: string | null } {
  try {
    const raw = fs.readFileSync(codexConfigPath(), "utf8");
    return {
      sandboxMode: readTomlString(raw, "sandbox_mode"),
      approvalPolicy: readTomlString(raw, "approval_policy"),
    };
  } catch {
    return { sandboxMode: null, approvalPolicy: null };
  }
}

function readTomlString(raw: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]+)["']?\\s*$`, "m").exec(raw);
  return match?.[1]?.trim() || null;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
