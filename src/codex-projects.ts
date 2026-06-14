import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig } from "./types.js";

export interface DiscoveryOptions {
  projectRoots?: string[];
  maxProjects?: number;
}

export function discoverCodexProjects(options: DiscoveryOptions = {}): ProjectConfig[] {
  const projectRoots = options.projectRoots || [path.join(os.homedir(), "Documents", "My_Projects")];
  const maxProjects = options.maxProjects ?? 300;

  const aliases = new Set<string>();
  return projectDirectories(projectRoots)
    .slice(0, maxProjects)
    .map(({ projectPath }) => ({
      alias: uniqueAlias(projectPath, aliases),
      path: projectPath,
      source: "auto" as const,
    }));
}

export function mergeProjects(configured: ProjectConfig[], discovered: ProjectConfig[]): ProjectConfig[] {
  const normalizedConfiguredPaths = new Set(configured.map((project) => path.resolve(project.path)));
  const aliases = new Set(configured.map((project) => project.alias));
  const merged: ProjectConfig[] = configured.map((project) => ({ ...project, path: path.resolve(project.path), source: project.source || "manual" }));
  for (const project of discovered) {
    if (normalizedConfiguredPaths.has(path.resolve(project.path))) continue;
    const alias = aliases.has(project.alias) ? uniqueAlias(project.path, aliases) : project.alias;
    aliases.add(alias);
    merged.push({ ...project, alias });
  }
  return merged.sort((a, b) => a.alias.localeCompare(b.alias));
}

export function projectAliasFromPath(projectPath: string): string {
  const base = path.basename(path.resolve(projectPath)) || path.resolve(projectPath).replace(/[/:]+/g, "-");
  const normalized = base
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "project";
}

function uniqueAlias(projectPath: string, used: Set<string>): string {
  const base = projectAliasFromPath(projectPath);
  let candidate = base;
  const parent = projectAliasFromPath(path.dirname(projectPath));
  if (used.has(candidate) && parent && parent !== "project") candidate = `${parent}-${base}`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function projectDirectories(projectRoots: string[]): Array<{ projectPath: string }> {
  const result: Array<{ projectPath: string }> = [];
  for (const root of projectRoots.map((projectRoot) => path.resolve(projectRoot))) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      result.push({ projectPath: path.join(root, entry.name) });
    }
  }
  return result;
}
