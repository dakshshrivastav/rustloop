import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Filter cargo --message-format=json stdout to compact error/warning lines. */
export function parseCargoDiagnostics(stdout: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (msg?.reason !== "compiler-message") continue;
    const m = msg.message;
    if (!m || (m.level !== "error" && m.level !== "warning")) continue;
    const span = Array.isArray(m.spans)
      ? (m.spans.find((s: any) => s.is_primary) ?? m.spans[0])
      : undefined;
    const loc = span ? `${span.file_name}:${span.line_start}:${span.column_start}` : "unknown";
    const code = m.code?.code ? `[${m.code.code}] ` : "";
    const line = `${String(m.level).toUpperCase()} ${loc} ${code}${m.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    total++;
    if (lines.length < 50) lines.push(line);
  }
  if (total === 0) return "OK: 0 compiler errors or warnings.";
  if (total > 50) lines.push(`+${total - 50} more`);
  return lines.join("\n");
}

/** Compact workspace map from `cargo metadata --no-deps --format-version=1`. */
export function formatCrateMap(metadata: any): string {
  const root = metadata?.workspace_root ?? "";
  const pkgs = Array.isArray(metadata?.packages) ? metadata.packages : [];
  const names = new Set(pkgs.map((p: any) => p.name));
  const rows = pkgs.map((p: any) => {
    const rel = relative(root, dirname(p.manifest_path)) || ".";
    return `- ${p.name} → ${rel}`;
  });
  const edges: string[] = [];
  for (const p of pkgs) {
    for (const d of p.dependencies ?? []) {
      if (names.has(d.name)) edges.push(`${p.name} → ${d.name}`);
    }
  }
  const n = pkgs.length;
  return `Rust workspace (${n} crate${n === 1 ? "" : "s"}):\n${rows.join("\n")}\ninternal deps: ${edges.length ? edges.join(", ") : "none"}`;
}

/** True when a completed edit/write/patch call touched a .rs file (add/update/delete). */
export function isRustEdit(tool: string, input: unknown): boolean {
  if (tool === "edit" || tool === "write") {
    const p = (input as any)?.path ?? (input as any)?.filePath;
    return typeof p === "string" && p.endsWith(".rs");
  }
  if (tool === "patch") {
    const t = (input as any)?.patchText;
    return typeof t === "string" && /\*\*\* (Update|Add|Delete) File: [^\n]*\.rs/.test(t);
  }
  return false;
}

/** Nearest ancestor directory (inclusive) containing Cargo.toml, or null. */
export function findCargoRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "Cargo.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Canonical state key for a post-edit check: the SESSION workspace root when one
 * exists (so scheduling and context injection agree), else the edited file's own
 * nearest Cargo root. Without this, member-crate edits key state under the member
 * dir while injection reads the workspace dir — reports would never surface.
 */
export function editCheckRoot(locationDir: string, absFile?: string): string | null {
  return findCargoRoot(locationDir) ?? (absFile ? findCargoRoot(dirname(absFile)) : null);
}

/** Workspace member whose manifest directory contains filePath — MOST SPECIFIC match wins
 *  (a root package's dir prefixes every member; first-match would pick the wrong crate). */
export function crateForFile(root: string, filePath: string, metadata: any): string | undefined {
  const pkgs = Array.isArray(metadata?.packages) ? metadata.packages : [];
  let bestName: string | undefined;
  let bestLen = -1;
  for (const p of pkgs) {
    if (typeof p.manifest_path !== "string") continue;
    const dir = dirname(p.manifest_path);
    if ((filePath === dir || filePath.startsWith(dir + sep)) && dir.length > bestLen) {
      bestLen = dir.length;
      bestName = p.name;
    }
  }
  return bestName;
}

export interface SpawnOptions {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  registry?: Set<ChildProcess>;
}
export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** Kill a spawned child AND its descendants. On Unix the child is a process-group
 *  leader (detached), so signalling -pid reaps cargo's rustc children too — they
 *  would otherwise orphan and keep writing to target/. Windows falls back to the leader. */
export function killProcessGroup(child: ChildProcess): void {
  if (process.platform === "win32" || child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/** Async spawn with timeout + abort support; never rejects. Kills the child on timeout/abort
 *  so a stopped tool call cannot leave cargo holding the target lock. */
export function spawnCaptured(cmd: string, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: process.platform !== "win32" });
    opts.registry?.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      opts.registry?.delete(child);
      resolve({ stdout, stderr, code, timedOut, aborted });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, opts.timeout);
    const onAbort = () => {
      aborted = true;
      killProcessGroup(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        aborted = true;
        killProcessGroup(child);
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}
