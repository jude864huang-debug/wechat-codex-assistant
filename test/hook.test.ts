import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopHookReadiness, hookStatus, launchdPlist, parseHookPayload, serviceStatus, upsertHookTrustState } from "../src/hook.js";

const cleanup: string[] = [];

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_WECHAT_HOME;
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hook helpers", () => {
  it("parses Stop hook payload", () => {
    const payload = parseHookPayload('{"session_id":"s","turn_id":"t","last_assistant_message":"done"}');
    expect(payload.session_id).toBe("s");
    expect(payload.turn_id).toBe("t");
  });

  it("renders launchd plist", () => {
    expect(launchdPlist("com.test.codex", "/tmp/project")).toContain("com.test.codex");
    expect(launchdPlist("com.test.codex", "/tmp/project")).toContain("cli.js");
  });

  it("reports hook status without throwing", () => {
    expect(hookStatus().hooksJson).toContain("hooks.json");
  });

  it("reports desktop and service readiness without throwing", () => {
    expect(desktopHookReadiness().platform).toBe(process.platform);
    expect(serviceStatus().plistPath).toContain("com.codex.wechat.plist");
  });

  it("upserts hook trust state in config.toml", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-hook-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-state-"));
    cleanup.push(home);
    cleanup.push(stateHome);
    process.env.CODEX_HOME = home;
    process.env.CODEX_WECHAT_HOME = stateHome;

    upsertHookTrustState("/tmp/hooks.json:stop:0:0", "sha256:first");
    upsertHookTrustState("/tmp/hooks.json:stop:0:0", "sha256:second");

    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(config).toContain('[hooks.state."/tmp/hooks.json:stop:0:0"]');
    expect(config).toContain('trusted_hash = "sha256:second"');
    expect(config).not.toContain("sha256:first");
  });
});
