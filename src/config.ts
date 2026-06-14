import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCodexProjects, mergeProjects } from "./codex-projects.js";
import { codexHome, statePath, writePrivateFile, readJsonFile } from "./paths.js";
import type {
  AppConfig,
  AppServerTransportConfig,
  AppServerTransportMode,
  ProjectConfig,
  WechatRuntimeApprovalPolicy,
  WechatRuntimeConfig,
  WechatRuntimeSandbox,
} from "./types.js";

export function defaultConfig(): AppConfig {
  return {
    codexBin: process.env.CODEX_BIN || "codex",
    codexAppServerConfigOverrides: [],
    appServerTransport: {
      mode: "auto",
      desktopProxySocket: path.join(codexHome(), "app-server-control", "app-server-control.sock"),
      fallbackToSpawn: true,
    },
    wechatRuntime: defaultWechatRuntimeFromCodexConfig(),
    wechatSecurity: {
      ownerOnly: true,
      allowLocalImageSend: false,
      autoSendLocalImages: false,
      allowedMediaRoots: [],
    },
    notificationThresholdSeconds: 30,
    codexTurnTimeoutMs: 60 * 60 * 1000,
    notifyFallbackEnabled: true,
    autoDiscoverCodexProjects: true,
    projectRoots: [path.join(os.homedir(), "Documents", "My_Projects")],
    projects: [],
    wechatProgress: {
      typingEnabled: true,
      typingKeepaliveMs: 5000,
      heartbeatAfterMs: 5 * 60 * 1000,
    },
    wechatApproval: {
      enabled: true,
      timeoutMs: 10 * 60 * 1000,
    },
    wechat: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      channelVersion: "1.0.2",
    },
  };
}

export function configPath(): string {
  return statePath("config.json");
}

export function loadConfig(): AppConfig {
  const loaded = readJsonFile<Partial<AppConfig>>(configPath());
  const base = defaultConfig();
  if (!loaded) return base;
  const config = {
    ...base,
    ...loaded,
    appServerTransport: normalizeAppServerTransportConfig(loaded.appServerTransport, base.appServerTransport),
    wechatRuntime: normalizeWechatRuntimeConfig(loaded.wechatRuntime, base.wechatRuntime),
    wechatSecurity: normalizeWechatSecurityConfig(loaded.wechatSecurity, base.wechatSecurity),
    codexAppServerConfigOverrides: sanitizeCodexAppServerConfigOverrides(
      Array.isArray(loaded.codexAppServerConfigOverrides) ? loaded.codexAppServerConfigOverrides : base.codexAppServerConfigOverrides,
    ),
    projectRoots: Array.isArray(loaded.projectRoots) ? loaded.projectRoots.map(resolveUserPath) : base.projectRoots,
    codexTurnTimeoutMs: nonNegativeNumber(loaded.codexTurnTimeoutMs, base.codexTurnTimeoutMs),
    wechatProgress: normalizeWechatProgressConfig(loaded.wechatProgress, base.wechatProgress),
    wechatApproval: normalizeWechatApprovalConfig(loaded.wechatApproval, base.wechatApproval),
    wechat: { ...base.wechat, ...(loaded.wechat || {}) },
    projects: Array.isArray(loaded.projects) ? loaded.projects.map((project) => ({ ...project, source: project.source || "manual" })) : [],
  };
  return {
    ...config,
    projects: config.autoDiscoverCodexProjects ? mergeProjects(config.projects, discoverCodexProjects({ projectRoots: config.projectRoots })) : config.projects,
  };
}

export function sanitizeCodexAppServerConfigOverrides(overrides: string[]): string[] {
  return overrides.filter((override) => !isUnsupportedServiceTierOverride(override));
}

