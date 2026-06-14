import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCodexProjects, mergeProjects, projectAliasFromPath } from "../src/codex-projects.js";
import type { ProjectConfig } from "../src/types.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("codex project discovery", () => {
  it("discovers first-level directories under configured project roots", () => {
    const root = tempDir();
    const project = path.join(root, "My Project");
    const nested = path.join(project, "nested");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    expect(discoverCodexProjects({ projectRoots: [root] })).toEqual([
      { alias: "my-project", path: project, source: "auto" },
    ]);
  });

  it("keeps manual projects and adds discovered aliases without path duplicates", () => {
    const manual: ProjectConfig[] = [{ alias: "app", path: "/tmp/app", source: "manual" }];
    const discovered: ProjectConfig[] = [
      { alias: "app", path: "/tmp/app", source: "auto" },
      { alias: "app", path: "/tmp/other/app", source: "auto" },
    ];

    expect(mergeProjects(manual, discovered)).toEqual([
      { alias: "app", path: "/tmp/app", source: "manual" },
      { alias: "other-app", path: "/tmp/other/app", source: "auto" },
    ]);
  });

  it("normalizes project names into command aliases", () => {
    expect(projectAliasFromPath("/Users/qqk/Documents/AI 票夹")).toBe("ai-票夹");
  });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-projects-"));
  cleanup.push(dir);
  return dir;
}
