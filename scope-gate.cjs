"use strict";

// Pure helpers for the batch write-scope gate. No I/O and no OpenCode dependency,
// so the rules can be exercised with `node --test` alone.

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FORBIDDEN_CHARS = /[\\:*?"<>|\x00-\x1f]/;

function normalizeSlashes(value) {
  return String(value ?? "").split("\\").join("/");
}

function foldPath(value) {
  return normalizeSlashes(value).toLowerCase();
}

// A scope is either an exact file path ("src/app.ts") or a directory prefix
// written with a trailing slash ("src/"). Keys are folded for Windows-style
// case-insensitive comparison; the trailing slash preserves component boundaries.
function normalizeWriteScope(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!value.trim()) throw new Error(`${label} must not be whitespace-only`);
  if (/^\s|\s$/.test(value)) throw new Error(`${label} must not start or end with whitespace`);
  if (value.includes("\\")) throw new Error(`${label} must use forward slashes, not backslashes`);
  if (FORBIDDEN_CHARS.test(value)) {
    throw new Error(`${label} contains non-portable characters (wildcards, colon or control characters)`);
  }
  if (value.startsWith("/")) throw new Error(`${label} must be project-relative, not absolute`);
  if (/^[A-Za-z]:/.test(value)) throw new Error(`${label} must not use a drive letter or drive-relative path`);

  const directory = value.endsWith("/");
  const raw = directory ? value.slice(0, -1) : value;
  if (!raw) throw new Error(`${label} must name a file or directory`);
  for (const component of raw.split("/")) {
    if (!component) throw new Error(`${label} must not contain empty path components`);
    if (component === "." || component === "..") throw new Error(`${label} must not contain . or .. components`);
    if (/^\s|\s$/.test(component)) throw new Error(`${label} has a component with leading or trailing whitespace`);
    if (/[. ]$/.test(component)) throw new Error(`${label} has a component ending with a dot or space`);
    if (RESERVED_WINDOWS_NAMES.test(component.split(".")[0])) {
      throw new Error(`${label} uses a reserved Windows device name`);
    }
  }
  return { kind: directory ? "dir" : "file", value, key: foldPath(value) };
}

