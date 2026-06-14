import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractLocalImagePaths, isSupportedImagePath } from "../src/wechat-media.js";

describe("WeChat image media helpers", () => {
  it("detects supported image extensions", () => {
    expect(isSupportedImagePath("/tmp/a.png")).toBe(true);
    expect(isSupportedImagePath("/tmp/a.webp")).toBe(true);
    expect(isSupportedImagePath("/tmp/a.txt")).toBe(false);
  });

  it("extracts existing local image paths from markdown and relative mentions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-image-"));
    const absolute = path.join(dir, "poster.png");
    const relative = path.join(dir, "shot.webp");
    fs.writeFileSync(absolute, "x");
    fs.writeFileSync(relative, "x");

    expect(extractLocalImagePaths(`海报：![poster](${absolute})\n截图：./shot.webp\n不存在：/tmp/nope.png`, dir)).toEqual([absolute, relative]);
  });
});
