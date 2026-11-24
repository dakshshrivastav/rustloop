/**
 * rustloop — Rust workspace feedback loop for OpenCode V2.
 * See README.md beside this file for history, decisions, and maintenance notes.
 * Plain {id, setup} export: Plugin.define is identity, so no SDK dependency needed.
 */
import { type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCargoDiagnostics,
  formatCrateMap,
  isRustEdit,
  findCargoRoot,
  crateForFile,
  editCheckRoot,
  spawnCaptured,
  killProcessGroup,
} from "./lib.ts";
import type { Plugin } from "@opencode/plugin";

const CHECK_TIMEOUT = 120_000;
const META_TIMEOUT = 30_000;
const DEBOUNCE_MS = 750;

// Debug switch: `touch DEBUG` beside this file to log hook/check activity to debug.log.
// Plugin console.log does NOT reach opencode.log — file logging is the reliable channel.
const HERE = dirname(fileURLToPath(import.meta.url));
const debugOn = () => existsSync(join(HERE, "DEBUG"));
const dbg = (m: string) => {
  try {
    if (!debugOn()) return;
    appendFileSync(join(HERE, "debug.log"), `${new Date().toISOString()} ${m}\n`);
  } catch {}
};

// The shared server may predate the rustup install; its PATH can lack ~/.cargo/bin.
const CARGO = existsSync(join(homedir(), ".cargo/bin/cargo"))
  ? join(homedir(), ".cargo/bin/cargo")
  : "cargo";

const children = new Set<ChildProcess>();

interface RootState {
  meta?: any;
  map?: string;
  report?: { text: string; at: number; crate?: string };
  checking: boolean;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  pendingFile?: string;
}
const state = new Map<string, RootState>();
const getState = (root: string): RootState => {
  let s = state.get(root);
  if (!s) {
    s = { checking: false, dirty: false };
    state.set(root, s);
  }
  return s;
};

function spawnCargo(args: string[], cwd: string, timeout: number, signal?: AbortSignal) {
  return spawnCaptured(CARGO, args, {
    cwd,
    timeout,
    signal,
    env: { ...process.env, PATH: `${homedir()}/.cargo/bin${sep}${process.env.PATH ?? ""}` },
    registry: children,
  });
}

async function refreshMap(root: string) {
  try {
    const res = await spawnCargo(["metadata", "--no-deps", "--format-version=1"], root, META_TIMEOUT);
    dbg(`refreshMap root=${root} code=${res.code}`);
    if (res.code === 0) {
      const s = getState(root);
      s.meta = JSON.parse(res.stdout);
      s.map = formatCrateMap(s.meta);
    }
  } catch (e) {
    dbg(`refreshMap error ${String(e)}`);
  }
}

async function runCheck(root: string) {
  const s = getState(root);
  dbg(`runCheck root=${root} checking=${s.checking}`);
  if (s.checking) {
    s.dirty = true;
    return;
  }
  s.checking = true;
  const file = s.pendingFile;
  s.pendingFile = undefined;
  try {
    const crate = file && s.meta ? crateForFile(root, file, s.meta) : undefined;
    const args = ["check", "--message-format=json", "--all-targets"];
    if (crate) args.push("-p", crate);
    const res = await spawnCargo(args, root, CHECK_TIMEOUT);
    const text = res.timedOut
      ? `cargo check timed out after ${CHECK_TIMEOUT / 1000}s`
      : parseCargoDiagnostics(res.stdout);
    s.report = { text, at: Date.now(), crate };
    dbg(`report root=${root} crate=${crate ?? "workspace"} -> ${text.split("\n")[0]}`);
  } catch (e) {
    dbg(`runCheck error ${String(e)}`);
    getState(root).report = { text: `check failed: ${String(e)}`, at: Date.now() };
  } finally {
    const st = getState(root);
    st.checking = false;
    if (st.dirty) {
      st.dirty = false;
      void runCheck(root);
    }
  }
}

