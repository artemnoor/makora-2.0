const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  normalizeWriteScopes, validateScopeBoundaries, findOutOfScopePaths,
  detectChangedPathConflicts, buildTiming,
} = require("./scope-gate.cjs");
const {
  copyTree, collectTreeHashes, hashesToObject, compareTrees, artifactHashes,
  detectWorkspace, resolveWorkspaceMode, createDetachedWorktrees, checkSourceStability,
  assertWorkerArtifacts, loadRun, assembleRun, verifyAssemblyReport,
} = require("./verified-workspaces.cjs");

const DEFAULT_MODEL = "opencode/big-pickle";
const DEFAULT_AGENT = "general";
const MAX_WORKERS = 3;
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9_./#-]*$/i;
const AGENT_RE = /^[a-z0-9][a-z0-9_/-]*$/i;
const SESSION_RE = /^ses_[A-Za-z0-9_]+$/;
const DISPLAY_PATH_LIMIT = 8;
const PYTHON_BYTECODE_ENV = "1";

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
}

function budgetMs() {
  return envInt("OPENCODE_BATCH_BUDGET_MS", 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
}

const EXPORT_TIMEOUT_MS = 20000;
const EXPORT_RETRIES = 4;
const POLL_MS = 250;
const KILL_GRACE_MS = 5000;
// Let the internal CLI time out first; the outer Node process only kills after
// the service/status allowance plus this grace, so a remote child may outlive a timeout.
const CLI_FINISH_MARGIN_MS = 30000;

function debug(message) {
  if (process.env.OPENCODE_BATCH_DEBUG === "1") process.stderr.write("[batch] " + message + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function tailFile(file, max) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > max ? text.slice(-max) : text;
  } catch {
    return "";
  }
}

// Worker processes inherit the caller's environment but never emit Python
// bytecode into a shared or worker tree (which would look like a real change).
function workerEnvironment() {
  return { ...process.env, PYTHONDONTWRITEBYTECODE: PYTHON_BYTECODE_ENV };
}

function checkWorkerNames(project, workerNames, minCount) {
  if (!project || !Array.isArray(workerNames) || workerNames.length < minCount ||
      workerNames.length > MAX_WORKERS || new Set(workerNames).size !== workerNames.length ||
      workerNames.some((name) => typeof name !== "string" || !NAME_RE.test(name) || name === "baseline")) {
    throw new Error("Usage: workers.cjs prepare <project> <name-1> [<name-2>] [<name-3>]");
  }
}

function writeManifest(run, manifest) {
  fs.writeFileSync(path.join(run, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    encoding: "utf8", flag: "wx",
  });
}

function createRun(project, workerNames, requestedMode) {
  const source = fs.realpathSync.native(project);
  if (!fs.statSync(source).isDirectory()) throw new Error("Project must be a directory");
  const runRoot = path.join(process.env.LOCALAPPDATA, "Codex", "OpenCode workers");
  const resolved = path.relative(source, runRoot);
  if (!path.isAbsolute(resolved) && !resolved.startsWith(".." + path.sep) && resolved !== "..") {
    throw new Error("The project must not contain the worker storage directory");
  }
  const workspace = detectWorkspace(source);
  const mode = resolveWorkspaceMode(requestedMode, workspace);
  checkDesktopService(openCode(), source, "start");
  fs.mkdirSync(runRoot, { recursive: true });
  const run = fs.mkdtempSync(path.join(runRoot, "run-"));
  const baseline = path.join(run, "baseline");
  fs.mkdirSync(baseline);
  // The baseline is always an immutable plain copy, even in worktree mode.
  let workers;
  if (mode === "worktree") {
    workers = createDetachedWorktrees({ source, baseSha: workspace.baseSha, run, names: workerNames });
    // Seeding from a worktree keeps byte-for-byte parity with every executor
    // (checkout filters such as core.autocrlf must not look like worker edits).
    copyTree(workers[workerNames[0]], baseline);
  } else {
    const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
      cwd: source, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000,
    });
    if (git.status === 0) {
      for (const file of new Set(git.stdout.split("\0").filter(Boolean))) {
        copyTree(source, baseline, path.normalize(file));
      }
    } else if (git.error?.code === "ENOENT" || /not a git repository/i.test(git.stderr ?? "")) {
      copyTree(source, baseline);
    } else {
      throw new Error(git.error?.message ?? git.stderr ?? "snapshot failed");
    }
    workers = Object.fromEntries(workerNames.map((name) => {
      const directory = path.join(run, name);
      fs.mkdirSync(directory);
      copyTree(baseline, directory);
      return [name, directory];
    }));
  }
  const baselineHashes = hashesToObject(collectTreeHashes(baseline));
  if (mode === "worktree") {
    // Fail before any worker process starts if checkout produced a tree that
    // differs from the immutable baseline.
    for (const [name, directory] of Object.entries(workers)) {
      const initial = hashesToObject(collectTreeHashes(directory));
      if (JSON.stringify(initial) !== JSON.stringify(baselineHashes)) {
        throw new Error(`Worktree for ${name} does not match the copied baseline before worker start`);
      }
    }
  }
  const manifest = {
    run, source, baseline, workers,
    mode, requestedMode: requestedMode ?? "auto", baseSha: workspace.baseSha ?? null,
    workspace,
    baselineHashes,
  };
  writeManifest(run, manifest);
  return { run, source, baseline, workers, manifest };
}

function prepare(project, workerNames) {
  checkWorkerNames(project, workerNames, 1);
  const { run, manifest } = createRun(project, workerNames, process.env.OPENCODE_WORKSPACE_MODE);
  console.log(JSON.stringify({ run, ...manifest }));
}

