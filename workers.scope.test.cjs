"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeWriteScope, normalizeWriteScopes, scopesOverlap, validateScopeBoundaries,
  scopeAllowsPath, findOutOfScopePaths, detectChangedPathConflicts, buildTiming,
} = require("./scope-gate.cjs");

const scope = (value) => normalizeWriteScope(value, "scope");
const change = (path, status = "modified") => ({ path, status });

test("scope syntax: file and directory forms are normalized with forward slashes", () => {
  const file = scope("src/app.ts");
  const dir = scope("src/components/");
  assert.deepEqual([file.kind, file.key], ["file", "src/app.ts"]);
  assert.deepEqual([dir.kind, dir.key], ["dir", "src/components/"]);
});

test("scope syntax rejects whitespace, absolute, drive-relative and traversal paths", () => {
  for (const value of ["   ", "\t\n", " src/a.ts", "src/a.ts ", "/src/a.ts", "C:/src/a.ts",
    "C:src/a.ts", "\\\\server\\share\\a", "../a.ts", "src/../a.ts", "src/./a.ts", "src//a.ts"]) {
    assert.throws(() => scope(value), new RegExp("scope"), value);
  }
});

test("scope syntax rejects backslashes, wildcards and non-portable Windows names", () => {
  for (const value of ["src\\app.ts", "src/*.ts", "src/a?.ts", "src/a.ts:stream", "src/CON.txt",
    "src/NUL", "src/COM1", "src/LPT9", "src/report.", "src/report "]) {
    assert.throws(() => scope(value), new RegExp("scope"), value);
  }
});

test("scope syntax allows lookalike names that differ at a component boundary", () => {
  assert.equal(scope("src/a.ts").key, "src/a.ts");
  assert.equal(scope("SRC/A.TS").key, "src/a.ts");
  assert.equal(scope("src2/a.ts").key, "src2/a.ts");
  assert.equal(scope("src/console.ts").kind, "file");
});

test("duplicate declarations are rejected case-insensitively", () => {
  assert.throws(() => normalizeWriteScopes(["src/A.ts", "SRC/a.ts"], "workers[0].writeScope"), /duplicate/);
  assert.throws(() => normalizeWriteScopes(["src/", "SRC/"], "workers[0].writeScope"), /duplicate/);
  assert.equal(normalizeWriteScopes(["src/a.ts", "src/a.tsx"], "workers[0].writeScope").length, 2);
  assert.throws(() => normalizeWriteScopes(undefined, "w.writeScope"), /non-empty array/);
  assert.throws(() => normalizeWriteScopes(null, "w.writeScope"), /non-empty array/);
  assert.throws(() => normalizeWriteScopes([], "w.writeScope"), /non-empty array/);
  assert.throws(() => normalizeWriteScopes("src/", "w.writeScope"), /array/);
});

test("batch CLI rejects explicit writeScope null and [] before any side effect", () => {
  const cli = path.join(__dirname, "workers.cjs");
  for (const [index, value] of [null, []].entries()) {
    const plan = path.join(os.tmpdir(), `quality-write-scope-${process.pid}-${index}.json`);
    fs.writeFileSync(plan, JSON.stringify({ workers: [{ name: "a", prompt: "A", writeScope: value }] }));
    try {
      const result = spawnSync(process.execPath, [cli, "batch", ".", plan], {
        cwd: __dirname, encoding: "utf8", windowsHide: true,
      });
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout.trim());
      assert.equal(output.status, "invalid");
      assert.match(output.error, /writeScope/);
    } finally {
      fs.rmSync(plan, { force: true });
    }
  }
});

test("overlap: same file, nested directories and file-vs-ancestor collide", () => {
  assert.equal(scopesOverlap(scope("src/a.ts"), scope("SRC/A.TS")), true);
  assert.equal(scopesOverlap(scope("src/"), scope("src/sub/")), true);
  assert.equal(scopesOverlap(scope("SRC/"), scope("src/")), true);
  assert.equal(scopesOverlap(scope("src/a.ts"), scope("src/")), true);
  assert.equal(scopesOverlap(scope("a"), scope("a/")), true);
});

test("overlap: a declared exact file cannot be an ancestor of another declared scope", () => {
  assert.equal(scopesOverlap(scope("a.txt"), scope("a.txt/sub.txt")), true);
  assert.equal(scopesOverlap(scope("a.txt"), scope("a.txt/subdir/")), true);
  assert.equal(scopesOverlap(scope("A.TXT"), scope("a.txt/sub.txt")), true);
  assert.equal(scopesOverlap(scope("a.txt/subdir/"), scope("a.txt")), true);
});

test("overlap: unrelated same-prefix declarations are compatible", () => {
  assert.equal(scopesOverlap(scope("a.txt"), scope("a.txt.bak")), false);
  assert.equal(scopesOverlap(scope("a.txt"), scope("a.txt2/sub.txt")), false);
  assert.equal(scopesOverlap(scope("a/"), scope("a2/")), false);
  assert.equal(scopesOverlap(scope("a.txt/sub/"), scope("a.txt/sub2/")), false);
});