function scheduleCheck(root: string, file?: string) {
  const s = getState(root);
  if (file) s.pendingFile = file;
  if (s.timer) clearTimeout(s.timer);
  dbg(`scheduleCheck root=${root} file=${file}`);
  s.timer = setTimeout(() => {
    s.timer = undefined;
    void runCheck(root);
  }, DEBOUNCE_MS);
}

export default {
  id: "rustloop",
  async setup(ctx: any) {
    const locationDir: string = ctx.location.directory;
    dbg(`setup location=${locationDir}`);
    const initialRoot = findCargoRoot(locationDir);
    if (initialRoot) void refreshMap(initialRoot);

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "rust_check",
        description:
          "Run cargo check in the session's Rust workspace and return compact compiler diagnostics (errors/warnings only, file:line:col [code] message).",
        input: {
          type: "object",
          properties: {
            crate: { type: "string", description: "Optional workspace member crate to check (-p <crate>)" },
          },
          additionalProperties: false,
        },
        async execute(input: any, context: any) {
          // Reading context.signal opts into cooperative stop: on user-stop the
          // spawned cargo is killed instead of holding the target lock for 120s.
          const signal: AbortSignal | undefined = context?.signal;
          const root = findCargoRoot(locationDir);
          if (!root) return { content: "No Cargo.toml found at or above the session directory." };
          const args = ["check", "--message-format=json", "--all-targets"];
          const crate = input?.crate ? String(input.crate) : undefined;
          if (crate) args.push("-p", crate);
          const res = await spawnCargo(args, root, CHECK_TIMEOUT, signal);
          if (res.aborted) return { content: "cargo check aborted." };
          if (res.timedOut) return { content: `cargo check timed out after ${CHECK_TIMEOUT / 1000}s` };
          const text = parseCargoDiagnostics(res.stdout);
          const content =
            res.code !== 0 && text.startsWith("OK:")
              ? `${text}\ncargo exited ${res.code}: ${res.stderr.slice(-500)}`
              : text;
          // Keep the injected compiler state the single source of truth.
          getState(root).report = { text: content, at: Date.now(), crate };
          return { content };
        },
      });
    });

    await ctx.tool.hook("execute.after", (event: any) => {
      // Lazy: never stringify tool input unless debugging (write inputs can be MBs).
      if (debugOn()) dbg(`execute.after tool=${event.tool} status=${event.status} input=${JSON.stringify(event.input).slice(0, 200)}`);
      if (event.status !== "completed") return;
      const input = event.input;
      const p = input?.path ?? input?.filePath;
      if (isRustEdit(event.tool, input)) {
        const abs = typeof p === "string" ? resolve(locationDir, p) : undefined;
        // Canonical key = session workspace root, so injection finds the report
        // even for nested member crates (C1).
        const root = editCheckRoot(locationDir, abs);
        dbg(`rust edit detected abs=${abs} root=${root}`);
        if (root) scheduleCheck(root, abs);
      }
      if ((event.tool === "edit" || event.tool === "write") && typeof p === "string" && p.endsWith("Cargo.toml")) {
        const root = editCheckRoot(locationDir, resolve(locationDir, p));
        if (root) void refreshMap(root);
      }
    });

    await ctx.session.hook("context", (event: any) => {
      const root = findCargoRoot(locationDir);
      if (!root) return;
      const s = state.get(root);
      const parts: string[] = [];
      if (s?.map) parts.push(s.map);
      if (s?.checking) parts.push("cargo check running after a recent edit; results pending.");
      else if (s?.report) {
        parts.push(
          `compiler state (${new Date(s.report.at).toISOString()}${s.report.crate ? `, -p ${s.report.crate}` : ""}):\n${s.report.text}`,
        );
      }
      dbg(`context hook root=${root} parts=${parts.length}`);
      if (!parts.length) return;
      event.system.push({ type: "text", text: "[rust-dev]\n" + parts.join("\n") });
    });

    return () => {
      for (const s of state.values()) if (s.timer) clearTimeout(s.timer);
      for (const c of children) killProcessGroup(c);
    };
  },
} satisfies Plugin;
