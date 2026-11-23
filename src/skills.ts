import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McliConfig } from "./types.ts";

export interface SkillInfo {
  name: string;
  folderName: string;
  description: string;
  source: string;
  dir: string;
  filePath: string;
  body: string;
  hasScripts: boolean;
  hasReferences: boolean;
}

export function parseSkillFrontmatter(raw: string, fallbackName: string): {
  name: string;
  description: string;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      name: fallbackName,
      description: "",
      body: normalized.trim(),
    };
  }

  const fm = match[1];
  const body = match[2].trim();
  let name = fallbackName;
  let description = "";

  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();

    // Handle multi-line folded/block YAML scalar (> or |)
    if (val === ">" || val === "|" || val === ">-" || val === "|-") {
      const blockLines: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        i++;
        blockLines.push(lines[i].trim());
      }
      val = blockLines.filter(Boolean).join(" ");
    } else {
      val = val.replace(/^["']|["']$/g, "");
    }

    if (key === "name" && val) {
      name = val;
    } else if (key === "description" && val) {
      description = val;
    }
  }

  return { name, description, body };
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

interface SkillRoot {
  dir: string;
  source: string;
}

function getSkillRoots(cwd: string, config?: Pick<McliConfig, "skillDirs">): SkillRoot[] {
  const home = os.homedir();
  const roots: SkillRoot[] = [];

  if (Array.isArray(config?.skillDirs)) {
    for (const custom of config.skillDirs) {
      if (typeof custom === "string" && custom.trim()) {
        roots.push({ dir: expandHome(custom.trim()), source: "custom" });
      }
    }
  }

  // Workspace-level skill directories (highest priority after custom)
  roots.push(
    { dir: path.join(cwd, ".mcli", "skills"), source: "workspace" },
    { dir: path.join(cwd, ".agents", "skills"), source: "workspace" },
    { dir: path.join(cwd, ".agent", "skills"), source: "workspace" },
    { dir: path.join(cwd, ".claude", "skills"), source: "workspace/claude" },
    { dir: path.join(cwd, ".codex", "skills"), source: "workspace/codex" },
    { dir: path.join(cwd, ".kimi", "skills"), source: "workspace/kimi" },
  );

  // User-level skill directories across all supported CLIs
  roots.push(
    { dir: path.join(home, ".mcli", "skills"), source: "mcli" },
    { dir: path.join(home, ".claude", "skills"), source: "claude" },
    { dir: path.join(home, ".codex", "skills"), source: "codex" },
    { dir: path.join(home, ".agents", "skills"), source: "agents" },
    { dir: path.join(home, ".gemini", "antigravity-cli", "skills"), source: "agy" },
    { dir: path.join(home, ".kimi", "skills"), source: "kimi" },
    { dir: path.join(home, ".kimi-code", "skills"), source: "kimi" },
  );

  return roots;
}

function scanSkillDir(rootDir: string, source: string, depth = 0): SkillInfo[] {
  const found: SkillInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return found;
  }

  // Check if rootDir itself contains SKILL.md (only when recursing into a skill folder)
  if (depth > 0) {
    const skillMd = path.join(rootDir, "SKILL.md");
    try {
      if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
        const raw = fs.readFileSync(skillMd, "utf8");
        const folderName = path.basename(rootDir);
        const { name, description, body } = parseSkillFrontmatter(raw, folderName);
        found.push({
          name,
          folderName,
          description,
          source,
          dir: rootDir,
          filePath: skillMd,
          body,
          hasScripts: fs.existsSync(path.join(rootDir, "scripts")),
          hasReferences: fs.existsSync(path.join(rootDir, "references")),
        });
        return found;
      }
    } catch {
      return found;
    }
  }

  if (depth >= 2) return found;

  for (const entry of entries) {
    if (entry.name.startsWith(".") && depth === 0) continue;
    const childPath = path.join(rootDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(childPath).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) {
      found.push(...scanSkillDir(childPath, source, depth + 1));
    }
  }

  return found;
}

/**
 * Discovers skills across Claude, Codex, Agy, Kimi, workspace, and custom dirs.
 * Deduplicates by lowercase skill name (workspace & custom override user-level).
 */
export function discoverSkills(
  cwd: string,
  config?: Pick<McliConfig, "skillDirs">,
): SkillInfo[] {
  const roots = getSkillRoots(cwd, config);
  const seenDirs = new Set<string>();
  const seenNames = new Set<string>();
  const skills: SkillInfo[] = [];

  for (const root of roots) {
    const resolved = path.resolve(root.dir);
    if (seenDirs.has(resolved)) continue;
    seenDirs.add(resolved);

    const inRoot = scanSkillDir(resolved, root.source, 0);
    for (const s of inRoot) {
      const key = s.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      skills.push(s);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveRequestedSkills(
  requestedNames: string[],
  available: SkillInfo[],
): { resolved: SkillInfo[]; missing: string[] } {
  const resolved: SkillInfo[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const raw of requestedNames) {
    const target = raw.trim().toLowerCase();
    if (!target) continue;

    const match =
      available.find((s) => s.name.toLowerCase() === target) ??
      available.find((s) => s.folderName.toLowerCase() === target);

    if (!match) {
      if (!missing.includes(raw.trim())) missing.push(raw.trim());
      continue;
    }

    const key = match.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push(match);
    }
  }

  return { resolved, missing };
}

/**
 * Wraps resolved SKILL.md instructions into a clean prompt block so ANY agent
 * (Claude, Codex, Agy, DeepSeek, Kimi) can execute skills from any other CLI.
 */
export function buildSkillsPromptBlock(skills: SkillInfo[], maxCharsPerSkill = 12000): string {
  if (skills.length === 0) return "";

  const blocks = skills.map((s) => {
    const body =
      s.body.length > maxCharsPerSkill
        ? s.body.slice(0, maxCharsPerSkill) + `\n...[truncated — full file at ${s.filePath}]`
        : s.body;
    const extras: string[] = [];
    if (s.hasScripts) extras.push(`scripts: ${path.join(s.dir, "scripts")}`);
    if (s.hasReferences) extras.push(`references: ${path.join(s.dir, "references")}`);
    const extraLine = extras.length > 0 ? `\nBundled resources: ${extras.join(" | ")}\n` : "\n";

    return [
      `<active_skill name="${s.name}" source="${s.source}" dir="${s.dir}">`,
      extraLine.trim(),
      body,
      `</active_skill>`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    `<active_skills count="${skills.length}">`,
    `Follow the active skill instruction(s) below for this task:`,
    "",
    blocks.join("\n\n"),
    `</active_skills>`,
  ].join("\n");
}

export function prependSkillsToPrompt(prompt: string, skills: SkillInfo[]): string {
  const block = buildSkillsPromptBlock(skills);
  if (!block) return prompt;
  return `${block}\n\n${prompt}`;
}
