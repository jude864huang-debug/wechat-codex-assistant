import { describe, expect, it } from "vitest";
import {
  approvalForMethod,
  buildAppServerSpawnSpec,
  denialForMethod,
  fallbackForMethod,
  inspectAppServerTransport,
  isWechatApprovableMethod,
  threadRuntimeParams,
  turnSandboxPolicy,
} from "../src/codex-client.js";
import { defaultConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

describe("approval denial mapping", () => {
  it("declines command and file approvals", () => {
    expect(denialForMethod("item/commandExecution/requestApproval")).toEqual({ decision: "decline" });
    expect(denialForMethod("item/fileChange/requestApproval")).toEqual({ decision: "decline" });
  });

  it("declines mcp elicitation and tool input", () => {
    expect(denialForMethod("mcpServer/elicitation/request")).toMatchObject({ action: "decline" });
    expect(denialForMethod("item/tool/requestUserInput")).toEqual({ answers: {} });
  });

  it("declines permission grants by returning no additional permissions", () => {
    expect(denialForMethod("item/permissions/requestApproval")).toEqual({
      permissions: {},
      scope: "turn",
      strictAutoReview: true,
    });
  });

  it("returns protocol-safe fallbacks for non-approval interactions", () => {
    expect(fallbackForMethod("item/tool/call")).toEqual({ contentItems: [], success: false });
    expect(fallbackForMethod("item/tool/requestUserInput")).toEqual({ answers: {} });
    expect(fallbackForMethod("mcpServer/elicitation/request")).toEqual({ action: "decline", content: null, _meta: null });
  });
});

describe("wechat approval mapping", () => {
  it("accepts app-server v2 command and file approval requests", () => {
    expect(approvalForMethod("item/commandExecution/requestApproval")).toEqual({ decision: "accept" });
    expect(approvalForMethod("item/fileChange/requestApproval")).toEqual({ decision: "accept" });
  });

  it("accepts legacy exec and patch approvals", () => {
    expect(approvalForMethod("execCommandApproval")).toEqual({ decision: "approved" });
    expect(approvalForMethod("applyPatchApproval")).toEqual({ decision: "approved" });
  });

  it("returns requested permissions for turn-scoped permission approvals", () => {
    expect(
      approvalForMethod("item/permissions/requestApproval", {
        permissions: {
          network: { mode: "enabled" },
          fileSystem: { mode: "workspace-write" },
        },
      }),
    ).toEqual({
      permissions: {
        network: { mode: "enabled" },
        fileSystem: { mode: "workspace-write" },
      },
      scope: "turn",
      strictAutoReview: true,
    });
  });

  it("only exposes implemented user-decision server requests to WeChat approval", () => {
    expect(isWechatApprovableMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isWechatApprovableMethod("mcpServer/elicitation/request")).toBe(false);
  });
});

describe("app-server transport selection", () => {
  it("uses desktop proxy spawn args when selected", () => {
    const config = testConfig({
      appServerTransport: {
        mode: "desktop-proxy",
        desktopProxySocket: "/tmp/codex-shared.sock",
        fallbackToSpawn: true,
      },
    });

    expect(buildAppServerSpawnSpec(config, "desktop-proxy")).toEqual({
      command: "/usr/local/bin/codex",
      args: ["app-server", "proxy", "--sock", "/tmp/codex-shared.sock"],
      label: "codex app-server proxy",
    });
  });

  it("falls back to spawn when auto proxy socket is missing", () => {
    const status = inspectAppServerTransport(
      testConfig({
        appServerTransport: {
          mode: "auto",
          desktopProxySocket: "/tmp/definitely-missing-codex-proxy.sock",
          fallbackToSpawn: true,
        },
      }),
    );

    expect(status.modeUsed).toBe("spawn");
    expect(status.liveDesktopUpdates).toBe(false);
    expect(status.reason).toContain("falling back to spawn");
  });

  it("does not fall back when proxy is required", () => {
    const status = inspectAppServerTransport(
      testConfig({
        appServerTransport: {
          mode: "desktop-proxy",
          desktopProxySocket: "/tmp/definitely-missing-codex-proxy.sock",
          fallbackToSpawn: false,
        },
      }),
    );

    expect(status.modeUsed).toBe("none");
    expect(status.liveDesktopUpdates).toBe(false);
  });
});

describe("WeChat runtime params", () => {
  it("maps conservative runtime to workspace write turn sandbox", () => {
    const runtime = { approvalPolicy: "on-request" as const, sandbox: "workspace-write" as const, networkAccess: false };
    expect(threadRuntimeParams(runtime)).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(turnSandboxPolicy(runtime, "/tmp/project")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/project"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("maps full access runtime to dangerFullAccess sandbox", () => {
    const runtime = { approvalPolicy: "never" as const, sandbox: "danger-full-access" as const, networkAccess: true };
    expect(threadRuntimeParams(runtime)).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(turnSandboxPolicy(runtime, "/tmp/project")).toEqual({ type: "dangerFullAccess" });
  });
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig(),
    codexBin: "/usr/local/bin/codex",
    ...overrides,
  };
}