export function isUnsupportedServiceTierOverride(override: string): boolean {
  return /^\s*service_tier\s*=\s*["']?(default|flex)["']?\s*$/i.test(override.trim());
}

export function normalizeAppServerTransportConfig(input: unknown, fallback = defaultConfig().appServerTransport): AppServerTransportConfig {
  const raw = isRecord(input) ? input : {};
  const mode = isAppServerTransportMode(raw.mode) ? raw.mode : fallback.mode;
  const socket =
    typeof raw.desktopProxySocket === "string" && raw.desktopProxySocket.trim()
      ? resolveUserPath(raw.desktopProxySocket.trim())
      : fallback.desktopProxySocket;
  const fallbackToSpawn = typeof raw.fallbackToSpawn === "boolean" ? raw.fallbackToSpawn : fallback.fallbackToSpawn;
  return { mode, desktopProxySocket: socket, fallbackToSpawn };
}

export function normalizeWechatRuntimeConfig(input: unknown, fallback = defaultConfig().wechatRuntime): WechatRuntimeConfig {
  const raw = isRecord(input) ? input : {};
  return {
    approvalPolicy: isWechatRuntimeApprovalPolicy(raw.approvalPolicy) ? raw.approvalPolicy : fallback.approvalPolicy,
    sandbox: isWechatRuntimeSandbox(raw.sandbox) ? raw.sandbox : fallback.sandbox,
    networkAccess: typeof raw.networkAccess === "boolean" ? raw.networkAccess : fallback.networkAccess,
  };
}

export function normalizeWechatSecurityConfig(input: unknown, fallback = defaultConfig().wechatSecurity): AppConfig["wechatSecurity"] {
  const raw = isRecord(input) ? input : {};
  return {
    ownerOnly: typeof raw.ownerOnly === "boolean" ? raw.ownerOnly : fallback.ownerOnly,
    allowLocalImageSend: typeof raw.allowLocalImageSend === "boolean" ? raw.allowLocalImageSend : fallback.allowLocalImageSend,
    autoSendLocalImages: typeof raw.autoSendLocalImages === "boolean" ? raw.autoSendLocalImages : fallback.autoSendLocalImages,
    allowedMediaRoots: Array.isArray(raw.allowedMediaRoots)
      ? raw.allowedMediaRoots.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map(resolveUserPath)
      : fallback.allowedMediaRoots,
  };
}

export function defaultWechatRuntimeFromCodexConfig(configTomlPath = path.join(codexHome(), "config.toml")): WechatRuntimeConfig {
  const fallback: WechatRuntimeConfig = {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    networkAccess: false,
  };
  let raw = "";
  try {
    raw = fs.readFileSync(configTomlPath, "utf8");
  } catch {
    return fallback;
  }

  const approvalPolicy = readTomlString(raw, "approval_policy");
  const sandbox = readTomlString(raw, "sandbox_mode");
  const workspaceNetwork = readTomlBoolean(raw, "network_access", "sandbox_workspace_write");
  const runtime: WechatRuntimeConfig = {
    approvalPolicy: isWechatRuntimeApprovalPolicy(approvalPolicy) ? approvalPolicy : fallback.approvalPolicy,
    sandbox: isWechatRuntimeSandbox(sandbox) ? sandbox : fallback.sandbox,
    networkAccess: typeof workspaceNetwork === "boolean" ? workspaceNetwork : fallback.networkAccess,
  };
  if (runtime.sandbox === "danger-full-access") runtime.networkAccess = true;
  return runtime;
}

export function normalizeWechatProgressConfig(input: unknown, fallback = defaultConfig().wechatProgress): AppConfig["wechatProgress"] {
  const raw = isRecord(input) ? input : {};
  return {
    typingEnabled: typeof raw.typingEnabled === "boolean" ? raw.typingEnabled : fallback.typingEnabled,
    typingKeepaliveMs: positiveNumber(raw.typingKeepaliveMs, fallback.typingKeepaliveMs),
    heartbeatAfterMs: nonNegativeNumber(raw.heartbeatAfterMs, fallback.heartbeatAfterMs),
  };
}

export function normalizeWechatApprovalConfig(input: unknown, fallback = defaultConfig().wechatApproval): AppConfig["wechatApproval"] {
  const raw = isRecord(input) ? input : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    timeoutMs: positiveNumber(raw.timeoutMs, fallback.timeoutMs),
  };
}