function normalizeWriteScopes(values, label) {
  // Callers pass this only when the field is present: null/[] is an explicit
  // (invalid) attempt to disable the gate, not a request for legacy behavior.
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array of project-relative paths when provided`);
  }
  const scopes = [];
  const seen = new Set();
  values.forEach((value, index) => {
    const scope = normalizeWriteScope(value, `${label}[${index}]`);
    if (seen.has(scope.key)) throw new Error(`${label} contains duplicate scope: ${scope.value}`);
    seen.add(scope.key);
    scopes.push(scope);
  });
  return scopes;
}

function scopesOverlap(a, b) {
  if (a.kind === "dir" && b.kind === "dir") {
    return a.key.startsWith(b.key) || b.key.startsWith(a.key);
  }
  // A declared exact file cannot also be a parent of another declared path
  // on Windows: "a.txt" collides with both "a.txt/sub.txt" and "a.txt/sub/".
  if (a.kind === "file" && b.kind === "file") {
    return a.key === b.key || a.key.startsWith(b.key + "/") || b.key.startsWith(a.key + "/");
  }
  const file = a.kind === "file" ? a : b;
  const dir = a.kind === "dir" ? a : b;
  return file.key === dir.key.slice(0, -1) || file.key.startsWith(dir.key) || dir.key.startsWith(file.key + "/");
}

// Reject overlapping declarations before any run, snapshot or process is created.
function validateScopeBoundaries(specs) {
  for (let i = 0; i < specs.length; i++) {
    const left = specs[i];
    if (!left.scopes?.length) continue;
    for (let j = i + 1; j < specs.length; j++) {
      const right = specs[j];
      if (!right.scopes?.length) continue;
      for (const a of left.scopes) {
        for (const b of right.scopes) {
          if (scopesOverlap(a, b)) {
            throw new Error(`Overlapping write scopes: ${left.name} declares ${a.value}, ${right.name} declares ${b.value}`);
          }
        }
      }
    }
  }
}

function scopeAllowsPath(scopes, changedPath) {
  if (!scopes || scopes.length === 0) return true;
  const key = foldPath(changedPath);
  return scopes.some((scope) => scope.kind === "dir" ? key.startsWith(scope.key) : key === scope.key);
}

// Accepts strings or { path, status } entries; deletes and additions are checked too.
function findOutOfScopePaths(scopes, changedPaths) {
  return (changedPaths ?? [])
    .map((entry) => typeof entry === "string" ? entry : entry?.path)
    .filter((path) => typeof path === "string" && !scopeAllowsPath(scopes, path));
}

function ancestorKeys(key) {
  const parts = key.split("/");
  const result = [];
  for (let index = 1; index < parts.length; index++) result.push(parts.slice(0, index).join("/"));
  return result;
}

// Observed conflicts, computed from changed files only, with or without declarations.
function detectChangedPathConflicts(workers) {
  const byKey = new Map();
  for (const worker of workers ?? []) {
    for (const change of worker.changedPaths ?? []) {
      const raw = typeof change === "string" ? change : change?.path;
      if (typeof raw !== "string" || !raw) continue;
      const entry = { worker: worker.name, path: raw, key: foldPath(raw) };
      if (!byKey.has(entry.key)) byKey.set(entry.key, []);
      byKey.get(entry.key).push(entry);
    }
  }

  const pairs = new Map();
  const record = (a, b, kind, paths) => {
    if (a.worker === b.worker) return;
    const names = [a.worker, b.worker].sort();
    const id = names.join("\u0000");
    let pair = pairs.get(id);
    if (!pair) {
      pair = { workers: names, kinds: new Set(), paths: new Set() };
      pairs.set(id, pair);
    }
    pair.kinds.add(kind);
    for (const path of paths) pair.paths.add(path);
  };

  for (const [key, entries] of byKey) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        record(entries[i], entries[j], "same-path", [entries[i].path, entries[j].path]);
      }
    }
    for (const ancestor of ancestorKeys(key)) {
      for (const child of entries) {
        for (const parent of byKey.get(ancestor) ?? []) {
          record(child, parent, "ancestor-path", [child.path, parent.path]);
        }
      }
    }
  }

  const conflicts = [...pairs.values()].map((pair) => ({
    workers: pair.workers,
    kinds: [...pair.kinds].sort(),
    paths: [...pair.paths].sort((a, b) => a.localeCompare(b)),
  }));
  const byWorker = Object.fromEntries((workers ?? []).map((worker) => [worker.name, []]));
  for (const conflict of conflicts) {
    for (const name of conflict.workers) {
      if (!byWorker[name]) byWorker[name] = [];
      byWorker[name].push({
        with: conflict.workers.find((other) => other !== name) ?? null,
        kinds: conflict.kinds,
        paths: conflict.paths,
      });
    }
  }
  return { conflicts, byWorker };
}

// Intervals use the recorded process end, not the later verification time.
function buildTiming(workers, batchWallMs) {
  const measured = (workers ?? []).map((worker) => {
    const start = worker.startedAt;
    const end = worker.endedAt;
    const valid = Number.isFinite(start) && Number.isFinite(end);
    return { name: worker.name, start, end, valid, elapsedMs: valid ? Math.max(0, end - start) : worker.elapsedMs };
  });
  const timing = {
    batchWallMs: Number.isFinite(batchWallMs) ? batchWallMs : null,
    longestWorker: null,
    longestWorkerMs: null,
    parallel: null,
    note: null,
  };
  if (measured.some((entry) => !entry.valid)) {
    timing.note = "A worker process has no recorded end; worker and parallel metrics omitted.";
    return timing;
  }
  const longest = measured.length ? measured.reduce((a, b) => b.elapsedMs > a.elapsedMs ? b : a) : null;
  timing.longestWorker = longest?.name ?? null;
  timing.longestWorkerMs = longest?.elapsedMs ?? null;
  if (measured.length < 2) {
    timing.note = "Only one worker; no parallel overlap to measure.";
    return timing;
  }
  const intervals = measured.map((worker) => [Math.min(worker.start, worker.end), Math.max(worker.start, worker.end)])
    .sort((a, b) => a[0] - b[0]);
  let unionMs = 0;
  let start = intervals[0][0];
  let end = intervals[0][1];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else { unionMs += end - start; start = nextStart; end = nextEnd; }
  }
  unionMs += end - start;
  const activeSumMs = measured.reduce((sum, worker) => sum + worker.elapsedMs, 0);
  if (!Number.isFinite(unionMs) || unionMs <= 0) {
    timing.note = "Worker intervals do not form a measurable window; parallel metrics omitted.";
    return timing;
  }
  timing.parallel = {
    activeSumMs,
    // Runtime covered by at least one worker (union of process intervals).
    unionMs,
    // Sum of active process times minus that union: saved wall-clock time,
    // not a duration during which two or more workers were simultaneously active.
    parallelWorkerMsSaved: Math.max(0, activeSumMs - unionMs),
    parallelismRatio: Number((activeSumMs / unionMs).toFixed(3)),
    method: "union of worker process intervals ending at exit/close",
  };
  return timing;
}

module.exports = {
  normalizeSlashes,
  foldPath,
  normalizeWriteScope,
  normalizeWriteScopes,
  scopesOverlap,
  validateScopeBoundaries,
  scopeAllowsPath,
  findOutOfScopePaths,
  detectChangedPathConflicts,
  buildTiming,
};