function openCode() {
  const root = path.join(process.env.APPDATA, "ai.opencode.desktop", "cli");
  const executable = fs.readdirSync(root)
    .filter((name) => name.endsWith("-x64") && fs.existsSync(path.join(root, name, "opencode-cli.exe")))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
  if (!executable) throw new Error("OpenCode Desktop CLI was not found");
  return path.join(root, executable, "opencode-cli.exe");
}

function checkDesktopService(cli, directory, action) {
  const server = spawnSync(cli, ["service", action], {
    cwd: directory, encoding: "utf8", windowsHide: true,
    timeout: action === "start" ? 60000 : 20000,
  });
  if (server.error) throw server.error;
  if (server.status !== 0) throw new Error(oneLine(server.stderr).slice(0, 400) || `service ${action} failed`);
  const url = server.stdout.trim();
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(url)) {
    throw new Error("Expected a local OpenCode Desktop service");
  }
}

function runWorker(run, name, model, promptFile, agent = DEFAULT_AGENT, timeout) {
  const directory = workerDirectory(run, name);
  if (!model || !MODEL_RE.test(model) || !promptFile || !AGENT_RE.test(agent) ||
      (timeout !== undefined && (!Number.isFinite(Number(timeout)) || Number(timeout) <= 0))) {
    throw new Error("Usage: workers.cjs run <run> <name> <provider/model> <prompt-file> [subagent-id] [timeout-ms]");
  }
  const cli = openCode();
  checkDesktopService(cli, directory, "status");
  const assignment = fs.readFileSync(promptFile, "utf8");
  const prompt = [
    "Act as the supervisor for one OpenCode worker. Call the subagent tool exactly once with agent ID: " + agent,
    "The text between BEGIN ASSIGNMENT and END ASSIGNMENT is the complete ticket. Send only that inner assignment text to the child as its prompt; do not prepend or append any supervisor instructions.",
    "Tell the actual code-writing child to implement the assignment directly in the current workspace. It must not delegate, call the subagent tool, or launch another process for orchestration.",
    "The parent must not edit. Wait for the child report and return its session ID, modified files, and checks.",
    "Use the selected model. Do not create commits, change permissions, or copy files outside this workspace.",
    "",
    "BEGIN ASSIGNMENT",
    assignment,
    "END ASSIGNMENT",
  ].join("\n");
  const log = path.join(run, name + ".jsonl");
  const handle = fs.openSync(log, "wx");
  try {
    console.log(JSON.stringify({ directory, log, model, agent }));
    const options = { cwd: directory, stdio: ["ignore", handle, handle], windowsHide: true, env: workerEnvironment() };
    if (timeout !== undefined) options.timeout = Number(timeout);
    const result = spawnSync(cli, [
      "run", "--model", model, "--agent", "build", "--format", "json",
      "--title", "Codex worker: " + name, prompt,
    ], options);
    if (result.error?.code === "ETIMEDOUT") throw new Error("Worker CLI timed out");
    if (result.error) throw result.error;
    if (result.signal) throw new Error("Worker CLI terminated by " + result.signal);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.closeSync(handle);
  }
}

function workerDirectory(run, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(run, "manifest.json"), "utf8"));
  if (!Object.hasOwn(manifest.workers, name)) throw new Error("Unknown worker: " + name);
  return manifest.workers[name];
}

function reportDiff(run, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(run, "manifest.json"), "utf8"));
  const result = spawnSync("git", [
    "diff", "--no-index", "--no-ext-diff", "--", manifest.baseline, workerDirectory(run, name),
  ], { stdio: "inherit", windowsHide: true, timeout: 60000 });
  if (result.error || ![0, 1].includes(result.status)) throw result.error ?? new Error("git diff failed");
}

// ---- batch plan validation (no side effects until this returns) ----

