"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ws = require("./verified-workspaces.cjs");
const { workerEnvironment, retry, verifyRetriedWorker } = require("./workers.cjs");

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-ws-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readNorm(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function git(cwd, args) {
  const result = spawnSync("git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
}

function commitAll(root) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

test("auto uses detached worktrees at one recorded HEAD for a clean repository root", (t) => {
  const root = temp(t);
  const source = path.join(root, "source");
  initRepo(source);
  write(path.join(source, "app.py"), "print('base')\n");
  write(path.join(source, "README.md"), "fixture\n");
  const baseSha = commitAll(source);

  const info = ws.detectWorkspace(source);
  assert.equal(info.isRepo, true);
  assert.equal(info.isRoot, true);
  assert.equal(info.hasHead, true);
  assert.equal(info.clean, true);
  assert.equal(info.baseSha, baseSha);
  assert.equal(info.worktreeEligible, true);
  assert.equal(ws.resolveWorkspaceMode("auto", info), "worktree");
  assert.equal(ws.resolveWorkspaceMode("worktree", info), "worktree");

  const run = path.join(root, "run");
  fs.mkdirSync(run);
  const baseline = path.join(run, "baseline");
  fs.mkdirSync(baseline);
  const workers = ws.createDetachedWorktrees({ source, baseSha, run, names: ["w1", "w2"] });
  ws.copyTree(workers.w1, baseline);
  assert.notEqual(workers.w1, workers.w2);
  for (const directory of Object.values(workers)) {
    assert.equal(git(directory, ["rev-parse", "HEAD"]), baseSha);
    assert.equal(git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
    assert.ok(fs.existsSync(path.join(directory, ".git")));
  }

  write(path.join(workers.w1, "app.py"), "print('w1')\n");
  assert.equal(readNorm(path.join(workers.w2, "app.py")), "print('base')\n");
  assert.equal(readNorm(path.join(baseline, "app.py")), "print('base')\n");

  write(path.join(workers.w1, "__pycache__", "x.pyc"), "noise");
  write(path.join(workers.w1, "loose.pyo"), "noise");
  const changes = ws.compareTrees(baseline, workers.w1, source);
  assert.deepEqual(changes.map((item) => item.path), ["app.py"]);
});

test("no-HEAD, dirty and non-repository projects fall back to snapshot copies", (t) => {
  const root = temp(t);

  const unborn = path.join(root, "unborn");
  initRepo(unborn);
  write(path.join(unborn, "app.py"), "print('unborn')\n");
  const unbornInfo = ws.detectWorkspace(unborn);
  assert.equal(unbornInfo.hasHead, false);
  assert.equal(unbornInfo.baseSha, null);
  assert.match(unbornInfo.reason, /no HEAD commit/);
  assert.equal(unbornInfo.worktreeEligible, false);
  assert.equal(ws.resolveWorkspaceMode("auto", unbornInfo), "copy");
  assert.throws(() => ws.resolveWorkspaceMode("worktree", unbornInfo), /unavailable/);

  const dirty = path.join(root, "dirty");
  initRepo(dirty);
  write(path.join(dirty, "app.py"), "print('base')\n");
  commitAll(dirty);
  write(path.join(dirty, "app.py"), "print('edited')\n");
  write(path.join(dirty, "new.txt"), "untracked\n");
  const dirtyInfo = ws.detectWorkspace(dirty);
  assert.equal(dirtyInfo.clean, false);
  assert.ok(dirtyInfo.statusCount >= 2);
  assert.match(dirtyInfo.reason, /working tree has/);
  assert.equal(ws.resolveWorkspaceMode("auto", dirtyInfo), "copy");
  assert.throws(() => ws.resolveWorkspaceMode("worktree", dirtyInfo), /unavailable/);

  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  write(path.join(plain, "app.py"), "print('plain')\n");
  const plainInfo = ws.detectWorkspace(plain);
  assert.equal(plainInfo.isRepo, false);
  assert.equal(ws.resolveWorkspaceMode("auto", plainInfo), "copy");
  assert.throws(() => ws.resolveWorkspaceMode("worktree", plainInfo), /unavailable/);
});

test("assembly rejects unsafe paths and symlink components", (t) => {
  for (const value of ["../evil", "C:/evil", "/evil", ".git/config", "a.pyc", "dir/", "a\\b"]) {
    assert.throws(() => ws.assertSafeRelativePath(value, "path"), /Unsafe/, value);
  }
  const root = temp(t);
  const base = path.join(root, "base");
  fs.mkdirSync(base);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const link = path.join(base, "link");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch (error) {
    t.skip("directory junctions are unavailable in this environment: " + error.message);
    return;
  }
  assert.throws(() => ws.assertNoSymlinks(base, "link/evil.py"), /symlink/);
});

function buildRun(t) {
  const root = temp(t);
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const run = path.join(root, "run");
  fs.mkdirSync(run);
  const baseline = path.join(run, "baseline");
  fs.mkdirSync(baseline);
  for (const [file, content] of Object.entries({
    "app.py": "print('base')\n",
    "README.md": "base\n",
    "web/index.html": "<h1>base</h1>\n",
    "src/util.py": "x = 1\n",
    ".gitignore": "runtime.log\n",
  })) {
    write(path.join(source, file), content);
  }
  initRepo(source);
  commitAll(source);
  ws.copyTree(source, baseline);

  const directories = {};
  for (const name of ["a", "b", "c", "d"]) {
    const directory = path.join(run, name);
    fs.mkdirSync(directory);
    ws.copyTree(baseline, directory);
    directories[name] = directory;
  }
  write(path.join(directories.a, "app.py"), "print('a')\n");
  write(path.join(directories.a, "added.py"), "A\n");
  write(path.join(directories.b, "web/index.html"), "<h1>b</h1>\n");
  write(path.join(directories.c, "app.py"), "print('blocked-c')\n");
  write(path.join(directories.d, "app.py"), "print('conflicting-d')\n");

  const makeWorker = (name, status, changedPaths, writeScope, extra = {}) => ({
    name, status, workerPath: directories[name], writeScope, changedPaths,
    artifactHashes: ws.artifactHashes(directories[name], changedPaths),
    verification: { verified: status === "completed" },
    parentSessionID: "ses_parent_" + name,
    childSessionID: "ses_child_" + name,
    ...extra,
  });
  const manifest = {
    run, source, baseline, workers: directories, mode: "copy", baseSha: null,
    baselineHashes: ws.hashesToObject(ws.collectTreeHashes(baseline)),
  };
  const summary = {
    workers: [
      makeWorker("a", "completed", [{ path: "app.py", status: "modified" }, { path: "added.py", status: "added" }],
        ["app.py", "added.py", "src/"]),
      makeWorker("b", "completed", [{ path: "web/index.html", status: "modified" }], ["web/"]),
      makeWorker("c", "blocked", [{ path: "app.py", status: "modified" }], ["app.py"], { qualityGate: { blocked: true } }),
      makeWorker("d", "completed", [{ path: "app.py", status: "modified" }], ["app.py"]),
    ],
  };
  fs.writeFileSync(path.join(run, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify(summary, null, 2));
  return { root, run, source, baseline, directories, manifest, summary };
}

test("assemble overlays only completed verified workers and verify detects drift", (t) => {
  const fixture = buildRun(t);
  const assembled = ws.assembleRun(fixture.run, ["a", "b"]);
  assert.equal(path.basename(assembled.manifestPath), "assembly.json");
  assert.deepEqual(assembled.record.workers.map((worker) => worker.name), ["a", "b"]);
  assert.equal(fs.readFileSync(path.join(assembled.record.assembly, "app.py"), "utf8"), "print('a')\n");
  assert.equal(fs.readFileSync(path.join(assembled.record.assembly, "added.py"), "utf8"), "A\n");
  assert.equal(fs.readFileSync(path.join(assembled.record.assembly, "web/index.html"), "utf8"), "<h1>b</h1>\n");
  const before = assembled.record.affectedFiles.find((item) => item.path === "app.py");
  assert.equal(before.before, fixture.manifest.baselineHashes["app.py"]);
  assert.notEqual(before.assembled, before.before);
  assert.equal(ws.verifyAssemblyReport(assembled.record.assembly).status, "ok");

  write(path.join(assembled.record.assembly, "app.py"), "tampered\n");
  const assemblyTamper = ws.verifyAssemblyReport(assembled.record.assembly);
  assert.equal(assemblyTamper.status, "stale");
  assert.ok(assemblyTamper.assemblyChanges.some((item) => item.path === "app.py"));
  const verifyCli = spawnSync(process.execPath,
    [path.join(__dirname, "workers.cjs"), "verify", assembled.record.assembly],
    { encoding: "utf8", windowsHide: true });
  assert.equal(verifyCli.status, 1);
  assert.equal(JSON.parse(verifyCli.stdout).status, "stale");
  write(path.join(assembled.record.assembly, "app.py"), "print('a')\n");
  assert.equal(ws.verifyAssemblyReport(assembled.record.assembly).status, "ok");

  write(path.join(fixture.source, "app.py"), "print('concurrent')\n");
  const sourceEdit = ws.verifyAssemblyReport(assembled.record.assembly);
  assert.equal(sourceEdit.status, "stale");
  assert.ok(sourceEdit.sourceFindings.some((item) =>
    item.kind === "concurrent-source-edit" && item.path === "app.py"));
  write(path.join(fixture.source, "app.py"), "print('base')\n");

  write(path.join(fixture.source, "src/extra.py"), "new source file\n");
  const arrival = ws.verifyAssemblyReport(assembled.record.assembly);
  assert.equal(arrival.status, "stale");
  assert.ok(arrival.sourceFindings.some((item) =>
    item.kind === "newly-appeared-source-path" && item.path === "src/extra.py"));
  fs.rmSync(path.join(fixture.source, "src/extra.py"));
  assert.equal(ws.verifyAssemblyReport(assembled.record.assembly).status, "ok");
});

test("assembly fails closed for duplicates, blocked workers, conflicts, drift and CLI misuse", (t) => {
  const fixture = buildRun(t);
  assert.throws(() => ws.assembleRun(fixture.run, ["a", "a"]), /Duplicate worker/);
  assert.throws(() => ws.assembleRun(fixture.run, ["c"]), /blocked by the quality gate/);
  assert.throws(() => ws.assembleRun(fixture.run, ["a", "d"]), /Conflicting changes/);
  write(path.join(fixture.directories.a, "app.py"), "drifted\n");
  assert.throws(() => ws.assembleRun(fixture.run, ["a"]), /drifted since the recorded run/);

  const cli = path.join(__dirname, "workers.cjs");
  const rejected = spawnSync(process.execPath, [cli, "assemble", fixture.run, "c"], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).status, "failed");
  assert.ok(fs.existsSync(path.join(fixture.run, "summary.json")));
});

test("git-ignored runtime files are excluded while generated code stays scoped", (t) => {
  const fixture = buildRun(t);
  write(path.join(fixture.directories.a, "runtime.log"), "ignored noise\n");
  write(path.join(fixture.directories.a, "generated/app.js"), "export default 1;\n");
  const paths = ws.compareTrees(fixture.baseline, fixture.directories.a, fixture.source)
    .map((item) => item.path);
  assert.equal(paths.includes("runtime.log"), false);
  assert.equal(paths.includes("generated/app.js"), true);
  assert.equal(paths.includes("app.py"), true);
});

test("worker environment preserves other variables and disables Python bytecode", () => {
  const previous = process.env.PYTHONDONTWRITEBYTECODE;
  process.env.VERIFIED_TEST_MARKER = "keep-me";
  process.env.PYTHONDONTWRITEBYTECODE = "0";
  try {
    const env = workerEnvironment();
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.equal(env.VERIFIED_TEST_MARKER, "keep-me");
    const probe = spawnSync(process.execPath,
      ["-e", "process.stdout.write(process.env.PYTHONDONTWRITEBYTECODE + ':' + process.env.VERIFIED_TEST_MARKER)"],
      { env, encoding: "utf8", windowsHide: true });
    assert.equal(probe.stdout, "1:keep-me");
  } finally {
    if (previous === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
    else process.env.PYTHONDONTWRITEBYTECODE = previous;
    delete process.env.VERIFIED_TEST_MARKER;
  }
});

test("source stability checks the whole baseline, runtime exclusions and unsafe ancestors", (t) => {
  const fixture = buildRun(t);
  const check = (paths = [{ path: "app.py", status: "modified" }]) => ws.checkSourceStability({
    source: fixture.source, baselineHashes: fixture.manifest.baselineHashes, paths,
  });
  assert.deepEqual(check(), []);

  write(path.join(fixture.source, "README.md"), "drifted\n");
  assert.ok(check().some((item) => item.kind === "source-drift" && item.path === "README.md"));
  write(path.join(fixture.source, "README.md"), "base\n");

  write(path.join(fixture.source, "__pycache__", "noise.pyc"), "noise\n");
  write(path.join(fixture.source, ".env.local"), "SECRET=1\n");
  assert.deepEqual(check(), []);
  fs.rmSync(path.join(fixture.source, "__pycache__"), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.source, ".env.local"), { force: true });

  const replaced = path.join(fixture.source, "src");
  fs.rmSync(replaced, { recursive: true, force: true });
  write(replaced, "now a file\n");
  const findings = check([{ path: "src/util.py", status: "modified" }]);
  assert.ok(findings.some((item) => item.kind === "unsafe-source-ancestor" && item.detail.includes("src")));
});

test("repeat assembly uses fresh directories and manifests", (t) => {
  const fixture = buildRun(t);
  const first = ws.assembleRun(fixture.run, ["a"]);
  assert.equal(path.basename(first.manifestPath), "assembly.json");
  const second = ws.assembleRun(fixture.run, ["b"]);
  assert.equal(path.basename(second.manifestPath), "assembly-2.json");
  assert.notEqual(second.record.assembly, first.record.assembly);
  assert.equal(ws.verifyAssemblyReport(second.record.assembly).status, "ok");

  fs.writeFileSync(path.join(fixture.run, "assembly.json"), "{broken\n");
  assert.equal(ws.verifyAssemblyReport(second.record.assembly).status, "ok");
  assert.throws(() => ws.verifyAssemblyReport(first.record.assembly), /No assembly manifest matches this directory/);
});

test("retry requires a revised assignment and fails on a concurrent lock", async (t) => {
  const fixture = buildRun(t);
  const previousAppData = process.env.APPDATA;
  const appdata = path.join(fixture.root, "appdata");
  const cliDirectory = path.join(appdata, "ai.opencode.desktop", "cli", "99.0.0-x64");
  fs.mkdirSync(cliDirectory, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(cliDirectory, "opencode-cli.exe"));
  process.env.APPDATA = appdata;
  t.after(() => {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  });

  await assert.rejects(() => retry(fixture.run, "a"), /explicit revised assignment file/);
  const original = path.join(fixture.run, "a.prompt.txt");
  write(original, "original\n");
  const unchanged = path.join(fixture.run, "unchanged.prompt.txt");
  write(unchanged, "original\n");
  await assert.rejects(() => retry(fixture.run, "a", unchanged), /must differ from the original assignment/);

  const revised = path.join(fixture.run, "revised.prompt.txt");
  write(revised, "revised assignment\n");
  const lock = path.join(fixture.run, "retry.lock");
  write(lock, "busy\n");
  await assert.rejects(() => retry(fixture.run, "a", revised), /Another retry is in progress/);
  fs.rmSync(lock, { force: true });
});

test("retry verification accepts only the recorded child and a fresh terminal idle", async (t) => {
  const root = temp(t);
  const run = path.join(root, "run");
  const baseline = path.join(root, "baseline");
  const workerPath = path.join(run, "w");
  fs.mkdirSync(run);
  fs.mkdirSync(baseline);
  fs.mkdirSync(workerPath);
  const parent = "ses_parent_w";
  const child = "ses_child_w";
  const startedAt = Date.now() - 5000;
  const endedAt = Date.now();
  const expected = { parentID: parent, childID: child, startedAt };
  const context = { run, baseline, workers: { w: workerPath } };
  const makeRecord = (suffix) => ({
    spec: { name: "w", model: "opencode/big-pickle", agent: "general", writeScope: [], scopes: [] },
    processLog: path.join(run, "w" + suffix + ".process.log"),
    startedAt, endedAt, budgetMs: 60000, exitCode: 0, signalCode: null,
    timedOut: false, spawnError: null,
  });
  const sessionScript = (idle) => `
const payload = ${JSON.stringify({
    info: { id: child, parentID: parent, outcome: "succeeded", time: { idle } },
    messages: [
      { type: "assistant", content: [{ type: "text", text: "done" }], time: { completed: idle - 10 } },
      { type: "idle", time: { idle, created: idle } },
    ],
  })};
process.stdout.write(JSON.stringify(payload));
`;
  const childEvent = JSON.stringify({ sessionID: child, type: "step_finish" }) + "\n";
  write(path.join(run, "w.retry-1.jsonl"), childEvent);
  write(makeRecord(".retry-1").processLog, "");
  write(path.join(workerPath, "session"), sessionScript(Date.now() + 1000));

  const accepted = await verifyRetriedWorker(makeRecord(".retry-1"), context, process.execPath, expected, ".retry-1");
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.parentSessionID, parent);
  assert.equal(accepted.childSessionID, child);
  assert.equal(accepted.continuedSession, true);
  assert.equal(accepted.verification.retryStartedAt, startedAt);
  assert.equal(accepted.verification.retryEndedAt, endedAt);
  assert.equal(accepted.verification.exportAttempts, 1);

  write(path.join(run, "w.retry-2.jsonl"), JSON.stringify({ sessionID: parent, type: "step_finish" }) + "\n");
  const wrongSession = await verifyRetriedWorker(makeRecord(".retry-2"), context, process.execPath, expected, ".retry-2");
  assert.equal(wrongSession.status, "failed");
  assert.match(wrongSession.reason, /recorded child/);
  assert.match(wrongSession.reason, /Use a fresh scoped batch/);

  write(path.join(run, "w.retry-3.jsonl"), childEvent);
  write(path.join(workerPath, "session"), sessionScript(startedAt - 1000));
  const staleIdle = await verifyRetriedWorker(makeRecord(".retry-3"), context, process.execPath, expected, ".retry-3");
  assert.equal(staleIdle.status, "unverified");
  assert.match(staleIdle.reason, /no new terminal completed idle/);
  assert.match(staleIdle.reason, /Use a fresh scoped batch/);
});