test("overlap: component boundaries are respected", () => {
  assert.equal(scopesOverlap(scope("src/a.ts"), scope("src/a.tsx")), false);
  assert.equal(scopesOverlap(scope("src/a.ts"), scope("src2/a.ts")), false);
  assert.equal(scopesOverlap(scope("src/"), scope("src2/")), false);
  assert.equal(scopesOverlap(scope("pkg/a.ts"), scope("pkg/sub/b.ts")), false);
});

test("plan-level validation rejects any cross-worker overlap before side effects", () => {
  const specs = [
    { name: "a", scopes: [scope("src/")] },
    { name: "b", scopes: [scope("src/app.ts")] },
  ];
  assert.throws(() => validateScopeBoundaries(specs), /Overlapping write scopes: a declares src\//);
  assert.throws(() => validateScopeBoundaries([
    { name: "a", scopes: [scope("a.txt")] },
    { name: "b", scopes: [scope("a.txt/sub.txt")] },
  ]), /Overlapping write scopes/);
  specs[1].scopes = [scope("web/")];
  assert.doesNotThrow(() => validateScopeBoundaries(specs));
  assert.doesNotThrow(() => validateScopeBoundaries([{ name: "legacy", scopes: [] }]));
});

test("out-of-scope detection covers exact files, directory prefixes, adds and deletes", () => {
  const scopes = [scope("src/"), scope("README.md")];
  assert.deepEqual(findOutOfScopePaths(scopes, [change("src/a.ts"), change("README.md")]), []);
  assert.deepEqual(
    findOutOfScopePaths(scopes, [change("src2/a.ts", "added"), change("DOCS.md", "deleted")]),
    ["src2/a.ts", "DOCS.md"],
  );
  assert.deepEqual(findOutOfScopePaths([scope("SRC/A.TS")], [change("src/a.ts")]), []);
  assert.deepEqual(findOutOfScopePaths([scope("src/a.ts")], [change("src/ab.ts")]), ["src/ab.ts"]);
  assert.deepEqual(findOutOfScopePaths([], [change("anything.ts")]), []);
});

test("observed conflicts: same path case-insensitively, across workers only", () => {
  const result = detectChangedPathConflicts([
    { name: "a", changedPaths: [change("Src/App.ts")] },
    { name: "b", changedPaths: [change("src/app.ts")] },
    { name: "c", changedPaths: [change("src/other.ts")] },
  ]);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].workers, ["a", "b"]);
  assert.deepEqual(result.conflicts[0].kinds, ["same-path"]);
  assert.deepEqual(result.byWorker.a[0].with, "b");
  assert.deepEqual(result.byWorker.b[0].with, "a");
  assert.deepEqual(result.byWorker.c, []);
});

test("observed conflicts: one changed path ancestor of another", () => {
  const result = detectChangedPathConflicts([
    { name: "a", changedPaths: [change("pkg")] },
    { name: "b", changedPaths: [change("pkg/index.js")] },
  ]);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].kinds, ["ancestor-path"]);
  assert.ok(result.conflicts[0].paths.includes("pkg"));
  assert.ok(result.conflicts[0].paths.includes("pkg/index.js"));
});

test("observed conflicts: component boundaries and one-owner workers stay clean", () => {
  const result = detectChangedPathConflicts([
    { name: "a", changedPaths: [change("pkg/a.ts"), change("pkg/b.ts")] },
    { name: "b", changedPaths: [change("pkg2/a.ts")] },
  ]);
  assert.deepEqual(result.conflicts, []);
});

test("timing uses recorded process end and only reports derivable parallel metrics", () => {
  const workers = [
    { name: "a", startedAt: 1000, endedAt: 1100, elapsedMs: 100 },
    { name: "b", startedAt: 1050, endedAt: 1150, elapsedMs: 100 },
  ];
  const timing = buildTiming(workers, 300);
  assert.equal(timing.longestWorker, "a");
  assert.equal(timing.longestWorkerMs, 100);
  assert.equal(timing.batchWallMs, 300);
  assert.equal(timing.parallel.activeSumMs, 200);
  assert.equal(timing.parallel.unionMs, 150);
  assert.equal(timing.parallel.parallelWorkerMsSaved, 50);
  assert.equal(timing.parallel.parallelismRatio, 1.333);

  const unfinished = buildTiming([{ name: "a", startedAt: 1000, endedAt: null, elapsedMs: 200 }, workers[1]], 300);
  assert.equal(unfinished.parallel, null);
  assert.equal(unfinished.longestWorker, null);
  assert.match(unfinished.note, /no recorded end/);

  const single = buildTiming([workers[0]], 100);
  assert.equal(single.parallel, null);
  assert.match(single.note, /Only one worker/);
});
