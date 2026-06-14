import { describe, expect, it } from "vitest";
import { markdownToWechatText, splitWechatText, stableHash, summarize } from "../src/text.js";

describe("text helpers", () => {
  it("converts markdown to plain WeChat text and redacts secrets", () => {
    const text = markdownToWechatText("## Title\nUse `code` and [link](https://example.com?token=abc)\nOPENAI sk-abcdefghi");
    expect(text).toContain("Title");
    expect(text).toContain("code");
    expect(text).toContain("link (https://example.com?token=[redacted])");
    expect(text).toContain("sk-[redacted]");
  });

  it("splits long text under limit", () => {
    const chunks = splitWechatText(`${"a".repeat(1900)}\n\n${"b".repeat(50)}`, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("summarizes and hashes stably", () => {
    expect(summarize("hello ".repeat(100), 20)).toHaveLength(20);
    expect(stableHash("x")).toBe(stableHash("x"));
  });
});
