import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir(): string {
  return process.env.CODEX_WECHAT_HOME || path.join(os.homedir(), ".codex-wechat");
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function statePath(name: string): string {
  const dir = stateDir();
  ensureDir(dir);
  return path.join(dir, name);
}

export function writePrivateFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
