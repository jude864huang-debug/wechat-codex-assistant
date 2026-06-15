import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultWechatRuntimeFromCodexConfig,
  defaultConfig,
  isUnsupportedServiceTierOverride,
  normalizeAppServerTransportConfig,
  normalizeWechatRuntimeConfig,
  normalizeWechatApprovalConfig,
  normalizeWechatProgressConfig,
  normalizeWechatSecurityConfig,
  sanitizeCodexAppServerConfigOverrides,
} from "../src/config.js";

describe("config sanitization", () => {
  it("removes service tiers rejected by current Codex app-server paths", () => {
    expect(
      sanitizeCodexAppServerConfigOverrides([
        'service_tier="default"',
        "service_tier = 'flex'",
        "model_reasoning_effort=\"medium\"",
      ]),
    ).toEqual(['model_reasoning_effort="medium"']);
  });

  it("detects unsupported service tier overrides", () => {
    expect(isUnsupportedServiceTierOverride('service_tier="default"')).toBe(true);
    expect(isUnsupportedServiceTierOverride('service_tier="flex"')).toBe(true);
    expect(isUnsupportedServiceTierOverride('service_tier="priority"')).toBe(false);
  });

  it("loads default auto app-server transport for old configs", () => {
    const config = defaultConfig();
    expect(config.appServerTransport).toMatchObject({
      mode: "auto",
      fallbackToSpawn: true,
    });
    expect(config.appServerTransport.desktopProxySocket).toContain("app-server-control.sock");
  });

  it("normalizes partial app-server transport config", () => {
    expect(normalizeAppServerTransportConfig({ mode: "desktop-proxy", desktopProxySocket: "~/custom.sock" })).toMatchObject({
      mode: "desktop-proxy",
      fallbackToSpawn: true,
    });
  });

  it("defaults WeChat progress feedback for old configs", () => {
    expect(defaultConfig().wechatProgress).toEqual({
      typingEnabled: true,
      typingKeepaliveMs: 5000,
      heartbeatAfterMs: 300000,
    });
    expect(normalizeWechatProgressConfig({ typingEnabled: false, typingKeepaliveMs: -1, heartbeatAfterMs: 0 })).toEqual({
      typingEnabled: false,
      typingKeepaliveMs: 5000,
      heartbeatAfterMs: 0,
    });
  });

  it("defaults Codex turn timeout for old configs", () => {
    expect(defaultConfig().codexTurnTimeoutMs).toBe(3600000);
  });

  it("defaults WeChat security to owner-only and project-scoped local media sending", () => {
    expect(defaultConfig().wechatSecurity).toEqual({
      ownerOnly: true,
      allowLocalImageSend: true,
      autoSendLocalImages: true,
      allowedMediaRoots: [],
    });
    expect(
      normalizeWechatSecurityConfig({
        ownerOnly: false,
        allowLocalImageSend: true,
        autoSendLocalImages: true,
        allowedMediaRoots: ["~/Pictures", 123],
      }),
    ).toMatchObject({
      ownerOnly: false,
      allowLocalImageSend: true,
      autoSendLocalImages: true,
    });
  });

  it("defaults WeChat approval for old configs", () => {
    expect(defaultConfig().wechatApproval).toEqual({
      enabled: true,
      timeoutMs: 600000,
    });
    expect(normalizeWechatApprovalConfig({ enabled: false, timeoutMs: -1 })).toEqual({
      enabled: false,
      timeoutMs: 600000,
    });
  });

  it("defaults WeChat runtime to the conservative remote posture", () => {
    expect(defaultWechatRuntimeFromCodexConfig("/tmp/definitely-missing-codex-config.toml")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      networkAccess: false,
    });
    expect(normalizeWechatRuntimeConfig({ approvalPolicy: "never", sandbox: "danger-full-access", networkAccess: true })).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      networkAccess: true,
    });
    expect(normalizeWechatRuntimeConfig({ approvalPolicy: "bad", sandbox: "bad", networkAccess: "yes" })).toEqual(defaultConfig().wechatRuntime);
  });

  it("inherits WeChat runtime defaults from Codex config.toml", () => {
    const file = `/tmp/wechat-codex-config-${Date.now()}-${Math.random().toString(16).slice(2)}.toml`;
    try {
      fs.writeFileSync(
        file,
        [
          'approval_policy = "never"',
          'sandbox_mode = "danger-full-access"',
          "",
          "[sandbox_workspace_write]",
          "network_access = false",
        ].join("\n"),
      );
      expect(defaultWechatRuntimeFromCodexConfig(file)).toEqual({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        networkAccess: true,
      });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