export function saveConfig(config: AppConfig, options: { persistWechatRuntime?: boolean } = {}): void {
  const persisted: Partial<AppConfig> = {
    ...config,
    appServerTransport: normalizeAppServerTransportConfig(config.appServerTransport),
    codexAppServerConfigOverrides: sanitizeCodexAppServerConfigOverrides(config.codexAppServerConfigOverrides),
    projects: config.projects
      .filter((project) => project.source !== "auto")
      .map(({ source: _source, ...project }) => project),
  };
  if (options.persistWechatRuntime || persistedConfigHasWechatRuntime()) {
    persisted.wechatRuntime = normalizeWechatRuntimeConfig(config.wechatRuntime);
  } else {
    delete persisted.wechatRuntime;
  }
  writePrivateFile(configPath(), `${JSON.stringify(persisted, null, 2)}\n`);
}

export function ensureConfig(): AppConfig {
  const file = configPath();
  if (!fs.existsSync(file)) saveConfig(defaultConfig());
  return loadConfig();
}

export function getProject(config: AppConfig, alias?: string): ProjectConfig | undefined {
  if (!alias) return undefined;
  return config.projects.find((project) => project.alias === alias);
}

export function setProjectRoots(config: AppConfig, roots: string[]): AppConfig {
  return {
    ...config,
    projectRoots: uniquePaths(roots.map(resolveUserPath)),
  };
}

export function addProjectRoot(config: AppConfig, root: string): AppConfig {
  return setProjectRoots(config, [...config.projectRoots, root]);
}

export function removeProjectRoot(config: AppConfig, root: string): AppConfig {
  const normalized = resolveUserPath(root);
  return {
    ...config,
    projectRoots: config.projectRoots.filter((projectRoot) => resolveUserPath(projectRoot) !== normalized),
  };
}

export function upsertProject(config: AppConfig, project: ProjectConfig): AppConfig {
  const resolved: ProjectConfig = {
    ...project,
    path: resolveUserPath(project.path),
    source: "manual",
  };
  const next = { ...config, projects: config.projects.filter((p) => p.alias !== project.alias) };
  next.projects.push(resolved);
  next.projects.sort((a, b) => a.alias.localeCompare(b.alias));
  return next;
}

export function removeProject(config: AppConfig, alias: string): AppConfig {
  return { ...config, projects: config.projects.filter((project) => project.alias !== alias) };
}

export function matchProjectByCwd(config: AppConfig, cwd?: string): ProjectConfig | undefined {
  if (!cwd) return undefined;
  const normalized = path.resolve(cwd);
  return [...config.projects]
    .sort((a, b) => b.path.length - a.path.length)
    .find((project) => normalized === path.resolve(project.path) || normalized.startsWith(`${path.resolve(project.path)}${path.sep}`));
}

export function resolveUserPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function persistedConfigHasWechatRuntime(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    return Object.hasOwn(raw, "wechatRuntime");
  } catch {
    return false;
  }
}

function isAppServerTransportMode(value: unknown): value is AppServerTransportMode {
  return value === "auto" || value === "desktop-proxy" || value === "spawn";
}

function isWechatRuntimeApprovalPolicy(value: unknown): value is WechatRuntimeApprovalPolicy {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function isWechatRuntimeSandbox(value: unknown): value is WechatRuntimeSandbox {
  return value === "workspace-write" || value === "danger-full-access";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTomlString(raw: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]+)["']?\\s*$`, "m").exec(raw);
  return match?.[1]?.trim() || null;
}

function readTomlBoolean(raw: string, key: string, section?: string): boolean | null {
  const source = section ? tomlSection(raw, section) : raw;
  if (!source) return null;
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, "m").exec(source);
  return match ? match[1] === "true" : null;
}

function tomlSection(raw: string, section: string): string | null {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$)`, "m").exec(raw);
  return match?.[1] || null;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