function readPlan(planFile) {
  if (!planFile || typeof planFile !== "string") throw new Error("Usage: workers.cjs batch <project> <plan.json>");
  const raw = fs.readFileSync(planFile);
  const text = raw.toString("utf8").replace(/^\uFEFF+/, "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid batch plan JSON: " + error.message);
  }
  return validatePlan(parsed);
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Batch plan must be an object with a workers array");
  }
  if (!Array.isArray(plan.workers) || plan.workers.length < 1 || plan.workers.length > MAX_WORKERS) {
    throw new Error(`Batch plan must contain between 1 and ${MAX_WORKERS} workers`);
  }
  const workspace = plan.workspace ?? process.env.OPENCODE_WORKSPACE_MODE ?? "auto";
  if (!["auto", "copy", "worktree"].includes(workspace)) {
    throw new Error("plan.workspace must be auto, copy or worktree");
  }
  const seen = new Set();
  const specs = plan.workers.map((entry, index) => {
    const label = `workers[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    const { name, model = DEFAULT_MODEL, prompt, agent = DEFAULT_AGENT, writeScope } = entry;
    const hasWriteScope = Object.hasOwn(entry, "writeScope");
    if (typeof name !== "string" || !NAME_RE.test(name) || name === "baseline") {
      throw new Error(`${label}.name must be a lowercase worker name (letters, digits, hyphen; not "baseline")`);
    }
    if (seen.has(name)) throw new Error(`Duplicate worker name: ${name}`);
    seen.add(name);
    if (typeof model !== "string" || !MODEL_RE.test(model)) {
      throw new Error(`${label}.model must be a provider/model string`);
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error(`${label}.prompt must be a non-empty string with the complete ticket text`);
    }
    if (typeof agent !== "string" || !AGENT_RE.test(agent)) {
      throw new Error(`${label}.agent must be a subagent id string`);
    }
    // Only an absent field keeps legacy behavior; explicit null/[] is rejected.
    let scopes = [];
    if (hasWriteScope) {
      try {
        scopes = normalizeWriteScopes(writeScope, `${label}.writeScope`);
      } catch (error) {
        throw new Error(error.message);
      }
    }
    return { name, model, prompt, agent, writeScope: scopes.map((scope) => scope.value), scopes };
  });
  // Overlapping declarations are rejected before createRun() or any process spawn.
  validateScopeBoundaries(specs);
  return { specs, workspace };
}

function assignmentWithScope(spec) {
  if (!spec.writeScope?.length) return spec.prompt;
  return [
    spec.prompt.trimEnd(),
    "",
    "WRITE SCOPE (checked by the batch gate after execution):",
    ...spec.writeScope.map((scope) => "- " + scope),
    "Write only these exact files or paths under these directories, including added and deleted files. Do not edit any other path.",
  ].join("\n");
}

// ---- verification helpers ----

function collectFiles(root) {
  return collectTreeHashes(root);
}

function writeFullDiff(run, name, baseline, workerDirectoryPath, suffix = "") {
  const diffPath = path.join(run, name + suffix + ".diff");
  const handle = fs.openSync(diffPath, "wx");
  try {
    const result = spawnSync("git", [
      "-c", "core.quotepath=false", "diff", "--no-index", "--no-ext-diff", "--no-renames",
      "--", baseline, workerDirectoryPath,
    ], { stdio: ["ignore", handle, "pipe"], encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (![0, 1].includes(result.status)) {
      throw new Error(oneLine(result.stderr).slice(0, 300) || "git diff failed");
    }
  } finally {
    fs.closeSync(handle);
  }
  return diffPath;
}

function readLogEvents(logPath) {
  const events = [];
  let text;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch (error) {
    return { events, readError: error.message };
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object" && !Array.isArray(event)) events.push(event);
    } catch {
      // Non-JSON lines are ignored; only structured events are evidence.
    }
  }
  return { events, readError: null };
}

function findParentSessionID(events) {
  const counts = new Map();
  for (const event of events) {
    const id = event.sessionID;
    if (typeof id === "string" && SESSION_RE.test(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { id: ranked[0]?.[0] ?? null, candidates: ranked.length };
}

function findChildSessionIDs(events) {
  const ids = new Set();
  const add = (value) => {
    if (typeof value === "string" && SESSION_RE.test(value)) ids.add(value);
  };
  for (const event of events) {
    if (event.type === "background_wait" && Array.isArray(event.jobs)) {
      for (const job of event.jobs) {
        if (!job || typeof job !== "object") continue;
        const kind = String(job.kind ?? job.type ?? "");
        if (kind && !/subagent|task|background/i.test(kind)) continue;
        add(job.id);
        add(job.sessionID);
        add(job.childSessionID);
      }
    }
    const part = event.part;
    if (part && typeof part === "object" && /subagent/i.test(String(part.tool ?? ""))) {
      const state = part.state ?? {};
      const metadata = state.metadata ?? {};
      add(metadata.metadata?.sessionID);
      add(metadata.sessionID);
      add(state.sessionID);
      add(state.childSessionID);
    }
  }
  return [...ids];
}

async function exportChildSession(cli, childID, parentID, cwd) {
  let lastError = null;
  let lastExported = null;
  let lastAssessment = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= EXPORT_RETRIES; attempt++) {
    attempts = attempt + 1;
    const result = spawnSync(cli, ["session", "export", childID], {
      cwd, encoding: "utf8", windowsHide: true, timeout: EXPORT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) {
      lastError = result.error;
    } else if (result.status !== 0) {
      lastError = new Error(oneLine(result.stderr || result.stdout).slice(0, 300) || `exit ${result.status}`);
    } else {
      try {
        lastExported = JSON.parse(result.stdout.replace(/^\uFEFF+/, ""));
        lastAssessment = assessExport(lastExported, childID, parentID);
        if (lastAssessment.verified || !lastAssessment.retryable) {
          return { exported: lastExported, attempts, assessment: lastAssessment };
        }
        lastError = new Error(lastAssessment.reason);
      } catch (error) {
        lastError = new Error("export JSON parse failed: " + error.message);
      }
    }
    if (attempt < EXPORT_RETRIES) await sleep(250 * (attempt + 1));
  }
  if (lastExported) return { exported: lastExported, attempts, assessment: lastAssessment };
  throw new Error(`session export failed for ${childID}: ${oneLine(lastError?.message).slice(0, 300) || "unknown error"}`);
}

function assessExport(exported, childID, parentID) {
  const fail = (reason, parentIDMatches = false, retryable = false) => ({ verified: false, reason, parentIDMatches, retryable });
  if (!exported || typeof exported !== "object" || !Array.isArray(exported.messages)) {
    return fail("export has no root messages array");
  }
  const info = exported.info && typeof exported.info === "object" ? exported.info : {};
  const messages = exported.messages;
  if (info.error || exported.error) return fail("child session export reports an error");
  if (info.id !== childID) return fail(`export info.id ${info.id ?? "missing"} does not match child ${childID}`);
  const parent = info.parentID;
  if (!parent) return fail("export info.parentID is missing", false, true);
  if (parent !== parentID) return fail(`export info.parentID ${parent} does not match parent ${parentID}`);
  const outcome = typeof info.outcome === "string" ? info.outcome.toLowerCase() : null;
  if (!outcome || /running|pending|in.?progress|busy/i.test(outcome)) {
    return fail(`child is still running (outcome ${outcome ?? "missing"})`, true, true);
  }
  if (!/^(succeeded|success|completed|complete)$/.test(outcome)) {
    return fail(`child outcome is ${outcome}`, true);
  }
  const errorMessages = messages.filter((message) => message &&
    (message.type === "error" || (message.error && typeof message.error === "object" &&
      (message.error.message || message.error.name))));
  if (errorMessages.length) {
    return fail(`child session contains ${errorMessages.length} terminal error message(s)`, true);
  }
  if (!Number.isFinite(info.time?.idle)) return fail("child session has no terminal idle time", true, true);
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.type !== "idle") return fail("child session does not end with an idle message", true, true);
  const completedAssistant = messages.some((message) => {
    if (!message || message.type !== "assistant" || !Number.isFinite(message.time?.completed)) return false;
    if (typeof message.text === "string" && message.text.trim()) return true;
    return Array.isArray(message.content) && message.content.some((part) =>
      part?.type === "text" && typeof part.text === "string" && part.text.trim());
  });
  if (!completedAssistant) return fail("child session has no completed assistant response", true, true);
  return { verified: true, outcome, parentIDMatches: true };
}

function briefSelfReport(exported) {
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  for (const preferText of [true, false]) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!message || (message.type !== "assistant" && message.type !== "finish")) continue;
      const parts = Array.isArray(message.content) ? message.content :
        (Array.isArray(message.parts) ? message.parts : []);
      const text = parts
        .filter((part) => preferText ? part?.type === "text" && typeof part.text === "string" : typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return truncate(oneLine(text), 360);
    }
  }
  return null;
}

// ---- concurrent child processes and bounded waits ----

async function waitForChildren(children, totalBudget) {
  const hardDeadline = Date.now() + totalBudget + KILL_GRACE_MS + 15000;
  while (true) {
    const now = Date.now();
    for (const record of children) {
      if (record.closed) continue;
      if (record.exitCode !== null || record.signalCode !== null) {
        record.closed = true;
        continue;
      }
      const elapsed = now - record.startedAt;
      if (!record.timedOut && elapsed >= record.budgetMs) {
        record.timedOut = true;
        record.killAt = now;
        debug(`${record.name}: budget exhausted, terminating`);
        try { record.child.kill(); } catch (error) { debug(`${record.name}: kill failed: ${error.message}`); }
      } else if (record.timedOut && record.killAt && now - record.killAt >= KILL_GRACE_MS && !record.killedHard) {
        record.killedHard = true;
        try { record.child.kill("SIGKILL"); } catch {}
      }
    }
    if (children.every((record) => record.closed)) return;
    if (Date.now() >= hardDeadline) {
      for (const record of children) {
        if (!record.closed) {
          record.timedOut = true;
          record.abandoned = true;
        }
      }
      debug("hard wait deadline reached");
      return;
    }
    await sleep(POLL_MS);
  }
}

function initialWorkerRecord(record, context, suffix = "") {
  const spec = record.spec;
  const endedAt = record.endedAt ?? null;
  const worker = {
    name: spec.name,
    status: "failed",
    model: spec.model,
    agent: spec.agent,
    workerPath: context.workers[spec.name],
    writeScope: spec.writeScope,
    parentSessionID: null,
    childSessionID: null,
    childIDCount: 0,
    startedAt: record.startedAt,
    endedAt,
    // Active process time only: excludes waiting for siblings and verification.
    elapsedMs: endedAt === null ? Date.now() - record.startedAt : Math.max(0, endedAt - record.startedAt),
    exitCode: record.exitCode,
    signal: record.signalCode ?? null,
    timedOut: Boolean(record.timedOut),
    log: path.join(context.run, spec.name + suffix + ".jsonl"),
    processLog: record.processLog,
    exportLog: null,
    diff: null,
    changedPaths: [],
    changedPathCount: 0,
    changedPathsError: null,
    outOfScopePaths: [],
    selfReport: { text: null, selfReported: true, truncated: false },
    verification: { verified: false, reason: null, outcome: null, parentIDMatches: false, exportAttempts: 0 },
    reason: null,
  };
  return worker;
}

// Snapshot files only after verification has confirmed (or rejected) the child
// session. A CLI exit or failed/unverified export does not prove the remote
// child stopped writing: even failed workers are inventoried here, and a session
// that is still running may change files after this inventory is taken.
function captureWorkerChanges(worker, context, suffix = "") {
  try {
    worker.changedPaths = compareTrees(context.baseline, worker.workerPath, context.source);
    worker.changedPathCount = worker.changedPaths.length;
    worker.artifactHashes = artifactHashes(worker.workerPath, worker.changedPaths);
  } catch (error) {
    // A missing changed-file inventory must never be treated as a clean result.
    worker.changedPathsError = oneLine(error.message).slice(0, 300);
    worker.artifactHashes = {};
  }
  try {
    worker.diff = writeFullDiff(context.run, worker.name, context.baseline, worker.workerPath, suffix);
  } catch (error) {
    worker.diffError = oneLine(error.message).slice(0, 300);
  }
  return worker;
}

async function verifyWorker(record, context, cli, suffix = "") {
  const worker = initialWorkerRecord(record, context, suffix);
  const logPath = worker.log;
  if (record.spawnError) {
    worker.reason = "worker process failed to spawn: " + oneLine(record.spawnError).slice(0, 200);
    return worker;
  }
  if (record.timedOut) {
    worker.reason = `worker exceeded the ${Math.round(record.budgetMs / 60000)} minute execution budget; remote child may still run after a timeout`;
    return worker;
  }
  if (record.exitCode !== 0) {
    const tail = oneLine(tailFile(record.processLog, 500));
    worker.reason = `worker CLI exited with ${record.exitCode ?? record.signalCode ?? "unknown"}` +
      (tail ? ": " + truncate(tail, 200) : "");
    return worker;
  }
  const { events, readError } = readLogEvents(logPath);
  if (readError) {
    worker.reason = "worker log is unreadable: " + oneLine(readError).slice(0, 200);
    return worker;
  }
  const parent = findParentSessionID(events);
  worker.parentSessionID = parent.id;
  if (!parent.id) {
    worker.reason = "parent session id not found in worker log";
    return worker;
  }
  const childIDs = findChildSessionIDs(events).filter((id) => id !== parent.id);
  worker.childIDCount = childIDs.length;
  worker.childSessionID = childIDs.length === 1 ? childIDs[0] : null;
  if (childIDs.length !== 1) {
    worker.reason = `expected exactly one child session id for parent, found ${childIDs.length}`;
    return worker;
  }
  try {
    const { exported, attempts, assessment } = await exportChildSession(cli, childIDs[0], parent.id, worker.workerPath);
    worker.exportLog = path.join(context.run, record.spec.name + suffix + ".export.json");
    fs.writeFileSync(worker.exportLog, JSON.stringify(exported, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    worker.verification = {
      verified: assessment.verified,
      reason: assessment.reason ?? null,
      outcome: assessment.outcome ?? null,
      parentIDMatches: assessment.parentIDMatches,
      exportAttempts: attempts,
    };
    const selfReport = briefSelfReport(exported);
    worker.selfReport.text = selfReport;
    worker.selfReport.truncated = Boolean(selfReport && selfReport.endsWith("…"));
    if (!assessment.verified) {
      worker.status = "unverified";
      worker.reason = assessment.reason;
      return worker;
    }
  } catch (error) {
    worker.status = "unverified";
    worker.reason = oneLine(error.message).slice(0, 300);
    return worker;
  }
  worker.status = "completed";
  return worker;
}

// Strict branch for `opencode run --session <child>`. That command emits the
// continued child as event.sessionID, so the ordinary parent/child discovery
// must not be reused here.
async function verifyRetriedWorker(record, context, cli, expected, suffix = "") {
  const worker = initialWorkerRecord(record, context, suffix);
  worker.parentSessionID = expected.parentID;
  worker.childSessionID = expected.childID;
  worker.childIDCount = 1;
  worker.continuedSession = true;
  const retryHint = " Use a fresh scoped batch.";
  if (record.spawnError) {
    worker.reason = "retry process failed to spawn: " + oneLine(record.spawnError).slice(0, 200) + retryHint;
    return worker;
  }
  if (record.timedOut) {
    worker.reason = `retry CLI timed out after ${Math.round(record.budgetMs / 60000)} minute(s); the child may still run.` + retryHint;
    return worker;
  }
  if (record.exitCode !== 0) {
    const tail = oneLine(tailFile(record.processLog, 500));
    worker.reason = `retry CLI exited with ${record.exitCode ?? record.signalCode ?? "unknown"}` +
      (tail ? ": " + truncate(tail, 200) : "") + retryHint;
    return worker;
  }
  const { events, readError } = readLogEvents(worker.log);
  if (readError) {
    worker.reason = "retry log is unreadable: " + oneLine(readError).slice(0, 200) + retryHint;
    return worker;
  }
  const logged = [...new Set(events.map((event) => event.sessionID)
    .filter((id) => typeof id === "string" && SESSION_RE.test(id)))];
  if (logged.length !== 1 || logged[0] !== expected.childID) {
    worker.reason = `continued session log must contain only recorded child ${expected.childID}; found ` +
      (logged.join(", ") || "none") + "." + retryHint;
    return worker;
  }
  let exported;
  let attempts;
  let assessment;
  try {
    ({ exported, attempts, assessment } = await exportChildSession(cli, expected.childID, expected.parentID, worker.workerPath));
  } catch (error) {
    worker.status = "unverified";
    worker.reason = "retry session export failed: " + oneLine(error?.message ?? error).slice(0, 300) + retryHint;
    return worker;
  }
  worker.exportLog = path.join(context.run, record.spec.name + suffix + ".export.json");
  fs.writeFileSync(worker.exportLog, JSON.stringify(exported, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  worker.verification = {
    verified: assessment.verified,
    reason: assessment.reason ?? null,
    outcome: assessment.outcome ?? null,
    parentIDMatches: assessment.parentIDMatches,
    exportAttempts: attempts,
    retryStartedAt: expected.startedAt,
    retryEndedAt: record.endedAt,
  };
  const info = exported?.info && typeof exported.info === "object" ? exported.info : {};
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  const last = messages[messages.length - 1];
  const idle = info.time?.idle;
  const lastTime = last?.time?.idle ?? last?.time?.created ?? null;
  if (!assessment.verified || info.id !== expected.childID || info.parentID !== expected.parentID) {
    worker.status = "unverified";
    worker.reason = (assessment.reason ?? "retry export does not confirm the recorded child and parent") + retryHint;
    return worker;
  }
  if (!Number.isFinite(idle) || idle < expected.startedAt ||
      (Number.isFinite(lastTime) && lastTime < expected.startedAt)) {
    worker.status = "unverified";
    worker.reason = "retry session has no new terminal completed idle after retry start." + retryHint;
    return worker;
  }
  worker.status = "completed";
  return worker;
}

function applyQualityGate(report, specs) {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const gate = {
    // Post-execution check: declarations and observed changes, never a sandbox.
    postExecutionOnly: true,
    isolatedCopiesAreNotOsSandbox: true,
    outOfScopePaths: {},
    conflicts: [],
    changedPathErrors: [],
  };
  const reasons = new Map();
  const addReason = (name, kind, text, paths = [], owners = []) => {
    if (!reasons.has(name)) reasons.set(name, []);
    reasons.get(name).push({ kind, text, paths, owners });
  };

  for (const worker of report.workers) {
    const spec = byName.get(worker.name);
    if (worker.changedPathsError) {
      gate.changedPathErrors.push({ worker: worker.name, error: worker.changedPathsError });
      addReason(worker.name, "changed-paths-error", "changed files could not be computed: " + worker.changedPathsError);
    }
    if (spec?.scopes?.length) {
      const violations = findOutOfScopePaths(spec.scopes, worker.changedPaths);
      worker.outOfScopePaths = violations;
      if (violations.length) {
        gate.outOfScopePaths[worker.name] = violations;
        addReason(worker.name, "out-of-scope", `${violations.length} changed path(s) outside the declared write scope`, violations);
      }
    }
  }

  const observed = detectChangedPathConflicts(report.workers.map((worker) => ({
    name: worker.name, changedPaths: worker.changedPaths,
  })));
  gate.conflicts = observed.conflicts;
  for (const [name, items] of Object.entries(observed.byWorker)) {
    if (!items.length) continue;
    const paths = [...new Set(items.flatMap((item) => item.paths))];
    const owners = [...new Set(items.map((item) => item.with).filter(Boolean))];
    addReason(name, "conflict", `changed paths overlap with ${owners.join(", ")}`, paths, owners);
  }

  for (const worker of report.workers) {
    const own = reasons.get(worker.name) ?? [];
    if (!own.length) continue;
    worker.previousStatus = worker.status;
    worker.status = "blocked";
    worker.qualityGate = {
      blocked: true,
      reasons: own.map((item) => ({
        kind: item.kind,
        text: item.text,
        pathCount: item.paths.length,
        paths: item.paths.slice(0, DISPLAY_PATH_LIMIT),
        pathsTruncated: item.paths.length > DISPLAY_PATH_LIMIT,
        owners: item.owners,
      })),
    };
    worker.reason = [worker.reason, ...own.map((item) => item.text)].filter(Boolean).join("; ");
  }
  report.qualityGate = gate;
}

function buildStdoutReport(report) {
  return {
    status: report.status,
    run: report.run,
    source: report.source,
    baseline: report.baseline,
    summary: report.summary,
    mode: report.mode ?? null,
    baseSha: report.baseSha ?? null,
    timing: report.timing,
    workers: report.workers.map((worker) => ({
      name: worker.name,
      status: worker.status,
      model: worker.model,
      parent: worker.parentSessionID,
      child: worker.childSessionID,
      elapsedMs: worker.elapsedMs,
      changed: worker.changedPathCount,
      paths: worker.changedPaths.slice(0, DISPLAY_PATH_LIMIT)
        .map((item) => item.status[0] + ":" + item.path),
      pathsTruncated: worker.changedPaths.length > DISPLAY_PATH_LIMIT,
      selfReported: worker.selfReport.text
        ? { selfReported: true, text: truncate(worker.selfReport.text, 200) }
        : null,
      reason: worker.reason ? truncate(worker.reason, 200) : null,
      writeScope: worker.writeScope ?? [],
      qualityGate: worker.qualityGate ?? null,
      log: worker.log,
    })),
  };
}

async function batch(project, planFile) {
  // Validate the entire specification before creating a run or starting any process.
  let specs;
  let context;
  let workspaceMode;
  try {
    const plan = readPlan(planFile);
    specs = plan.specs;
    workspaceMode = plan.workspace;
    context = createRun(project, specs.map((spec) => spec.name), workspaceMode);
  } catch (error) {
    console.log(JSON.stringify({
      status: "invalid",
      error: oneLine(error?.message ?? error).slice(0, 300),
      workers: [],
    }));
    process.exitCode = 1;
    return;
  }
  const cli = openCode();
  const started = Date.now();
  const report = {
    command: "batch",
    status: "incomplete",
    run: context.run,
    source: context.source,
    baseline: context.baseline,
    summary: path.join(context.run, "summary.json"),
    mode: context.manifest.mode,
    baseSha: context.manifest.baseSha,
    workspace: context.manifest.workspace,
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: 0,
    policy: {
      independentTicketsOnly: true, maxConcurrentWorkers: MAX_WORKERS, noSourceCopy: true,
      coordinatorModel: null, writeScopeGate: "post-execution", isolatedCopiesAreNotOsSandbox: true,
      workspaceMode, noCommits: true, noAutomaticCleanup: true, pythonBytecodeDisabled: true,
    },
    workers: [],
  };

  for (const spec of specs) {
    const promptFile = path.join(context.run, spec.name + ".prompt.txt");
    fs.writeFileSync(promptFile, assignmentWithScope(spec), { encoding: "utf8", flag: "wx" });
    spec.promptFile = promptFile;
  }

  const totalBudget = budgetMs();
  const internalCliBudget = Math.max(1000, totalBudget - CLI_FINISH_MARGIN_MS);
  const children = [];
  for (const spec of specs) {
    const processLog = path.join(context.run, spec.name + ".process.log");
    const handle = fs.openSync(processLog, "wx");
    const child = spawn(process.execPath, [
      __filename, "run", context.run, spec.name, spec.model, spec.promptFile, spec.agent, String(internalCliBudget),
    ], {
      cwd: context.workers[spec.name],
      stdio: ["ignore", handle, handle],
      windowsHide: true,
      env: workerEnvironment(),
    });
    const record = {
      spec, child, handle, processLog,
      startedAt: Date.now(), endedAt: null, budgetMs: totalBudget,
      exitCode: null, signalCode: null, closed: false,
      timedOut: false, killAt: null, killedHard: false,
      abandoned: false, spawnError: null,
    };
    const markEnd = () => { if (record.endedAt === null) record.endedAt = Date.now(); };
    child.on("error", (error) => { record.spawnError = error.message; markEnd(); });
    child.on("exit", (code, signal) => { record.exitCode = code; record.signalCode = signal; markEnd(); });
    child.on("close", (code, signal) => {
      if (record.exitCode === null && record.signalCode === null) {
        record.exitCode = code;
        record.signalCode = signal;
      }
      markEnd();
      record.closed = true;
    });
    children.push(record);
    debug(`spawned ${spec.name}`);
  }

  await waitForChildren(children, totalBudget);
  for (const record of children) {
    try { fs.closeSync(record.handle); } catch {}
  }
  for (const record of children) {
    const worker = await verifyWorker(record, context, cli);
    report.workers.push(captureWorkerChanges(worker, context));
  }

  try {
    applyQualityGate(report, specs);
  } catch (error) {
    // A gate failure is evidence of an unverifiable batch, never a pass.
    report.qualityGate = { postExecutionOnly: true, internalError: oneLine(error?.message ?? error).slice(0, 300) };
    for (const worker of report.workers) {
      worker.previousStatus = worker.previousStatus ?? worker.status;
      worker.status = "blocked";
      worker.reason = "quality gate could not be evaluated: " + oneLine(error?.message ?? error).slice(0, 200);
    }
  }

  const finished = Date.now();
  report.finishedAt = new Date(finished).toISOString();
  report.durationMs = finished - started;
  report.timing = buildTiming(report.workers, report.durationMs);
  report.status = report.workers.length === specs.length &&
    report.workers.every((worker) => worker.status === "completed") &&
    !report.workers.some((worker) => worker.qualityGate?.blocked) ? "ok" : "incomplete";
  fs.writeFileSync(report.summary, JSON.stringify(report, null, 2) + "\n", {
    encoding: "utf8", flag: "wx",
  });
  console.log(JSON.stringify(buildStdoutReport(report)));
  if (report.status !== "ok") process.exitCode = 1;
}

// ---- assembly and targeted retry ----

function commandAssemble(run, names) {
  try {
    const { record, manifestPath } = assembleRun(run, names);
    console.log(JSON.stringify({
      status: "ok", run: record.run, assembly: record.assembly, manifest: manifestPath,
      mode: record.mode, baseSha: record.baseSha,
      workers: record.workers.map((worker) => worker.name),
      affectedFiles: record.affectedFiles,
    }));
  } catch (error) {
    // Fail closed: any partial assembly is kept in place for inspection.
    console.log(JSON.stringify({ status: "failed", error: oneLine(error?.message ?? error).slice(0, 500) }));
    process.exitCode = 1;
  }
}

function commandVerifyAssembly(assembly) {
  try {
    const result = verifyAssemblyReport(assembly);
    console.log(JSON.stringify(result));
    if (result.status !== "ok") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", error: oneLine(error?.message ?? error).slice(0, 500) }));
    process.exitCode = 1;
  }
}

function retrySuffix(run, name) {
  let index = 1;
  while (fs.existsSync(path.join(run, `${name}.retry-${index}.jsonl`)) ||
         fs.existsSync(path.join(run, `${name}.retry-${index}.report.json`))) index++;
  return `.retry-${index}`;
}

function spawnRetry(cli, args, cwd, outHandle, errHandle, timeout) {
  return spawnSync(cli, args, {
    cwd, stdio: ["ignore", outHandle, errHandle], windowsHide: true,
    env: workerEnvironment(), timeout,
  });
}

async function retry(run, name, promptFile) {
  const cli = openCode();
  const { directory, manifest, summary } = loadRun(run);
  const worker = summary.workers?.find((item) => item.name === name);
  if (!worker) throw new Error(`Unknown worker: ${name}`);
  const completed = worker.status === "completed" && worker.verification?.verified === true;
  const originalPromptFile = path.join(directory, name + ".prompt.txt");
  if (completed && !promptFile) {
    throw new Error(`Worker ${name} is completed; an explicit revised assignment file is required to retry it.`);
  }
  const assignmentFile = promptFile ?? originalPromptFile;
  const assignment = fs.readFileSync(assignmentFile, "utf8");
  if (completed && fs.existsSync(originalPromptFile) && assignment === fs.readFileSync(originalPromptFile, "utf8")) {
    throw new Error(`Revised assignment for ${name} must differ from the original assignment.`);
  }
  if (!SESSION_RE.test(worker.parentSessionID ?? "") || !SESSION_RE.test(worker.childSessionID ?? "")) {
    throw new Error(`Cannot retry ${name}: recorded parent/child IDs are unavailable. Use a fresh scoped batch.`);
  }
  const findings = checkSourceStability({
    source: manifest.source, baselineHashes: manifest.baselineHashes ?? {},
    paths: worker.changedPaths ?? [], scopes: worker.writeScope ?? [],
  });
  if (findings.length) {
    throw new Error(`Cannot retry ${name}: source changed since the run: ` +
      findings.map((item) => `${item.kind} ${item.path}`).join("; "));
  }
  if (completed) {
    // Reviewer-rejected completed work is retried in place: pin the current
    // worker tree as the pre-retry state and keep all other records untouched.
    const current = compareTrees(manifest.baseline, worker.workerPath, manifest.source);
    worker.changedPaths = current;
    worker.changedPathCount = current.length;
    worker.artifactHashes = artifactHashes(worker.workerPath, current);
  } else {
    assertWorkerArtifacts({ ...worker, _baseline: manifest.baseline }, manifest.source);
  }

  const lockPath = path.join(directory, "retry.lock");
  let lockHandle;
  try {
    lockHandle = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another retry is in progress for ${run}; wait or remove ${lockPath} if stale.`);
    throw error;
  }
  try {
    fs.writeSync(lockHandle, JSON.stringify({ worker: name, at: new Date().toISOString(), pid: process.pid }) + "\n");
    const suffix = retrySuffix(directory, name);
    const log = path.join(directory, name + suffix + ".jsonl");
    const processLog = path.join(directory, name + suffix + ".process.log");
    const reportPath = path.join(directory, name + suffix + ".report.json");
    const timeout = Math.max(1000, budgetMs() - CLI_FINISH_MARGIN_MS);
    const model = worker.model ?? DEFAULT_MODEL;
    const agent = worker.agent ?? DEFAULT_AGENT;
    const title = "Codex worker retry: " + name;
    const startedAt = Date.now();
    let endedAt = startedAt;
    let result;
    const logHandle = fs.openSync(log, "wx");
    const processHandle = fs.openSync(processLog, "wx");
    try {
      // Continue the original child agent. No --agent override and no fresh
      // direct build fallback: unsupported continuation fails explicitly.
      result = spawnRetry(cli, ["run", "--session", worker.childSessionID, "--model", model,
        "--format", "json", "--title", title, assignment],
      worker.workerPath, logHandle, processHandle, timeout);
    } finally {
      endedAt = Date.now();
      fs.closeSync(logHandle);
      fs.closeSync(processHandle);
    }

    const spec = {
      name, model, agent, writeScope: worker.writeScope ?? [],
      scopes: worker.writeScope?.length
        ? normalizeWriteScopes(worker.writeScope, "retry.writeScope") : [],
    };
    const context = { run: directory, baseline: manifest.baseline, workers: { [name]: worker.workerPath } };
    const record = {
      spec, child: null, handle: null, processLog,
      startedAt, endedAt, budgetMs: timeout,
      exitCode: result.status, signalCode: result.signal ?? null, closed: true,
      timedOut: result.error?.code === "ETIMEDOUT", killAt: null, killedHard: false,
      abandoned: false,
      spawnError: result.error && result.error.code !== "ETIMEDOUT" ? result.error.message : null,
    };
    const checked = captureWorkerChanges(await verifyRetriedWorker(record, context, cli, {
      parentID: worker.parentSessionID, childID: worker.childSessionID, startedAt,
    }, suffix), context, suffix);
    const gateReport = { workers: [checked] };
    try {
      applyQualityGate(gateReport, [spec]);
    } catch (error) {
      checked.status = "blocked";
      checked.reason = "retry quality gate could not be evaluated: " + oneLine(error?.message ?? error).slice(0, 200);
    }
    const retryReport = {
      command: "retry", run: directory, worker: name, status: checked.status,
      session: { parent: worker.parentSessionID, child: worker.childSessionID, continued: true },
      revisedAssignment: completed, agent, startedAt, endedAt, elapsedMs: endedAt - startedAt,
      log, processLog, exportLog: checked.exportLog ?? null, diff: checked.diff ?? null,
      verification: checked.verification, changedPaths: checked.changedPaths,
      qualityGate: checked.qualityGate ?? null, reason: checked.reason,
    };
    if (checked.status !== "completed" || checked.qualityGate?.blocked) {
      fs.writeFileSync(reportPath, JSON.stringify(retryReport, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      console.log(JSON.stringify({ status: "incomplete", report: reportPath, reason: checked.reason }));
      process.exitCode = 1;
      return;
    }
    const fields = ["status", "verification", "changedPaths", "changedPathCount", "artifactHashes",
      "diff", "exportLog", "selfReport", "reason", "outOfScopePaths", "qualityGate",
      "startedAt", "endedAt", "elapsedMs", "parentSessionID", "childSessionID", "continuedSession", "log", "processLog"];
    const updated = { ...worker };
    for (const field of fields) if (checked[field] !== undefined) updated[field] = checked[field];
    updated.retryHistory = [...(worker.retryHistory ?? []), {
      at: new Date().toISOString(), suffix, log, processLog,
      session: retryReport.session, revisedAssignment: completed,
      startedAt, endedAt,
    }];
    summary.workers = summary.workers.map((item) => item.name === name ? updated : item);
    retryReport.summaryUpdated = true;
    fs.writeFileSync(reportPath, JSON.stringify(retryReport, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify({ status: "ok", report: reportPath, worker: name, changedPaths: checked.changedPaths.length }));
  } finally {
    fs.closeSync(lockHandle);
    fs.rmSync(lockPath, { force: true });
  }
}

function handleError(error) {
  console.error(oneLine(error?.message ?? error));
  process.exitCode = 1;
}

function main(argv) {
  const [action, ...args] = argv;
  switch (action) {
    case "prepare": prepare(args[0], args.slice(1)); break;
    case "run": runWorker(...args); break;
    case "diff": reportDiff(...args); break;
    case "batch": Promise.resolve(batch(args[0], args[1])).catch(handleError); break;
    case "assemble": commandAssemble(args[0], args.slice(1)); break;
    case "verify": commandVerifyAssembly(args[0]); break;
    case "retry": Promise.resolve(retry(args[0], args[1], args[2])).catch(handleError); break;
    default: throw new Error("Expected prepare, run, diff, batch, assemble, verify, or retry");
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    handleError(error);
  }
}

module.exports = {
  workerEnvironment, readPlan, validatePlan, compareTrees, captureWorkerChanges,
  createRun, prepare, batch, commandAssemble, commandVerifyAssembly, retry, main,
  verifyRetriedWorker,
};
