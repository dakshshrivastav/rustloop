# rustloop

A Rust workspace feedback loop for [OpenCode](https://opencode.ai) V2.

OpenCode V2 [does not run language servers](https://opencode.ai/docs/migrate-v1) — V1's built-in rust-analyzer is gone, so the agent loses the tight "edit → see compiler errors" loop. `rustloop` restores the **compiler-feedback** part of that loop using only sanctioned V2 plugin surfaces (custom tools + hooks), and adds **workspace awareness** so checks are scoped to the right crate.

It is deliberately *not* a language server: no hover, no goto-definition, no unsaved-buffer analysis. It runs `cargo` and tells the model what the compiler said.

## Features

- **`rust_check` tool** — runs `cargo check --message-format=json --all-targets [-p <crate>]` and returns compact, token-efficient diagnostics: `LEVEL file:line:col [code] message`. Notes, artifact spam, and duplicate lines are filtered; output is capped at 50 lines (`+N more`). Honors the stop signal: cancelling kills cargo instead of leaving it holding the target lock.
- **Post-edit background checks** — after the agent edits/writes/patches a `.rs` file (add, update, or delete), a debounced (750 ms) `cargo check` runs in the background, scoped to the affected member crate. Nothing blocks the agent loop.
- **Context injection** — before each model request, a `[rustloop]` system block carries the workspace crate map and the latest compiler report (with a timestamp), or a "check running" marker. The model sees broken edits immediately, without spending a tool call.
- **Workspace-correct** — checks are keyed by the session's workspace root and scoped to the *most specific* member crate, so nested multi-crate workspaces get the right `-p` flag (not the root package).

## Requirements

- OpenCode V2 (server plugins).
- A Rust toolchain (`cargo` on PATH, or `~/.cargo/bin/cargo`).
- Linux or macOS. **Windows is untested** (process-group cleanup falls back to killing the leader only).
- Node ≥ 26 only if you want to run the unit tests (they use native TypeScript stripping; the plugin itself has **zero runtime dependencies**).

## Install

Clone into the global plugins directory (auto-discovered, no config needed):

```sh
git clone https://github.com/dakshshrivastav/rustloop ~/.config/opencode/plugins/rustloop
```

Or reference it from `opencode.jsonc`:

```jsonc
{
  "plugins": ["./path/to/rustloop"]
}
```

Restart OpenCode (or reload the location) once. Confirm it loaded:

```sh
opencode api get /api/plugin   # look for id "rustloop", state active
```

## Usage

Nothing to configure. Open a session in a Rust workspace and work normally:

- The agent can call `rust_check` (optionally `{ "crate": "<member>" }`).
- After any `.rs` edit, a background check runs and the result is injected into the model's context automatically.
- Outside a Cargo project, everything no-ops.

## How it works

| File | Role |
|---|---|
| `index.ts` | Plugin entry (`{ id, setup }`). Registers the tool, the `execute.after` hook (schedules checks), and the `session.hook("context")` injection. |
| `lib.ts` | Pure, unit-tested helpers: diagnostics parsing, crate-map formatting, edit detection, workspace-root resolution, crate scoping, and an async spawn with timeout + abort + process-group cleanup. |

Design choice: diagnostics arrive via **context injection**, not appended to tool output. Awaiting `cargo` inside a tool hook would block the shared server on a cold build; injection is non-blocking and reaches the model at the same point (the next request).

## Debugging

Plugin `console.log` does **not** reach `opencode.log`. Use the built-in file switch:

```sh
touch ~/.config/opencode/plugins/rustloop/DEBUG   # enable → debug.log beside the plugin
tail -f ~/.config/opencode/plugins/rustloop/debug.log
rm ~/.config/opencode/plugins/rustloop/DEBUG      # disable (checked per call)
```

Logs every hook firing, rust-edit detection, scheduled/finished checks, and context-injection part counts.

## Development

```sh
node --test lib.test.ts   # 16 tests, no install needed
```

`@opencode/plugin` is a **types-only** dev dependency (erased at runtime); `bun install` / `npm install` is optional and only helps editor typing.

## Notes & limitations

- Diagnostics are eventually consistent: a report carries a timestamp and may land on the request after the edit.
- Concurrent cargo invocations wait on the target lock (async — nothing freezes). If you also run an editor's rust-analyzer, set `rust.analyzerTargetDir: true` there so it doesn't share `target/` with the agent's cargo.
- Semantic queries (hover / references / unsaved-buffer diagnostics) are out of scope; a rust-analyzer JSON-RPC bridge would be a separate effort.

## How this differs from existing plugins

- [opencode-diagnostics](https://github.com/rojosinalma/opencode-diagnostics) appends generic per-file syntax checks for many languages. `rustloop` is Rust-specific and workspace-aware (crate maps, correct `-p` scoping in nested workspaces, filtered cargo JSON, non-blocking background checks).
- [opencode-v2-lsp-support](https://github.com/christensenjairus/opencode-v2-lsp-support) and [rust-analyzer-mcp](https://github.com/obvirm/rust-analyzer-mcp) pursue full LSP/semantic integration. `rustloop` intentionally stays a lightweight compiler-feedback loop with no language server.

## License

[GPL-3.0-or-later](LICENSE).
