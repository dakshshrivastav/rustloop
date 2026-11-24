import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCargoDiagnostics,
  formatCrateMap,
  isRustEdit,
  findCargoRoot,
  crateForFile,
} from "./lib.ts";
import * as lib from "./lib.ts";

// Hand-built cargo --message-format=json fixtures (input data, not expectations).
const err = {
  reason: "compiler-message",
  message: {
    level: "error",
    message: "mismatched types",
    code: { code: "E0308", explanation: null },
    spans: [
      { file_name: "src/main.rs", line_start: 2, column_start: 13, is_primary: true, label: "expected `i32`, found `&str`" },
    ],
    children: [],
    rendered: "error[E0308]: mismatched types\n --> src/main.rs:2:13\n",
  },
};
const warn = {
  reason: "compiler-message",
  message: {
    level: "warning",
    message: "unused variable: `x`",
    code: null,
    spans: [{ file_name: "src/lib.rs", line_start: 10, column_start: 5, is_primary: true }],
    children: [],
    rendered: "warning: unused variable: `x`\n",
  },
};
const note = {
  reason: "compiler-message",
  message: {
    level: "note",
    message: "expected type `i32`",
    code: null,
    spans: [{ file_name: "src/main.rs", line_start: 2, column_start: 13, is_primary: true }],
    children: [],
    rendered: "note: expected type `i32`\n",
  },
};
const artifact = { reason: "compiler-artifact", package_id: "demo 0.1.0", target: { name: "demo" }, filenames: [] };

test("parseCargoDiagnostics keeps errors+warnings with primary span, drops notes/artifacts/garbage", () => {
  const stdout = [JSON.stringify(err), JSON.stringify(warn), JSON.stringify(note), JSON.stringify(artifact), "Blocking waiting for file lock"].join("\n");
  assert.equal(
    parseCargoDiagnostics(stdout),
    "ERROR src/main.rs:2:13 [E0308] mismatched types\nWARNING src/lib.rs:10:5 unused variable: `x`",
  );
});

test("parseCargoDiagnostics reports OK when nothing survives filtering", () => {
  assert.equal(parseCargoDiagnostics(""), "OK: 0 compiler errors or warnings.");
  assert.equal(parseCargoDiagnostics(JSON.stringify(note) + "\n" + JSON.stringify(artifact)), "OK: 0 compiler errors or warnings.");
});

test("parseCargoDiagnostics uses the primary span, not the first span", () => {
  const e = structuredClone(err);
  e.message.spans = [
    { file_name: "macro.rs", line_start: 1, column_start: 1, is_primary: false },
    { file_name: "src/main.rs", line_start: 5, column_start: 9, is_primary: true },
  ];
  assert.equal(parseCargoDiagnostics(JSON.stringify(e)), "ERROR src/main.rs:5:9 [E0308] mismatched types");
});

test("parseCargoDiagnostics falls back to unknown location when no spans", () => {
  const e = structuredClone(err);
  e.message.spans = [];
  assert.equal(parseCargoDiagnostics(JSON.stringify(e)), "ERROR unknown [E0308] mismatched types");
});

test("parseCargoDiagnostics deduplicates identical diagnostics", () => {
  const stdout = [JSON.stringify(err), JSON.stringify(err)].join("\n");
  assert.equal(parseCargoDiagnostics(stdout), "ERROR src/main.rs:2:13 [E0308] mismatched types");
});

test("parseCargoDiagnostics caps at 50 lines and reports the remainder", () => {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    const e = structuredClone(err);
    e.message.spans = [{ file_name: `src/f${i}.rs`, line_start: 1, column_start: 1, is_primary: true }];
    lines.push(JSON.stringify(e));
  }
  const out = parseCargoDiagnostics(lines.join("\n")).split("\n");
  assert.equal(out.length, 51);
  assert.equal(out[50], "+10 more");
  assert.equal(out[0], "ERROR src/f0.rs:1:1 [E0308] mismatched types");
});

const meta = {
  workspace_root: "/ws",
  packages: [
    { name: "folio-core", manifest_path: "/ws/crates/core/Cargo.toml", dependencies: [] },
    { name: "folio-desktop", manifest_path: "/ws/crates/desktop/Cargo.toml", dependencies: [{ name: "folio-core" }, { name: "gtk4" }] },
  ],
};

test("formatCrateMap lists members with relative paths and only internal dep edges", () => {
  assert.equal(
    formatCrateMap(meta),
    "Rust workspace (2 crates):\n- folio-core → crates/core\n- folio-desktop → crates/desktop\ninternal deps: folio-desktop → folio-core",
  );
});

