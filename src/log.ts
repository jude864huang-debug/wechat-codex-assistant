export function sanitizeText(value: unknown): string {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(
      /(token|bot_token|access_token|refresh_token|api_key|apikey|secret)(["']?\s*[:=]\s*["']?)[^"',\s}&)]+/gi,
      "$1$2[redacted]",
    )
    .replace(/([?&](?:token|access_token|bot_token|key|secret)=)[^&\s)]+/gi, "$1[redacted]");
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "request timeout";
  if (error instanceof Error) return sanitizeText(error.message);
  return sanitizeText(error);
}

export function log(message: string): void {
  process.stderr.write(`[wechat-codex] ${sanitizeText(message)}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[wechat-codex] WARN ${sanitizeText(message)}\n`);
}
