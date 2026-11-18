'use strict';

// Наблюдатель за реальными запусками OpenCode. Только чтение.
// Никогда не меняет исходный проект, не запускает и не останавливает агентов,
// не читает промпты и не выводит рассуждения — только структурные факты.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STALE_MS = 30 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;
const SESSION_RE = /^ses_/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

function debug(message) {
  if (process.env.LOG_LEVEL === 'debug') {
    process.stderr.write('[observer] ' + message + '\n');
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const asText = text(value);
  if (!asText) return null;
  const parsed = Date.parse(asText);
  return Number.isNaN(parsed) ? null : parsed;
}

function toIso(ms) {
  return finite(ms) === null ? null : new Date(ms).toISOString();
}

// Канонический путь: realpath, если путь существует, затем единые разделители
// и регистронезависимое сравнение на Windows (точное совпадение проекта).
function canonicalProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return null;
  let absolute;
  try {
    absolute = path.resolve(projectPath);
  } catch {
    return null;
  }
  try {
    absolute = fs.realpathSync.native(absolute);
  } catch {
    // Путь фикстуры может не существовать — сравниваем нормализованный путь.
  }
  let normalized = absolute.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized || null;
}

function defaultRunRoot() {
  const local = process.env.LOCALAPPDATA;
  if (local && path.isAbsolute(local)) return path.join(local, 'Codex', 'OpenCode workers');
  return path.join(os.homedir(), 'AppData', 'Local', 'Codex', 'OpenCode workers');
}

function parseJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readTail(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let content = buffer.toString('utf8');
    if (size > length) {
      const newline = content.indexOf('\n');
      content = newline === -1 ? '' : content.slice(newline + 1);
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

// Из хвоста лога извлекаем только идентификаторы сессий и грубое состояние.
// Текст промптов, self-report и причины stop не попадают в результат.
function analyzeLogTail(content) {
  let parentId = null;
  const childIds = [];
  let active = false;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (!parentId) parentId = text(event.sessionID) ?? text(event.parentID);
    if (event.type === 'background_wait') {
      if (Array.isArray(event.jobs)) {
        for (const job of event.jobs) {
          const id = text(job && job.id);
          if (id && SESSION_RE.test(id)) childIds.push(id);
        }
      }
      active = true;
    } else if (event.type === 'step_start') {
      active = true;
    } else if (event.type === 'step_finish') {
      const reason = event.part && event.part.reason;
      if (reason === 'stop') active = false;
    }
  }
  return { parentId, childIds: [...new Set(childIds)], active };
}

function readWorkerLogs(runDir, names) {
  const result = {};
  let listing = [];
  try {
    listing = fs.readdirSync(runDir);
  } catch {
    // ignored
  }
  for (const name of names) {
    const files = listing.filter((entry) => entry === name + '.jsonl' ||
      new RegExp('^' + escapeRegExp(name) + '\\.retry-\\d+\\.jsonl$').test(entry)).sort();
    let parentId = null;
    const childIds = [];
    let active = false;
    for (const file of files) {
      const parsed = analyzeLogTail(readTail(path.join(runDir, file), TAIL_BYTES));
      if (!parentId) parentId = parsed.parentId;
      childIds.push(...parsed.childIds);
      if (parsed.active) active = true;
    }
    result[name] = { parentId, childIds: [...new Set(childIds)], active };
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gitRead(directory, args) {
  if (!directory) return null;
  try {
    const result = spawnSync('git', ['-C', directory, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 64 * 1024,
    });
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout.trim();
  } catch {
    // Git может отсутствовать — это не ошибка наблюдателя.
  }
  return null;
}

function readSourceHead(source) {
  const head = gitRead(source, ['rev-parse', 'HEAD']);
  return head && SHA_RE.test(head) ? head : null;
}

function readWorktree(workerPath) {
  if (!workerPath) return null;
  try {
    if (!fs.existsSync(path.join(workerPath, '.git'))) return null;
  } catch {
    return null;
  }
  const head = gitRead(workerPath, ['rev-parse', 'HEAD']);
  const branch = gitRead(workerPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head && !branch) return null;
  const status = gitRead(workerPath, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  return {
    head: head || null,
    branch: branch || null,
    dirty: status === null ? null : status.length > 0,
  };
}

function normalizeChangedPaths(value) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : text(item && item.path);
    if (name) items.push(name);
  }
  return items;
}

const WORKER_STATUSES = new Set([
  'completed', 'failed', 'unverified', 'blocked', 'running', 'idle', 'stale', 'unknown',
]);

function mapWorkerStatus(reported, tail, fresh, hasTimestamp) {
  if (WORKER_STATUSES.has(reported)) return reported;
  if (tail.active && fresh) return 'running';
  if (!fresh && hasTimestamp) return 'stale';
  return 'unknown';
}

function readAssemblyVerification(runDir, manifestName, record) {
  const stem = manifestName.replace(/\.json$/i, '');
  const candidates = [stem + '.verify.json', 'verify.json', 'assembly.verify.json'];
  const expected = text(record && record.assembly);
  for (const name of candidates) {
    const report = parseJsonFile(path.join(runDir, name));
    if (!report) continue;
    const actual = text(report.assembly) ?? text(report.assemblyPath);
    if (expected && actual && canonicalProjectPath(actual) !== canonicalProjectPath(expected)) continue;
    const status = text(report.status) ?? text(report.result);
    if (report.verified === true || status === 'ok' || status === 'verified') return true;
    if (report.verified === false || status === 'stale' || status === 'failed') return false;
  }
  return undefined;
}

function readAssemblies(runDir) {
  let listing = [];
  try {
    listing = fs.readdirSync(runDir);
  } catch {
    return [];
  }
  const manifests = listing.filter((name) => /^assembly(?:-\d+)?\.json$/i.test(name)).sort();
  const result = [];
  for (const name of manifests) {
    const manifestPath = path.join(runDir, name);
    const record = parseJsonFile(manifestPath);
    if (!record) continue; // Повреждённый манифест игнорируется независимо.
    const assemblyPath = text(record.assembly) ?? path.join(runDir, name.replace(/\.json$/i, ''));
    const entry = { path: assemblyPath, manifest: manifestPath };
    let verified;
    if (typeof record.verified === 'boolean') verified = record.verified;
    else {
      const status = text(record.status);
      if (status === 'ok' || status === 'verified') verified = true;
      else if (status === 'stale' || status === 'failed') verified = false;
    }
    const reported = readAssemblyVerification(runDir, name, record);
    if (reported !== undefined) verified = reported;
    if (verified !== undefined) entry.verified = verified;
    result.push(entry);
  }
  return result;
}

function observeRun(runDir, projectCanonical) {
  const manifestPath = path.join(runDir, 'manifest.json');
  const summaryPath = path.join(runDir, 'summary.json');
  const manifest = parseJsonFile(manifestPath); // каждый файл разбирается независимо
  const summary = parseJsonFile(summaryPath);

  const source = text(summary && summary.source) ?? text(manifest && manifest.source);
  if (!source || canonicalProjectPath(source) !== projectCanonical) return null;

  const runName = path.basename(runDir);
  debug('run ' + runName + ' matches project');

  const mode = text(summary && summary.mode) ?? text(manifest && manifest.mode) ??
    text(manifest && manifest.requestedMode) ?? null;
  const baseSha = text(summary && summary.baseSha) ?? text(manifest && manifest.baseSha) ??
    readSourceHead(source) ?? null;

  const summaryWorkers = summary && Array.isArray(summary.workers) ? summary.workers : [];
  const manifestWorkers = manifest && manifest.workers && typeof manifest.workers === 'object' &&
    !Array.isArray(manifest.workers) ? manifest.workers : {};
  const names = [...new Set([
    ...summaryWorkers.map((worker) => text(worker && worker.name)).filter(Boolean),
    ...Object.keys(manifestWorkers),
  ])].sort();

  const logState = readWorkerLogs(runDir, names);

  const times = [mtimeMs(manifestPath), mtimeMs(summaryPath)];
  let listing = [];
  try {
    listing = fs.readdirSync(runDir);
  } catch {
    // ignored
  }
  for (const entry of listing) {
    if (/\.jsonl$|\.process\.log$|^assembly(?:-\d+)?\.json$/i.test(entry)) {
      times.push(mtimeMs(path.join(runDir, entry)));
    }
  }
  const startedAt = parseTime(summary && summary.startedAt);
  const finishedAt = parseTime(summary && summary.finishedAt);
  const newest = Math.max(...times, startedAt ?? 0, finishedAt ?? 0, 0);
  const hasTimestamp = newest > 0;
  const fresh = hasTimestamp && (Date.now() - newest) <= STALE_MS;
  const anyActive = names.some((name) => logState[name] && logState[name].active);

  let status;
  if (finishedAt !== null || (summary && text(summary.status))) status = 'finished';
  else if (anyActive && fresh) status = 'running';
  else if (fresh) status = 'pending';
  else if (hasTimestamp) status = 'stale';
  else status = 'unknown';

  const updatedAt = toIso(finishedAt ?? startedAt ?? (hasTimestamp ? newest : null));

  const workers = names.map((name) => {
    const reported = summaryWorkers.find((worker) => text(worker && worker.name) === name) ?? null;
    const tail = logState[name] ?? { parentId: null, childIds: [], active: false };
    const workerPath = text(reported && reported.workerPath) ?? text(manifestWorkers[name]) ?? null;
    const worker = {
      name,
      path: workerPath,
      model: text(reported && reported.model) ?? null,
      parentSessionId: text(reported && reported.parentSessionID) ?? tail.parentId ?? null,
      childSessionId: text(reported && reported.childSessionID) ?? (tail.childIds.at(-1) ?? null),
      status: mapWorkerStatus(text(reported && reported.status), tail, fresh, hasTimestamp),
      elapsedMs: finite(reported && reported.elapsedMs),
      changedPaths: normalizeChangedPaths(reported && reported.changedPaths),
    };
    const worktree = readWorktree(workerPath);
    if (worktree) worker.worktree = worktree;
    return worker;
  });

  return {
    id: runName,
    mode,
    baseSha,
    status,
    updatedAt,
    workers,
    assemblies: readAssemblies(runDir),
  };
}

/**
 * Синхронно возвращает отсортированные реальные запуски для точного
 * канонического пути проекта. Повреждённые файлы игнорируются по отдельности.
 */
function observe(projectPath, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const projectCanonical = canonicalProjectPath(projectPath);
  if (!projectCanonical) return [];
  let runRoot;
  try {
    runRoot = path.resolve(text(opts.runRoot) ?? defaultRunRoot());
  } catch {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(runRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runRoot, entry.name);
    if (!fs.existsSync(path.join(runDir, 'manifest.json')) &&
        !fs.existsSync(path.join(runDir, 'summary.json'))) continue;
    try {
      const run = observeRun(runDir, projectCanonical);
      if (run) runs.push(run);
    } catch (error) {
      debug('skip ' + entry.name + ': ' + (error && error.message));
    }
  }
  runs.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return runs;
}

module.exports = {
  observe,
  canonicalProjectPath,
  defaultRunRoot,
};