test("formatCrateMap handles a single root crate with no internal deps", () => {
  const solo = {
    workspace_root: "/ws",
    packages: [{ name: "solo", manifest_path: "/ws/Cargo.toml", dependencies: [{ name: "serde" }] }],
  };
  assert.equal(formatCrateMap(solo), "Rust workspace (1 crate):\n- solo → .\ninternal deps: none");
});

test("isRustEdit recognizes edit/write/patch on .rs and rejects everything else", () => {
  const cases = [
    ["edit", { path: "src/main.rs" }, true],
    ["write", { filePath: "/a/b.rs" }, true],
    ["edit", { path: "README.md" }, false],
    ["patch", { patchText: "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch" }, true],
    ["patch", { patchText: "*** Begin Patch\n*** Delete File: src/old.rs\n*** End Patch" }, true],
    ["patch", { patchText: "*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch" }, false],
    ["shell", { command: "cargo check" }, false],
    ["edit", {}, false],
    ["edit", null, false],
  ];
  for (const [tool, input, want] of cases) {
    assert.equal(isRustEdit(tool, input), want, `${tool} ${JSON.stringify(input)}`);
  }
});

test("findCargoRoot walks up to the nearest Cargo.toml, inclusive of the start dir", () => {
  const base = mkdtempSync(join(tmpdir(), "rust-dev-test-"));
  try {
    mkdirSync(join(base, "ws", "src"), { recursive: true });
    writeFileSync(join(base, "ws", "Cargo.toml"), "[package]\nname = \"x\"\n");
    assert.equal(findCargoRoot(join(base, "ws", "src")), join(base, "ws"));
    assert.equal(findCargoRoot(join(base, "ws")), join(base, "ws"));
    assert.equal(findCargoRoot(base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("crateForFile matches member dir with a path boundary, not a bare prefix", () => {
  assert.equal(crateForFile("/ws", "/ws/crates/core/src/lib.rs", meta), "folio-core");
  assert.equal(crateForFile("/ws", "/ws/crates/core-extra/src/lib.rs", meta), undefined);
  assert.equal(crateForFile("/ws", "/ws/other/x.rs", meta), undefined);
});

// I1: a root package's manifest dir prefixes every member; must pick the MOST SPECIFIC.
test("crateForFile picks the longest matching dir when a root package overlaps members", () => {
  const overlap = {
    workspace_root: "/ws",
    packages: [
      { name: "app", manifest_path: "/ws/Cargo.toml", dependencies: [] },
      { name: "app-core", manifest_path: "/ws/crates/core/Cargo.toml", dependencies: [] },
    ],
  };
  assert.equal(crateForFile("/ws", "/ws/crates/core/src/lib.rs", overlap), "app-core");
  assert.equal(crateForFile("/ws", "/ws/src/main.rs", overlap), "app");
});

// C1: the check must be keyed by the SESSION workspace root, not the edited member's nearest root.
test("editCheckRoot canonicalizes to the location workspace root for nested member edits", () => {
  const base = mkdtempSync(join(tmpdir(), "rust-dev-ws-"));
  try {
    mkdirSync(join(base, "ws", "crates", "core", "src"), { recursive: true });
    writeFileSync(join(base, "ws", "Cargo.toml"), "[workspace]\nmembers=[\"crates/core\"]\n");
    writeFileSync(join(base, "ws", "crates", "core", "Cargo.toml"), "[package]\nname=\"core\"\n");
    const memberFile = join(base, "ws", "crates", "core", "src", "lib.rs");
    // Session at workspace root, editing a member file → key must be the workspace root.
    assert.equal(lib.editCheckRoot(join(base, "ws"), memberFile), join(base, "ws"));
    // Session with no Cargo root, editing inside a project → fall back to the file's root.
    assert.equal(lib.editCheckRoot(base, memberFile), join(base, "ws", "crates", "core"));
    // No file, location has a root → location root.
    assert.equal(lib.editCheckRoot(join(base, "ws"), undefined), join(base, "ws"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// I2: spawn must honor an abort signal and kill the child promptly.
test("spawnCaptured aborts and kills the child when the signal fires", async () => {
  const ac = new AbortController();
  const p = lib.spawnCaptured("sleep", ["5"], { cwd: tmpdir(), timeout: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const res = await p;
  assert.equal(res.aborted, true);
  assert.ok(Date.now() - t0 < 2000, "must settle promptly after abort, not run the full 5s");
});

test("spawnCaptured reports timedOut and kills the child on timeout", async () => {
  const t0 = Date.now();
  const res = await lib.spawnCaptured("sleep", ["5"], { cwd: tmpdir(), timeout: 100 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 2000);
});
