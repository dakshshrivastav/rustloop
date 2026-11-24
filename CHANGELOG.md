# Changelog

## 0.1.0

Initial release.

- `rust_check` tool: filtered `cargo check --message-format=json` diagnostics (error/warning, primary span, deduped, capped), optional `-p <crate>`, stop-signal aware.
- Post-edit background checks: debounced, crate-scoped, non-blocking; covers edit/write/patch (add/update/delete) on `.rs`.
- Context injection: workspace crate map + timestamped compiler report before each model request.
- Workspace-correct keying and most-specific crate scoping for nested multi-crate workspaces.
- Process-group cleanup on timeout/abort/unload so cargo's rustc children can't orphan and hold the target lock.
- Zero runtime dependencies; `@opencode/plugin` used types-only.
- 16 unit tests (`node --test`), Linux/macOS. Windows untested.
