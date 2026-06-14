#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);
const IGNORED_FILES = new Set(["package-lock.json"]);
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

const PATTERNS = [
  { name: "OpenAI key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "Bearer token", regex: /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g },
  { name: "generic secret assignment", regex: /\b(?:access_token|refresh_token|api_key|apikey|bot_token|secret)\s*[:=]\s*["'][^"']{12,}["']/gi },
];

const findings = [];

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (IGNORED_FILES.has(path.basename(file))) continue;
  if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${rel}:${line} ${pattern.name}`);
    }
  }
}

if (findings.length) {
  console.error("Potential secrets found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("No obvious secrets found.");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
