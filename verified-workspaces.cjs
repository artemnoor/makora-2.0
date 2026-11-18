"use strict";

// Workspace and assembly primitives for verified batch runs. All I/O here is
// confined to the run directory: source is read only, never committed, reset,
// merged or cleaned up.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { normalizeWriteScope } = require("./scope-gate.cjs");

const MODES = ["auto", "copy", "worktree"];
const MAX_ASSEMBLY_WORKERS = 3;
const RUNTIME_COMPONENT = /^(?:\.git|\.codex|\.bridge|\.mcp\.json|node_modules|\.venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.env(?:\..*)?)$/i;
const BYTECODE_FILE = /\.(?:pyc|pyo)$/i;
const OMITTED_PLUGIN = ".opencode/plugins/open-agent-bridge";

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSlashes(value) {
  return String(value ?? "").split("\\").join("/");
}

// Shared by snapshot copying and change inventory. Git control files, existing
// runtime copy exclusions and Python bytecode are not meaningful source changes.
function isRuntimeExcluded(relative) {
  const value = normalizeSlashes(relative);
  if (!value) return false;
  if (value === OMITTED_PLUGIN || value.startsWith(OMITTED_PLUGIN + "/")) return true;
  return value.split("/").some((part) => RUNTIME_COMPONENT.test(part) || BYTECODE_FILE.test(part));
}

function copyTree(source, destination, relative = "") {
  if (isRuntimeExcluded(relative)) return;
  const from = path.join(source, relative);
  const stat = fs.lstatSync(from, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    for (const name of fs.readdirSync(from)) copyTree(source, destination, path.join(relative, name));
  } else if (stat?.isFile()) {
    const to = path.join(destination, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  // Symlinks are deliberately not followed or copied.
}

function hashFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return "symlink:" + fs.readlinkSync(file);
  if (!stat.isFile()) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function collectTreeHashes(root, prefix = "") {
  const result = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (isRuntimeExcluded(relative)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of collectTreeHashes(full, relative)) result.set(key, value);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      result.set(relative, hashFile(full));
    }
  }
  return result;
}

function hashesToObject(hashes) {
  return Object.fromEntries([...hashes.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function compareHashes(before, after) {
  const changed = [];
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b))) {
    if (!before.has(file)) changed.push({ path: file, status: "added" });
    else if (!after.has(file)) changed.push({ path: file, status: "deleted" });
    else if (before.get(file) !== after.get(file)) changed.push({ path: file, status: "modified" });
  }
  return changed;
}

// Ignore rules come from source, so the same rules apply to plain copies and
// detached worktrees. If git cannot answer, no path is treated as ignored.
function gitIgnoredSet(source, paths) {
  if (!source || !paths?.length) return new Set();
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: source, input: paths.join("\0") + "\0", encoding: "utf8",
    windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) return new Set();
  return new Set(result.stdout.split("\0").filter(Boolean));
}

function compareTrees(baseline, workerPath, source) {
  const changes = compareHashes(collectTreeHashes(baseline), collectTreeHashes(workerPath));
  if (!source) return changes;
  const ignored = gitIgnoredSet(source, changes.map((item) => item.path));
  return changes.filter((item) => !ignored.has(item.path));
}

function artifactHashes(workerPath, changes) {
  const current = collectTreeHashes(workerPath);
  return Object.fromEntries(changes.map((change) => [change.path, change.status === "deleted" ? null : (current.get(change.path) ?? null)]));
}

// ---- workspace selection ----

function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  });
}

function samePath(left, right) {
  const resolved = (value) => {
    try { return fs.realpathSync.native(value).toLowerCase(); }
    catch { return path.resolve(value).toLowerCase(); }
  };
  return resolved(left) === resolved(right);
}

function detectWorkspace(source) {
  const info = {
    isRepo: false, isRoot: false, hasHead: false, baseSha: null, clean: false,
    worktreeEligible: false, statusCount: 0, statusPreview: [], reason: null,
  };
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], source);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") {
    info.reason = inside.error?.code === "ENOENT" ? "git is not installed" : "source is not a git work tree";
    return info;
  }
  info.isRepo = true;
  const top = runGit(["rev-parse", "--show-toplevel"], source);
  if (top.status !== 0 || !top.stdout.trim()) {
    info.reason = "git repository root cannot be determined";
    return info;
  }
  info.isRoot = samePath(top.stdout.trim(), source);
  const head = runGit(["rev-parse", "--verify", "HEAD"], source);
  const sha = head.stdout.trim();
  if (head.status === 0 && /^[0-9a-f]{7,64}$/i.test(sha)) {
    info.hasHead = true;
    info.baseSha = sha;
  }
  const status = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], source);
  if (status.status !== 0) {
    info.reason = "git status failed: " + oneLine(status.stderr).slice(0, 200);
    return info;
  }
  const entries = status.stdout.split("\0").filter(Boolean);
  info.statusCount = entries.length;
  info.statusPreview = entries.slice(0, 8).map((entry) => oneLine(entry).slice(0, 120));
  info.clean = entries.length === 0;
  if (!info.isRoot) info.reason = "source is not the repository root";
  else if (!info.hasHead) info.reason = "repository has no HEAD commit";
  else if (!info.clean) info.reason = `working tree has ${entries.length} tracked or nonignored untracked change(s)`;
  else info.worktreeEligible = true;
  return info;
}

