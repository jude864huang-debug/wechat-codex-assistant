import { describe, expect, it } from "vitest";
import { watchdogPlist } from "../src/watchdog.js";

describe("watchdog helpers", () => {
  it("renders a launchd interval job", () => {
    const plist = watchdogPlist("com.test.watchdog", "/tmp/project", 120);
    expect(plist).toContain("com.test.watchdog");
    expect(plist).toContain("<string>watchdog</string><string>run</string>");
    expect(plist).toContain("<key>StartInterval</key><integer>120</integer>");
    expect(plist).toContain("/tmp/project/dist/cli.js");
  });
});
