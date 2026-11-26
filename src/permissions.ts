import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./types.ts";

export interface DetectedPermissionRequest {
  requestedDirs: string[];
  needsFullPerm: boolean;
  excerpt: string;
}

export function normalizeDirPath(rawPath: string, cwd: string): string {
  const cleaned = rawPath.trim().replace(/^["'`(<[]+|[.,;:!?"'`)>\]]+$/g, "");
  if (!cleaned) return "";
  const expanded =
    cleaned === "~"
      ? os.homedir()
      : cleaned.startsWith("~/")
        ? path.join(os.homedir(), cleaned.slice(2))
        : path.resolve(cwd, cleaned);
  return expanded;
}

/**
 * Resolves a path to an existing directory (if given an existing file path, uses its parent dir).
 * Returns undefined if the directory does not exist (so unmounted/missing paths are never passed to CLIs).
 */
export function resolveExistingDir(rawPath: string, cwd: string): string | undefined {
  const normalized = normalizeDirPath(rawPath, cwd);
  if (!normalized) return undefined;
  try {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) return normalized;
    if (stat.isFile()) return path.dirname(normalized);
  } catch {
    // Only fall back to parent dir if the missing path explicitly looks like a file (e.g. new output.tex)
    if (/\.[a-zA-Z][a-zA-Z0-9]{0,7}$/.test(path.basename(normalized))) {
      const parent = path.dirname(normalized);
      try {
        if (parent && parent !== normalized && fs.statSync(parent).isDirectory()) {
          return parent;
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  return undefined;
}

export function isPathInsideDir(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function filterExistingDirs(dirs: string[], cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    const resolved = resolveExistingDir(d, cwd);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

const PERMISSION_TRIGGER_REGEX =
  /(?:read\s+access\s+to|write\s+access\s+to|access\s+to|permission\s+(?:wasn't|was\s+not|not)\s+granted|was\s+blocked|permission\s+denied|not\s+permitted|requires?\s+(?:approval|permission|authorization|access)|grant\s+(?:read|write)?\s*access|outside\s+(?:the\s+)?(?:workspace|sandbox|allowed\s+directories)|blocked\s+by\s+(?:the\s+)?sandbox|cannot\s+(?:read|write|access)\s+outside|need(?:s)?\s+(?:read|write)?\s*access\s+to)/i;

const SHELL_BLOCKED_REGEX =
  /(?:shell\s+(?:copy|command|exec|execution)\b.*(?:blocked|denied|not\s+permitted|not\s+granted)|bash\b.*(?:blocked|denied|not\s+permitted)|command\s+(?:was\s+)?blocked|sandbox\s+blocked\s+command)/i;

/**
 * Inspects an agent response / error text to detect whether the agent hit a
 * headless permission block (either requesting access to an external directory
 * like `/Volumes/ExternalDrive/...` or requesting shell/full permissions).
 */
export function detectPermissionRequest(opts: {
  text: string;
  error?: string;
  cwd: string;
  alreadyAllowedDirs: string[];
  currentPerm: PermissionMode;
}): DetectedPermissionRequest | undefined {
  const combined = [opts.text, opts.error ?? ""].filter(Boolean).join("\n");
  if (!combined.trim()) return undefined;

  const triggerMatch = combined.match(PERMISSION_TRIGGER_REGEX);
  if (!triggerMatch) return undefined;

  // Extract absolute Unix paths mentioned near permission/access language
  const pathCandidates: string[] = [];
  const pathRegex = /(?:^|[\s"'`(])((?:\/[A-Za-z0-9._@+-]+){2,}\/?)/g;
  for (const m of combined.matchAll(pathRegex)) {
    const raw = m[1].replace(/[.,;:!?"'`)>\]]+$/, "");
    if (!raw || raw.startsWith("/dev/") || raw.startsWith("/proc/")) continue;
    pathCandidates.push(raw);
  }

  const allowedRoots = [path.resolve(opts.cwd), ...opts.alreadyAllowedDirs.map((d) => path.resolve(d))];
  const requestedDirs: string[] = [];
  const seen = new Set<string>();

  for (const candidate of pathCandidates) {
    // If the candidate looks like a file (has an extension like .tex/.py/.json), prefer its parent dir
    // unless the path itself is an existing directory.
    let dirPath = candidate.replace(/\/+$/, "");
    try {
      const st = fs.statSync(dirPath);
      if (st.isFile()) dirPath = path.dirname(dirPath);
    } catch {
      if (/\.[a-zA-Z][a-zA-Z0-9]{0,7}$/.test(path.basename(dirPath))) {
        dirPath = path.dirname(dirPath);
      }
    }

    const abs = path.resolve(dirPath);
    if (seen.has(abs)) continue;
    if (allowedRoots.some((root) => isPathInsideDir(abs, root))) continue;
    seen.add(abs);
    requestedDirs.push(abs);
  }

  const needsFullPerm =
    opts.currentPerm !== "full" &&
    (SHELL_BLOCKED_REGEX.test(combined) ||
      (requestedDirs.length === 0 && /permission|blocked|approval|sandbox/i.test(triggerMatch[0])));

  if (requestedDirs.length === 0 && !needsFullPerm) {
    return undefined;
  }

  // Extract the specific line containing the trigger as a short user-facing excerpt
  const lines = combined.split("\n");
  const matchedLine =
    lines.find((l) => PERMISSION_TRIGGER_REGEX.test(l))?.trim() ?? triggerMatch[0];
  const excerpt = matchedLine.length > 140 ? matchedLine.slice(0, 139) + "…" : matchedLine;

  return {
    requestedDirs,
    needsFullPerm,
    excerpt,
  };
}