function resolveWorkspaceMode(requested, workspace) {
  const mode = requested || "auto";
  if (!MODES.includes(mode)) {
    throw new Error(`Workspace mode must be auto, copy or worktree (received ${mode})`);
  }
  if (mode === "worktree" && !workspace.worktreeEligible) {
    throw new Error(`Workspace mode "worktree" is unavailable: ${workspace.reason ?? "repository is unsuitable"}`);
  }
  return mode === "auto" ? (workspace.worktreeEligible ? "worktree" : "copy") : mode;
}

function createDetachedWorktrees({ source, baseSha, run, names }) {
  const workers = {};
  for (const name of names) {
    const directory = path.join(run, name);
    if (fs.existsSync(directory)) throw new Error(`Worktree target already exists: ${directory}`);
    const added = runGit(["worktree", "add", "--detach", directory, baseSha], source);
    if (added.error || added.status !== 0) {
      throw new Error(`git worktree add failed for ${name}: ` +
        oneLine(added.error?.message ?? added.stderr ?? added.stdout).slice(0, 300));
    }
    const detached = runGit(["rev-parse", "--abbrev-ref", "HEAD"], directory);
    const actualHead = runGit(["rev-parse", "HEAD"], directory);
    if (detached.status !== 0 || detached.stdout.trim() !== "HEAD" ||
        actualHead.status !== 0 || actualHead.stdout.trim() !== baseSha) {
      throw new Error(`Worktree for ${name} is not detached at pinned ${baseSha}`);
    }
    workers[name] = directory;
  }
  return workers;
}

// ---- assembly ----

function assertSafeRelativePath(relative, label = "path") {
  if (typeof relative !== "string" || relative.includes("\\")) {
    throw new Error(`Unsafe ${label}: expected a forward-slash relative path`);
  }
  const value = normalizeSlashes(relative);
  let scope;
  try {
    scope = normalizeWriteScope(value, label);
  } catch (error) {
    throw new Error(`Unsafe ${label}: ${error.message}`);
  }
  if (scope.kind !== "file") throw new Error(`Unsafe ${label}: expected a file path`);
  if (isRuntimeExcluded(value)) throw new Error(`Unsafe ${label}: runtime or control path ${value}`);
  return value;
}

function assertNoSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Unsafe symlink in ${relative}: ${part}`);
  }
}

// A directory or symlink can replace a baseline file without hashFile() seeing
// the original path; check every component explicitly for affected paths.
function sourceAncestorFindings(source, relative) {
  const findings = [];
  const parts = relative.split("/");
  let current = source;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    const prefix = parts.slice(0, index + 1).join("/");
    if (stat.isSymbolicLink()) {
      findings.push({ kind: "unsafe-source-ancestor", path: relative, detail: `symlink at ${prefix}` });
      break;
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      findings.push({ kind: "unsafe-source-ancestor", path: relative, detail: `non-directory at ${prefix}` });
      break;
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      findings.push({ kind: "unsafe-source-path", path: relative, detail: "leaf is not a regular file" });
    }
  }
  return findings;
}

function checkSourceStability({ source, baselineHashes, paths, scopes = [] }) {
  const findings = [];
  const baseline = baselineHashes ?? {};
  const current = collectTreeHashes(source);
  const present = [...current.keys()];
  const ignored = gitIgnoredSet(source, present);

  // Every recorded baseline file must still be byte-identical, including files
  // no worker touched: an old tested snapshot must not be validated against a
  // source tree that drifted somewhere else.
  for (const [relative, expected] of Object.entries(baseline)) {
    if (isRuntimeExcluded(relative)) continue;
    const actual = current.get(relative) ?? null;
    if (actual !== expected) {
      findings.push({ kind: "source-drift", path: relative, detail: `baseline ${expected ?? "absent"}, source ${actual ?? "absent"}` });
    }
  }
  for (const relative of present) {
    if (isRuntimeExcluded(relative) || ignored.has(relative) || Object.hasOwn(baseline, relative)) continue;
    findings.push({ kind: "newly-appeared-source-path", path: relative, detail: "new nonignored source file" });
  }

  for (const item of paths ?? []) {
    let relative;
    try {
      relative = assertSafeRelativePath(item.path, "affected path");
    } catch (error) {
      findings.push({ kind: "unsafe-path", path: String(item.path), detail: error.message });
      continue;
    }
    findings.push(...sourceAncestorFindings(source, relative));
    const expected = baseline[relative] ?? null;
    const actual = hashFile(path.join(source, ...relative.split("/")));
    if (item.status === "added") {
      if (expected !== null) {
        findings.push({ kind: "baseline-mismatch", path: relative, detail: "path was not absent in the baseline" });
      }
      if (actual !== null) {
        findings.push({ kind: "newly-appeared-source-path", path: relative, detail: "source now contains a path the worker added" });
      }
    } else {
      if (expected === null) {
        findings.push({ kind: "baseline-mismatch", path: relative, detail: "path is missing from the baseline" });
      }
      if (actual !== expected) {
        findings.push({ kind: "concurrent-source-edit", path: relative, detail: `baseline ${expected ?? "absent"}, source ${actual ?? "absent"}` });
      }
    }
  }
  return findings;
}

function loadRun(run) {
  const directory = path.resolve(run);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const summary = JSON.parse(fs.readFileSync(path.join(directory, "summary.json"), "utf8"));
  return { directory, manifest, summary };
}

function selectAssemblyWorkers(summary, names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_ASSEMBLY_WORKERS) {
    throw new Error(`Usage: workers.cjs assemble <run> <worker> [<worker> ...] (1-${MAX_ASSEMBLY_WORKERS} workers)`);
  }
  if (new Set(names).size !== names.length) throw new Error("Duplicate worker selected for assembly");
  return names.map((name) => {
    const worker = summary.workers?.find((item) => item.name === name);
    if (!worker) throw new Error(`Unknown or unrecorded worker: ${name}`);
    if (worker.qualityGate?.blocked || worker.outOfScopePaths?.length || worker.changedPathsError) {
      throw new Error(`Worker ${name} is blocked by the quality gate and cannot be assembled`);
    }
    if (worker.status !== "completed" || worker.verification?.verified !== true) {
      throw new Error(`Worker ${name} is not individually completed and verified (status ${worker.status ?? "unknown"})`);
    }
    if (!Array.isArray(worker.changedPaths) || !worker.artifactHashes || !worker.workerPath) {
      throw new Error(`Worker ${name} has no pinned artifact manifest; assembly is not safe`);
    }
    return worker;
  });
}

function assertWorkerArtifacts(worker, source) {
  const current = compareTrees(worker._baseline ?? worker.baseline, worker.workerPath, source);
  const normalized = (list) => [...(list ?? [])]
    .map((item) => ({ path: item.path, status: item.status }))
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  if (JSON.stringify(normalized(current)) !== JSON.stringify(normalized(worker.changedPaths))) {
    throw new Error(`Worker ${worker.name} drifted since the recorded run: changed paths differ`);
  }
  const hashes = artifactHashes(worker.workerPath, current);
  for (const [relative, expected] of Object.entries(worker.artifactHashes)) {
    if ((hashes[relative] ?? null) !== (expected ?? null)) {
      throw new Error(`Worker ${worker.name} drifted since the recorded run: ${relative}`);
    }
  }
}

// First assembly keeps the documented names; later attempts get fresh dirs so
// an existing assembly is never overwritten or silently reused.
function nextAssemblyPaths(run) {
  let index = 1;
  let assembly = path.join(run, "assembly");
  let manifestPath = path.join(run, "assembly.json");
  while (fs.existsSync(assembly) || fs.existsSync(manifestPath)) {
    index += 1;
    assembly = path.join(run, `assembly-${index}`);
    manifestPath = path.join(run, `assembly-${index}.json`);
  }
  return { assembly, manifestPath };
}

function findAssemblyManifest(parent, assembly) {
  for (const name of fs.readdirSync(parent).filter((item) => /^assembly(?:-\d+)?\.json$/.test(item))) {
    const manifestPath = path.join(parent, name);
    try {
      const record = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (record?.assembly && samePath(record.assembly, assembly)) return { record, manifestPath };
    } catch {
      // A malformed unrelated manifest must not hide a valid one.
    }
  }
  throw new Error("No assembly manifest matches this directory");
}

function assembleRun(run, names) {
  const { directory, manifest, summary } = loadRun(run);
  const selected = selectAssemblyWorkers(summary, names);
  // attach baseline for the drift check without mutating the stored report
  for (const worker of selected) worker._baseline = manifest.baseline;

  for (const worker of selected) {
    assertWorkerArtifacts(worker, manifest.source);
    for (const change of worker.changedPaths) {
      assertSafeRelativePath(change.path, `${worker.name} changed path`);
      assertNoSymlinks(worker.workerPath, change.path);
    }
  }

  // Duplicate and conflicting changes are rejected with the same path logic as
  // the batch gate, even if the workers were never compared during the batch.
  const { detectChangedPathConflicts } = require("./scope-gate.cjs");
  const conflicts = detectChangedPathConflicts(selected.map((worker) => ({
    name: worker.name, changedPaths: worker.changedPaths,
  }))).conflicts;
  if (conflicts.length) {
    throw new Error("Conflicting changes in selected workers: " +
      conflicts.map((item) => `${item.workers.join(" + ")} (${item.paths.join(", ")})`).join("; "));
  }

  const affected = selected.flatMap((worker) => worker.changedPaths.map((change) => ({
    path: change.path, status: change.status, worker: worker.name,
  })));
  const scopes = [...new Set(selected.flatMap((worker) => worker.writeScope ?? []))];
  const sourceFindings = checkSourceStability({
    source: manifest.source, baselineHashes: manifest.baselineHashes ?? {}, paths: affected, scopes,
  });
  if (sourceFindings.length) {
    throw new Error("Source changed since the run: " + sourceFindings
      .map((item) => `${item.kind}: ${item.path}`).join("; "));
  }

  const { assembly, manifestPath } = nextAssemblyPaths(directory);
  fs.mkdirSync(assembly); // fresh directory for every attempt
  copyTree(manifest.baseline, assembly);

  const affectedFiles = [];
  for (const item of affected) {
    const relative = assertSafeRelativePath(item.path, "assembly path");
    const from = path.join(selected.find((worker) => worker.name === item.worker).workerPath, ...relative.split("/"));
    const to = path.join(assembly, ...relative.split("/"));
    if (item.status === "deleted") {
      if (fs.lstatSync(to, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`Unsafe assembly deletion: ${relative} is a directory`);
      }
      if (!fs.lstatSync(to, { throwIfNoEntry: false })) {
        throw new Error(`Assembly deletion target is missing: ${relative}`);
      }
      fs.rmSync(to, { force: true });
    } else {
      assertNoSymlinks(selected.find((worker) => worker.name === item.worker).workerPath, relative);
      const stat = fs.lstatSync(from, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error(`Assembly source is not a regular file: ${relative}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to); // byte-for-byte overlay
    }
    affectedFiles.push({
      path: relative,
      status: item.status,
      worker: item.worker,
      before: manifest.baselineHashes?.[relative] ?? null,
      assembled: hashFile(to),
    });
  }

  const record = {
    version: 1,
    run: directory,
    source: manifest.source,
    baseline: manifest.baseline,
    baseSha: manifest.baseSha ?? null,
    mode: manifest.mode ?? "copy",
    assembly,
    createdAt: new Date().toISOString(),
    workers: selected.map((worker) => ({
      name: worker.name, workerPath: worker.workerPath, writeScope: worker.writeScope ?? [],
      parentSessionID: worker.parentSessionID ?? null, childSessionID: worker.childSessionID ?? null,
    })),
    affectedFiles,
    scopes,
    baselineHashes: manifest.baselineHashes ?? {},
    assembledHashes: hashesToObject(collectTreeHashes(assembly)),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return { record, manifestPath };
}

