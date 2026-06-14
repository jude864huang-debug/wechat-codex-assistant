import crypto from "node:crypto";
import { sanitizeText } from "./log.js";

export const WECHAT_TEXT_LIMIT = 1800;

export function stableHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function markdownToWechatText(input: string): string {
  let text = input.replace(/\r\n/g, "\n");
  text = text.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code: string) => `\n${code.trim()}\n`);
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "- ");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/^\s*>+\s?/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return sanitizeText(text.trim());
}

export function summarize(text: string, maxLen = 220): string {
  const compact = markdownToWechatText(text).replace(/\s+/g, " ").trim();
  if (!compact) return "(无文本输出)";
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
}

export function splitWechatText(text: string, limit = WECHAT_TEXT_LIMIT): string[] {
  const clean = markdownToWechatText(text);
  if (clean.length <= limit) return [clean];
  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.35) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.35) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}