function verifyAssemblyReport(assemblyPath) {
  const assembly = path.resolve(assemblyPath);
  const { record, manifestPath } = findAssemblyManifest(path.dirname(assembly), assembly);
  const current = hashesToObject(collectTreeHashes(assembly));
  const assemblyChanges = compareHashes(new Map(Object.entries(record.assembledHashes ?? {})), new Map(Object.entries(current)));
  const sourceFindings = checkSourceStability({
    source: record.source,
    baselineHashes: record.baselineHashes ?? {},
    paths: record.affectedFiles ?? [],
    scopes: record.scopes ?? [],
  });
  return {
    status: assemblyChanges.length === 0 && sourceFindings.length === 0 ? "ok" : "stale",
    assembly,
    manifest: manifestPath,
    assemblyChanges,
    sourceFindings,
  };
}

module.exports = {
  MODES,
  normalizeSlashes,
  isRuntimeExcluded,
  copyTree,
  hashFile,
  collectTreeHashes,
  hashesToObject,
  compareHashes,
  compareTrees,
  artifactHashes,
  detectWorkspace,
  resolveWorkspaceMode,
  createDetachedWorktrees,
  assertSafeRelativePath,
  assertNoSymlinks,
  checkSourceStability,
  loadRun,
  selectAssemblyWorkers,
  assertWorkerArtifacts,
  nextAssemblyPaths,
  findAssemblyManifest,
  assembleRun,
  verifyAssemblyReport,
};
