'use strict';

// Хранилище состояния панели. Только SQLite (node:sqlite) и стандартная библиотека.
// Панель хранит состояния и доказательства решений по проектам.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ordinaryPath } = require('./windows-path.cjs');
const { RecursiveRepository } = require('./recursive/repository.cjs');
const outsource = require('./outsource.cjs');
const archive = require('./outsource-archive.cjs');
const SCHEMA_VERSION = 3;

function outsourceOpenForImport(item) {
  return ['prepared', 'imported'].includes(item.state);
}

function outsourceView(row) {
  const spec = JSON.parse(row.spec);
  const artifact = row.artifact ? JSON.parse(row.artifact) : null;
  return {
    id: row.id,
    title: spec.title,
    targetPath: spec.targetPath,
    contractVersion: spec.openapi.info.version,
    state: row.state,
    artifact,
    evidence: row.evidence,
    updatedAt: row.updated_at,
  };
}

const PHASES = ['brief', 'architecture', 'scaffold', 'implementation', 'assembly', 'acceptance', 'complete'];
const DESIGN_STEPS = [
  'references_ready',
  'references_approved',
  'figma_ready',
  'figma_approved',
  'implemented',
  'reviewed',
];
const HUMAN_DESIGN_STEPS = new Set(['references_approved', 'figma_approved']);
const IDEA_DECISIONS = ['accepted', 'rejected', 'deferred'];
const LAB_DECISIONS = ['approved', 'rejected', 'accepted', 'changes_requested'];
const LAB_STATES = ['proposed', 'approved', 'configured', 'ready', 'accepted', 'changes_requested', 'rejected'];
const LAB_RUNTIME = ['not_started', 'running', 'ready', 'stopped', 'failed', 'unverified'];

class ActionError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'ActionError';
    this.code = code || 'action.invalid';
    this.details = extra;
  }

  toJSON() {
    return { error: this.message, code: this.code, ...this.details };
  }
}

function fail(message, code, extra) {
  throw new ActionError(message, code, extra);
}

function makeLogger(options = {}) {
  if (typeof options.logger === 'function') return options.logger;
  const debugEnabled = options.debug === true || process.env.DEBUG_DASHBOARD === '1';
  return (level, message, meta) => {
    if (!debugEnabled && level === 'debug') return;
    const suffix = meta ? ' ' + JSON.stringify(meta) : '';
    process.stderr.write(`[dashboard] ${level} ${message}${suffix}\n`);
  };
}

function nowIso() {
  return new Date().toISOString();
}

function text(value, label, { required = true, max = 20000 } = {}) {
  if (value == null || value === '') {
    if (required) fail(`Заполните поле «${label}».`, 'field.required', { field: label });
    return null;
  }
  if (typeof value !== 'string') fail(`Поле «${label}» должно быть строкой.`, 'field.type', { field: label });
  const trimmed = value.trim();
  if (required && !trimmed) fail(`Заполните поле «${label}».`, 'field.required', { field: label });
  if (trimmed.length > max) fail(`Поле «${label}» слишком длинное (максимум ${max} символов).`, 'field.too_long', { field: label });
  return trimmed;
}

function optionalText(value, label, max = 20000) {
  return value == null || value === '' ? null : text(value, label, { max });
}

function strList(value, label) {
  let raw;
  if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') raw = value.split(/[\r\n,]+/);
  else if (value == null) raw = [];
  else fail(`Поле «${label}» должно быть массивом строк.`, 'field.type', { field: label });
  const result = [];
  for (const item of raw) {
    if (typeof item !== 'string') fail(`Поле «${label}» должно содержать только строки.`, 'field.type', { field: label });
    const clean = item.trim();
    if (clean && !result.includes(clean)) result.push(clean);
  }
  return result;
}

function jsonField(value, label) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) return JSON.stringify(strList(value, label));
  if (typeof value === 'string') return JSON.stringify(value.trim());
  if (typeof value === 'object') return JSON.stringify(value);
  fail(`Поле «${label}» должно быть строкой, массивом или объектом.`, 'field.type', { field: label });
}

function parseJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeIdeaText(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru').toLocaleLowerCase('en');
}

function idHash(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

// Приёмка привязана к точному содержимому задачи: новая ревизия или новый
// runId меняют отпечаток, поэтому старая приёмка автоматически перестаёт действовать.
function taskFingerprint(fields) {
  const parts = [
    fields.title, fields.stage, fields.status, fields.agent, fields.model,
    fields.run_id, fields.session_id, fields.criteria, fields.evidence, fields.depends_on,
  ].map((value) => value == null ? '' : String(value));
  return idHash('task-revision', ...parts);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function realDirectory(value, label = 'путь') {
  if (typeof value !== 'string' || !value.trim()) fail(`Укажите ${label}.`, 'field.required', { field: label });
  const absolute = path.resolve(ordinaryPath(value.trim()));
  let real;
  try {
    // Не нативная форма сохраняет длинные имена Windows и всё равно разряжает символические ссылки.
    real = ordinaryPath(fs.realpathSync(absolute));
  } catch {
    fail(`${label[0].toUpperCase() + label.slice(1)} не существует или недоступен: ${absolute}`, 'path.missing', { path: absolute });
  }
  try {
    if (!fs.statSync(real).isDirectory()) fail(`${label[0].toUpperCase() + label.slice(1)} должен быть каталогом: ${real}`, 'path.not_directory', { path: real });
  } catch (error) {
    if (error instanceof ActionError) throw error;
    fail(`Не удалось проверить ${label}: ${real}`, 'path.unreadable', { path: real });
  }
  return real;
}

function samePath(a, b) {
  const first = path.resolve(a);
  const second = path.resolve(b);
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function normalizeProjectPaths(value, label) {
  const raw = strList(value, label);
  const result = [];
  for (const item of raw) {
    if (item.includes('\u0000')) fail(`Путь в «${label}» содержит недопустимый символ.`, 'path.invalid', { field: label });
    const normalized = item.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      fail(`Путь «${item}» в «${label}» должен быть относительным путём внутри проекта.`, 'path.invalid', { field: label, path: item });
    }
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!result.some((entry) => (process.platform === 'win32' ? entry.toLowerCase() : entry) === key)) result.push(normalized);
  }
  if (!result.length) fail(`Заполните «${label}».`, 'field.required', { field: label });
  return result;
}

function assertDisjoint(modulePaths, demoPaths) {
  const overlap = modulePaths.filter((modulePath) => demoPaths.some((demoPath) => {
    const a = process.platform === 'win32' ? modulePath.toLowerCase() : modulePath;
    const b = process.platform === 'win32' ? demoPath.toLowerCase() : demoPath;
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  }));
  if (overlap.length) {
    fail(`Модули и демонстрационные файлы не должны пересекаться: ${overlap.join(', ')}.`, 'lab.paths_overlap', { overlap });
  }
}

function looksLikeLink(value) {
  return /https?:\/\//i.test(value) || /(?:\.{1,2}\/|\/)[^\s]+/.test(value);
}

class Store {
  constructor(options = {}) {
    this.options = options;
    this.log = makeLogger(options);
    this.now = typeof options.now === 'function' ? options.now : nowIso;
    this.dataDir = path.resolve(options.dataDir || path.join(__dirname, 'data'));
    this.dashboardDir = path.resolve(__dirname);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, 'dashboard.sqlite');
    this.log('debug', 'opening sqlite', { path: this.dbPath });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.recursive = new RecursiveRepository(this);
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
    this.clearUnverifiedRuntime();
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) throw new Error('Версия базы Makora новее поддерживаемой.');
    if (version === SCHEMA_VERSION) return;
    this.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        run_id TEXT,
        session_id TEXT,
        criteria TEXT,
        evidence TEXT,
        depends_on TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        norm_text TEXT NOT NULL,
        text TEXT NOT NULL,
        proposal TEXT,
        after_task_id TEXT,
        decision TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE (project_id, norm_text),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS outsources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        spec TEXT NOT NULL,
        artifact TEXT,
        evidence TEXT,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'imported', 'accepted', 'integrated')),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outsources_project ON outsources(project_id);
      CREATE TABLE IF NOT EXISTS labs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        scenario TEXT NOT NULL,
        criteria TEXT NOT NULL,
        module_paths TEXT NOT NULL,
        demo_paths TEXT NOT NULL,
        proof TEXT,
        state TEXT NOT NULL,
        runtime TEXT NOT NULL,
        revision INTEGER NOT NULL,
        config TEXT,
        last_run TEXT,
        ready_seen INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS designs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        step TEXT,
        step_index INTEGER NOT NULL DEFAULT -1,
        history TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        task_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT NOT NULL,
        note TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_acceptances (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        evidence TEXT NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        ts TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        project_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT,
        idempotent INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, id);
      `);
      this.recursive.migrate();
      this.db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    });
  }

  // После перезапуска процесса мы не имеем права утверждать, что демо всё ещё работает.
  clearUnverifiedRuntime() {
    const rows = this.db.prepare('SELECT id, project_id, runtime FROM labs WHERE runtime = ?').all('running');
    if (!rows.length) return;
    const ts = this.now();
    this.transaction(() => {
      const update = this.db.prepare('UPDATE labs SET runtime = ?, updated_at = ? WHERE id = ?');
      for (const row of rows) {
        update.run('unverified', ts, row.id);
        this.audit(row.project_id, 'lab.runtime.unverified', 'system', { id: row.id, previous: row.runtime }, false, ts);
      }
    });
    this.log('warn', 'cleared unverified lab runtime after restart', { count: rows.length });
  }

  close() {
    this.db.close();
    this.log('debug', 'sqlite closed');
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* уже откачено */ }
      throw error;
    }
  }

  audit(projectId, action, actor, detail = null, idempotent = false, ts = null) {
    this.db.prepare('INSERT INTO audit(ts, project_id, action, actor, detail, idempotent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts || this.now(), projectId || null, action, actor || 'system', detail ? JSON.stringify(detail) : null, idempotent ? 1 : 0);
  }

  decision(projectId, type, targetId, decision, source) {
    this.db.prepare('INSERT INTO decisions(project_id, type, target_id, decision, ts, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, type, targetId, decision, this.now(), source || 'cli');
  }

  getProject(id) {
    if (typeof id !== 'string' || !id) fail('Укажите проект через projectId.', 'project.required');
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!project) fail(`Проект ${id} не найден.`, 'project.not_found', { projectId: id });
    return project;
  }

  findProjectByPath(canonicalPath) {
    return this.db.prepare('SELECT * FROM projects WHERE path = ?').get(canonicalPath);
  }

  allProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all();
  }

  getState({ observer = null, runRoot = null } = {}) {
    const warnings = [];
    const projects = this.allProjects().map((project) => this.projectState(project, observer, runRoot, warnings));
    return { projects, ...(warnings.length ? { warnings } : {}) };
  }

  projectState(project, observer, runRoot, warnings) {
    const acceptances = new Map(
      this.db.prepare('SELECT * FROM task_acceptances WHERE project_id = ?').all(project.id)
        .map((row) => [row.task_id, row])
    );
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(project.id).map((row) => {
      // Приёмка хранится отдельно и действует только для той же ревизии задачи.
      const acceptedRecord = acceptances.get(row.id);
      const accepted = Boolean(acceptedRecord && acceptedRecord.fingerprint === taskFingerprint(row));
      const executionEvidence = parseJson(row.evidence, null);
      return {
        id: row.id,
        title: row.title,
        stage: row.stage,
        status: row.status,
        agent: row.agent,
        model: row.model,
        runId: row.run_id,
        sessionId: row.session_id,
        criteria: parseJson(row.criteria, []),
        // Доказательство приёмки видно и в evidence задачи, если исполнитель своих доказательств не передал.
        evidence: accepted && executionEvidence == null ? acceptedRecord.evidence : executionEvidence,
        dependsOn: parseJson(row.depends_on, []),
        accepted, // статус исполнителя не является приёмкой
        acceptance: accepted ? 'accepted' : 'pending',
        acceptanceEvidence: accepted ? acceptedRecord.evidence : null,
        acceptedAt: accepted ? acceptedRecord.ts : null,
        updatedAt: row.updated_at,
      };
    });
    const ideas = this.db.prepare('SELECT * FROM ideas WHERE project_id = ? ORDER BY created_at, id').all(project.id).map((row) => ({
      id: row.id,
      text: row.text,
      proposal: row.proposal,
      afterTaskId: row.after_task_id,
      decision: row.decision,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    }));
    const labs = this.db.prepare('SELECT * FROM labs WHERE project_id = ? ORDER BY created_at, id').all(project.id).map((row) => ({
      id: row.id,
      title: row.title,
      scenario: row.scenario,
      criteria: parseJson(row.criteria, []),
      modulePaths: parseJson(row.module_paths, []),
      demoPaths: parseJson(row.demo_paths, []),
      proof: row.proof,
      state: row.state,
      runtime: row.runtime,
      revision: row.revision,
      config: parseJson(row.config, null),
      lastRun: parseJson(row.last_run, null),
      readySeen: Boolean(row.ready_seen),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const designs = this.db.prepare('SELECT * FROM designs WHERE project_id = ? ORDER BY created_at, id').all(project.id).map((row) => ({
      id: row.id,
      title: row.title,
      step: row.step,
      stepIndex: row.step_index,
      nextStep: row.step_index + 1 < DESIGN_STEPS.length ? DESIGN_STEPS[row.step_index + 1] : null,
      history: parseJson(row.history, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const storedRuns = this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY finished_at DESC, id').all(project.id).map((row) => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      source: row.source,
      status: row.status,
      accepted: Boolean(row.accepted),
      acceptance: row.accepted ? 'accepted' : 'pending',
      finishedAt: row.finished_at,
      note: row.note,
    }));
    const observed = this.observeRuns(project, observer, runRoot, warnings);
    // Данные исполнителя авторитетны: наблюдаемый запуск не заменяется
    // искусственной записью из task.put. Ссылка задачи лишь обогащает его.
    const runs = [...observed];
    for (const stored of storedRuns) {
      const storedKeys = new Set([stored.runId, stored.id].filter(Boolean).map(String));
      const match = runs.find((run) => [run.runId, run.id].filter(Boolean)
        .some((key) => storedKeys.has(String(key))));
      if (!match) {
        runs.push(stored);
        continue;
      }
      if (!match.taskId && stored.taskId) match.taskId = stored.taskId;
      if (!match.sessionId && stored.sessionId) match.sessionId = stored.sessionId;
      // status, finishedAt, updatedAt, workers и acceptance не перезаписываем:
      // наблюдение не становится принятым и не получает текущее время.
    }
    const decisions = this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY id').all(project.id).map((row) => ({
      id: row.id,
      type: row.type,
      targetId: row.target_id,
      decision: row.decision,
      ts: row.ts,
      source: row.source,
    }));
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      phase: project.phase,
      tasks,
      ideas,
      labs,
      outsources: this.db.prepare('SELECT * FROM outsources WHERE project_id = ? ORDER BY updated_at DESC, id')
        .all(project.id).map(outsourceView),
      designs,
      runs,
      decisions,
      recursivePlans: this.recursive.list(project.id),
    };
  }

  observeRuns(project, observer, runRoot, warnings) {
    if (!observer || typeof observer.observe !== 'function') return [];
    let value;
    try {
      value = observer.observe(project.path, { runRoot });
    } catch (error) {
      warnings.push(`Наблюдатель для проекта «${project.name}» недоступен: ${error.message}`);
      this.log('warn', 'observer failed', { project: project.id, error: error.message });
      return [];
    }
    if (value && typeof value.then === 'function') {
      warnings.push('Наблюдатель вернул обещание: запуски будут доступны после обновления страницы.');
      return [];
    }
    if (!Array.isArray(value)) {
      warnings.push(`Наблюдатель вернул не список запусков для проекта «${project.name}».`);
      return [];
    }
    return value.filter((run) => run && typeof run === 'object').map((run) => {
      const finished = run.finishedAt ?? run.finished_at;
      return {
        id: String(run.id || run.runId || idHash(project.id, String(run.runId || ''), String(run.sessionId || ''))),
        runId: run.runId == null ? null : String(run.runId),
        sessionId: run.sessionId == null ? null : String(run.sessionId),
        taskId: run.taskId == null ? null : String(run.taskId),
        source: 'observer',
        status: String(run.status || 'reported'),
        // Все структурные факты проверенного observer.cjs проходят без потерь.
        mode: run.mode == null ? null : String(run.mode),
        baseSha: run.baseSha == null ? null : String(run.baseSha),
        workers: Array.isArray(run.workers) ? run.workers : [],
        assemblies: Array.isArray(run.assemblies) ? run.assemblies : [],
        updatedAt: run.updatedAt == null ? null : String(run.updatedAt),
        accepted: false, // итог агента не означает приёмку человеком
        acceptance: 'pending',
        finishedAt: finished == null ? null : String(finished),
        note: run.note == null ? null : String(run.note),
      };
    });
  }

  auditEntries(projectId) {
    if (!projectId) return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all();
    return this.db.prepare('SELECT * FROM audit WHERE project_id = ? ORDER BY id DESC LIMIT 200').all(projectId);
  }

  // --- действия ---

  perform(payload, ctx = {}) {
    const action = text(payload.action, 'action');
    const actor = ctx.actor || 'cli';
    let result;
    switch (action) {
      case 'project.add': result = this.projectAdd(payload, actor); break;
      case 'project.phase': result = this.projectPhase(payload, actor); break;
      case 'task.put': result = this.taskPut(payload, actor); break;
      case 'task.accept': result = this.taskAccept(payload, actor); break;
      case 'plan.put':
      case 'plan.draft': result = this.recursive.put(payload, actor); break;
      case 'idea.add': result = this.ideaAdd(payload, actor); break;
      case 'idea.decide': result = this.ideaDecide(payload, actor); break;
      case 'outsource.create': result = this.outsourceCreate(payload, actor); break;
      case 'outsource.accept': result = this.outsourceAccept(payload, actor); break;
      case 'outsource.integrate': result = this.outsourceIntegrate(payload, actor); break;
      case 'lab.propose': result = this.labPropose(payload, actor); break;
      case 'lab.decide': result = this.labDecide(payload, actor); break;
      case 'lab.configure': result = this.labConfigure(payload, actor); break;
      case 'design.create': result = this.designCreate(payload, actor); break;
      case 'design.figma.sync': result = this.designFigmaSync(payload, actor); break;
      case 'design.advance': result = this.designAdvance(payload, actor, ctx); break;
      default:
        fail(`Неизвестное действие «${action}».`, 'action.unknown', { action });
    }
    this.log('debug', 'action performed', { action, actor, idempotent: Boolean(result.idempotent) });
    return result;
  }

  getOutsource(projectId, id) {
    const project = this.getProject(projectId);
    if (typeof id !== 'string' || !/^outsource_[a-f0-9]{16}$/.test(id)) {
      outsource.fail('Укажите ID задания аутсорса.', 'invalid_id');
    }
    const row = this.db.prepare('SELECT * FROM outsources WHERE project_id = ? AND id = ?').get(project.id, id);
    if (!row) outsource.fail('Задание аутсорса не найдено в этом проекте.', 'not_found', 404);
    return row;
  }

  outsourceCreate(payload, actor) {
    const project = this.getProject(payload.projectId);
    const spec = outsource.specification(payload);
    const id = newId('outsource');
    this.transaction(() => {
      this.db.prepare("INSERT INTO outsources(id, project_id, spec, state, updated_at) VALUES (?, ?, ?, 'prepared', ?)")
        .run(id, project.id, JSON.stringify(spec), this.now());
      this.audit(project.id, 'outsource.create', actor, { id, targetPath: spec.targetPath });
    });
    return this.outsourceResult(project.id, id);
  }

  outsourceResult(projectId, id, idempotent = false) {
    return { ok: true, projectId, idempotent, outsource: outsourceView(this.getOutsource(projectId, id)) };
  }

  outsourceBrief(projectId, id) {
    const row = this.getOutsource(projectId, id);
    return outsource.brief(row.id, JSON.parse(row.spec));
  }

  async outsourceImport(projectId, id, buffer, actor) {
    const digest = outsource.sha256(buffer);
    const initial = outsourceView(this.getOutsource(projectId, id));
    const same = initial.artifact?.sha256 === digest;
    if (!same && !outsourceOpenForImport(initial)) {
      outsource.fail('Создайте новое задание для следующей версии после приёмки.', 'state', 409);
    }
    const files = await archive.readArchive(buffer, this.outsourceBrief(projectId, id));
    let staged;
    let previous;
    let idempotent;
    try {
      this.transaction(() => {
        const current = outsourceView(this.getOutsource(projectId, id));
        const matches = current.artifact?.sha256 === digest;
        if (matches) {
          try {
            archive.checkArtifact(this.dataDir, current.artifact);
            idempotent = true;
            return;
          } catch (error) {
            if (!(error instanceof outsource.OutsourceError)) throw error;
          }
        }
        if (!matches && !outsourceOpenForImport(current)) {
          outsource.fail('Задание изменилось. Обновите карточку и проверьте статус.', 'state', 409);
        }
        staged = archive.stage(this.dataDir, files, digest);
        previous = current.artifact;
        this.db.prepare('UPDATE outsources SET state = ?, artifact = ?, updated_at = ? WHERE id = ?')
          .run(matches ? current.state : 'imported', JSON.stringify(staged), this.now(), id);
        this.audit(projectId, 'outsource.import', actor, { id, sha256: digest, files: staged.files.length });
      });
    } catch (error) {
      this.discardOutsourceArtifact(staged);
      throw error;
    }
    this.discardOutsourceArtifact(previous);
    return this.outsourceResult(projectId, id, idempotent);
  }

  discardOutsourceArtifact(artifact) {
    try {
      archive.discard(artifact);
    } catch (error) {
      this.log('warn', 'cannot remove previous outsource artifact', { folder: artifact?.folder, error: error.message });
    }
  }

  outsourceAccept(payload, actor) {
    const { projectId, id } = payload;
    const evidence = outsource.field(payload.evidence, 'Результат проверки', 4000);
    let idempotent = false;
    this.transaction(() => {
      const current = outsourceView(this.getOutsource(projectId, id));
      if (!current.artifact || current.artifact.sha256 !== payload.sha256) {
        outsource.fail('Укажите SHA-256 актуального архива после его проверки.', 'digest_mismatch', 409);
      }
      if (current.state === 'accepted' || current.state === 'integrated') {
        idempotent = true;
        return;
      }
      archive.checkArtifact(this.dataDir, current.artifact);
      this.db.prepare("UPDATE outsources SET state = 'accepted', evidence = ?, updated_at = ? WHERE id = ?")
        .run(evidence, this.now(), id);
      this.audit(projectId, 'outsource.accept', actor, { id, sha256: payload.sha256, evidence });
    });
    return this.outsourceResult(projectId, id, idempotent);
  }

  outsourceIntegrate(payload, actor) {
    const { projectId, id } = payload;
    const project = this.getProject(projectId);
    let options;
    let idempotent = false;
    this.transaction(() => {
      const current = outsourceView(this.getOutsource(projectId, id));
      if (!['accepted', 'integrated'].includes(current.state)) {
        outsource.fail('Сначала примите архив после проверки.', 'state', 409);
      }
      if (current.artifact.sha256 !== payload.sha256) {
        outsource.fail('Укажите SHA-256 принятого архива.', 'digest_mismatch', 409);
      }
      options = { id, projectPath: project.path, targetPath: current.targetPath, dataDir: this.dataDir, artifact: current.artifact };
      if (current.state === 'integrated') {
        idempotent = true;
        return;
      }
      archive.integrate(options);
      this.db.prepare("UPDATE outsources SET state = 'integrated', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.audit(projectId, 'outsource.integrate', actor, { id, sha256: payload.sha256, targetPath: current.targetPath });
    });
    try {
      archive.finishIntegration(options);
    } catch (error) {
      this.log('warn', 'cannot remove outsource integration marker', { id, error: error.message });
    }
    return this.outsourceResult(projectId, id, idempotent);
  }

  projectAdd(payload, actor) {
    const name = text(payload.name, 'название проекта', { max: 200 });
    const canonical = realDirectory(payload.path, 'путь проекта');
    if (isInside(this.dataDir, canonical) || isInside(this.dashboardDir, canonical)) {
      fail('Нельзя регистрировать каталог панели или её данных как проект.', 'project.reserved_path', { path: canonical });
    }
    for (const other of this.allProjects()) {
      if (samePath(canonical, other.path)) continue; // повторная регистрация того же корня обрабатывается ниже
      if (isInside(canonical, other.path) || isInside(other.path, canonical)) {
        fail(`Каталог пересекается с уже зарегистрированным проектом «${other.name}» (${other.path}).`, 'project.overlap', { projectId: other.id, path: other.path });
      }
    }
    const id = idHash('project', canonical);
    const existing = this.findProjectByPath(canonical);
    if (existing) {
      if (existing.name === name) {
        this.audit(existing.id, 'project.add', actor, { id, path: canonical }, true);
        return { ok: true, projectId: id, idempotent: true, project: { id, name, path: canonical, phase: existing.phase } };
      }
      this.transaction(() => {
        this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, this.now(), id);
        this.audit(id, 'project.rename', actor, { from: existing.name, to: name });
      });
      return { ok: true, projectId: id, idempotent: false, renamed: true, project: { id, name, path: canonical, phase: existing.phase } };
    }
    const ts = this.now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO projects(id, name, path, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, canonical, PHASES[0], ts, ts);
      this.audit(id, 'project.add', actor, { name, path: canonical });
    });
    return { ok: true, projectId: id, idempotent: false, project: { id, name, path: canonical, phase: PHASES[0] } };
  }

  projectPhase(payload, actor) {
    const project = this.getProject(payload.projectId);
    const phase = text(payload.phase, 'фаза', { max: 60 });
    if (!PHASES.includes(phase)) {
      fail(`Неизвестная фаза «${phase}». Допустимые фазы: ${PHASES.join(', ')}.`, 'phase.invalid', { phases: PHASES });
    }
    const current = PHASES.indexOf(project.phase);
    const next = PHASES.indexOf(phase);
    if (next === current) {
      this.audit(project.id, 'project.phase', actor, { phase }, true);
      return { ok: true, projectId: project.id, phase, idempotent: true };
    }
    if (next < current && payload.force !== true) {
      fail(`Нельзя вернуться с фазы «${project.phase}» на «${phase}» без force. Текущая фаза: ${project.phase}.`, 'phase.backward', { current: project.phase, requested: phase });
    }
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET phase = ?, updated_at = ? WHERE id = ?').run(phase, this.now(), project.id);
      this.audit(project.id, 'project.phase', actor, { from: project.phase, to: phase });
    });
    return { ok: true, projectId: project.id, phase, idempotent: false };
  }

  taskPut(payload, actor) {
    const project = this.getProject(payload.projectId);
    const id = text(payload.id, 'идентификатор задачи', { max: 200 });
    const title = text(payload.title, 'название задачи', { max: 1000 });
    const stage = text(payload.stage, 'этап', { max: 200 });
    const status = text(payload.status, 'статус', { max: 200 });
    const fields = {
      title,
      stage,
      status,
      agent: optionalText(payload.agent, 'агент', 200),
      model: optionalText(payload.model, 'модель', 200),
      run_id: optionalText(payload.runId, 'runId', 200),
      session_id: optionalText(payload.sessionId, 'sessionId', 200),
      criteria: jsonField(payload.criteria, 'критерии'),
      evidence: jsonField(payload.evidence, 'доказательства'),
      depends_on: jsonField(payload.dependsOn, 'зависимости'),
    };
    const existing = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(project.id, id);
    const same = existing && Object.keys(fields).every((key) => (existing[key] ?? null) === (fields[key] ?? null));
    const ts = this.now();
    this.transaction(() => {
      if (same) {
        this.audit(project.id, 'task.put', actor, { id }, true);
        return;
      }
      this.db.prepare(`INSERT INTO tasks(project_id, id, title, stage, status, agent, model, run_id, session_id, criteria, evidence, depends_on, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, id) DO UPDATE SET title = excluded.title, stage = excluded.stage, status = excluded.status,
          agent = excluded.agent, model = excluded.model, run_id = excluded.run_id, session_id = excluded.session_id,
          criteria = excluded.criteria, evidence = excluded.evidence, depends_on = excluded.depends_on, updated_at = excluded.updated_at`)
        .run(project.id, id, fields.title, fields.stage, fields.status, fields.agent, fields.model,
          fields.run_id, fields.session_id, fields.criteria, fields.evidence, fields.depends_on, ts);
      this.audit(project.id, existing ? 'task.update' : 'task.add', actor, { id, status: fields.status });
      // Новый запуск или ревизия задачи не наследуют прежнюю приёмку.
      this.db.prepare('DELETE FROM task_acceptances WHERE project_id = ? AND task_id = ?').run(project.id, id);
      this.db.prepare("DELETE FROM decisions WHERE project_id = ? AND type = 'task' AND target_id = ?").run(project.id, id);
      if (fields.run_id) {
        const runId = idHash('run', project.id, fields.run_id);
        this.db.prepare(`INSERT INTO runs(id, project_id, run_id, session_id, task_id, source, status, accepted, finished_at, note)
          VALUES (?, ?, ?, ?, ?, 'reported', 'reported', 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, task_id = excluded.task_id, finished_at = excluded.finished_at`)
          .run(runId, project.id, fields.run_id, fields.session_id, id, ts, 'Запуск сообщён исполнителем; приёмка не выполнена.');
      }
    });
    return { ok: true, projectId: project.id, task: { id, ...fields }, idempotent: Boolean(same) };
  }

  // Независимый сигнал Codex: приёмку записывает локальный CLI явно, а не
  // статус исполнителя и не решение из браузера.
  taskAccept(payload, actor) {
    if (actor !== 'cli') {
      fail('Приёмку задачи выполняет локальный CLI (Codex), а не браузер.', 'cli_required');
    }
    const project = this.getProject(payload.projectId);
    const id = text(payload.id, 'идентификатор задачи', { max: 200 });
    const evidence = text(payload.evidence, 'доказательство приёмки', { max: 20000 });
    const task = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(project.id, id);
    if (!task) fail(`Задача ${id} не найдена в проекте.`, 'task.not_found', { id });
    const fingerprint = taskFingerprint(task);
    const existing = this.db.prepare('SELECT * FROM task_acceptances WHERE project_id = ? AND task_id = ?').get(project.id, id);
    if (existing && existing.fingerprint === fingerprint) {
      this.audit(project.id, 'task.accept', actor, { id, fingerprint, evidence }, true);
      return {
        ok: true, projectId: project.id, taskId: id, accepted: true,
        evidence: existing.evidence, acceptedAt: existing.ts, idempotent: true,
      };
    }
    const ts = this.now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO task_acceptances(project_id, task_id, fingerprint, evidence, ts, actor)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, task_id) DO UPDATE SET fingerprint = excluded.fingerprint,
          evidence = excluded.evidence, ts = excluded.ts, actor = excluded.actor`)
        .run(project.id, id, fingerprint, evidence, ts, actor);
      this.decision(project.id, 'task', id, 'accepted', actor);
      this.audit(project.id, 'task.accept', actor, {
        id, evidence, fingerprint, previous: existing ? existing.fingerprint : null,
      });
    });
    return {
      ok: true, projectId: project.id, taskId: id, accepted: true,
      evidence, acceptedAt: ts, idempotent: false,
    };
  }

  ideaAdd(payload, actor) {
    const project = this.getProject(payload.projectId);
    const value = text(payload.text, 'текст идеи', { max: 5000 });
    const norm = normalizeIdeaText(value);
    const proposal = optionalText(payload.proposal, 'предложение', 20000);
    const afterTaskId = optionalText(payload.afterTaskId, 'после задачи', 200);
    const existing = this.db.prepare('SELECT * FROM ideas WHERE project_id = ? AND norm_text = ?').get(project.id, norm);
    if (existing) {
      this.audit(project.id, 'idea.add', actor, { id: existing.id }, true);
      return { ok: true, projectId: project.id, ideaId: existing.id, idempotent: true, idea: { ...existing, norm_text: undefined } };
    }
    const id = newId('idea');
    const ts = this.now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO ideas(id, project_id, norm_text, text, proposal, after_task_id, decision, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)')
        .run(id, project.id, norm, value, proposal, afterTaskId, ts);
      this.audit(project.id, 'idea.add', actor, { id });
    });
    return { ok: true, projectId: project.id, ideaId: id, idempotent: false };
  }

  ideaDecide(payload, actor) {
    const project = this.getProject(payload.projectId);
    const decision = text(payload.decision, 'решение', { max: 40 });
    if (!IDEA_DECISIONS.includes(decision)) {
      fail(`Недопустимое решение «${decision}». Возможно: ${IDEA_DECISIONS.join(', ')}.`, 'idea.decision_invalid', { allowed: IDEA_DECISIONS });
    }
    const id = text(payload.id, 'идентификатор идеи', { max: 200 });
    const idea = this.db.prepare('SELECT * FROM ideas WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!idea) fail(`Идея ${id} не найдена в проекте.`, 'idea.not_found', { id });
    if (idea.decision === decision) {
      this.audit(project.id, 'idea.decide', actor, { id, decision }, true);
      return { ok: true, projectId: project.id, ideaId: id, decision, idempotent: true };
    }
    if (idea.decision && idea.decision !== 'deferred') {
      fail(`Идея уже имеет окончательное решение «${idea.decision}».`, 'idea.decision_final', { id, current: idea.decision });
    }
    this.transaction(() => {
      this.db.prepare('UPDATE ideas SET decision = ?, decided_at = ? WHERE id = ?').run(decision, this.now(), id);
      this.decision(project.id, 'idea', id, decision, actor);
      this.audit(project.id, 'idea.decide', actor, { id, decision, previous: idea.decision });
    });
    return { ok: true, projectId: project.id, ideaId: id, decision, idempotent: false };
  }

  labPropose(payload, actor) {
    const project = this.getProject(payload.projectId);
    const title = text(payload.title, 'название лаборатории', { max: 500 });
    const scenario = text(payload.scenario, 'сценарий', { max: 20000 });
    const criteria = strList(payload.criteria, 'критерии');
    if (!criteria.length) fail('Укажите хотя бы один критерий лаборатории.', 'field.required', { field: 'критерии' });
    const modulePaths = normalizeProjectPaths(payload.modulePaths, 'пути модулей');
    const demoPaths = normalizeProjectPaths(payload.demoPaths, 'пути демонстрации');
    assertDisjoint(modulePaths, demoPaths);
    const proof = optionalText(payload.proof, 'доказательство', 20000);
    const fields = { title, scenario, criteria, modulePaths, demoPaths, proof };
    const givenId = optionalText(payload.id, 'идентификатор лаборатории', 200);
    const existing = givenId
      ? this.db.prepare('SELECT * FROM labs WHERE id = ? AND project_id = ?').get(givenId, project.id)
      : null;
    if (existing && !['proposed', 'changes_requested', 'rejected'].includes(existing.state)) {
      fail(`Лабораторию в состоянии «${existing.state}» нельзя переопределить.`, 'lab.state', { id: existing.id, state: existing.state });
    }
    if (existing) {
      const same = existing.title === title && existing.scenario === scenario &&
        JSON.stringify(parseJson(existing.criteria, [])) === JSON.stringify(criteria) &&
        JSON.stringify(parseJson(existing.module_paths, [])) === JSON.stringify(modulePaths) &&
        JSON.stringify(parseJson(existing.demo_paths, [])) === JSON.stringify(demoPaths) &&
        (existing.proof ?? null) === proof;
      if (same) {
        this.audit(project.id, 'lab.propose', actor, { id: existing.id }, true);
        return { ok: true, projectId: project.id, labId: existing.id, idempotent: true };
      }
      const ts = this.now();
      this.transaction(() => {
        this.db.prepare(`UPDATE labs SET title = ?, scenario = ?, criteria = ?, module_paths = ?, demo_paths = ?, proof = ?,
          state = 'proposed', runtime = 'not_started', revision = revision + 1, config = NULL, last_run = NULL, ready_seen = 0, updated_at = ?
          WHERE id = ?`)
          .run(title, scenario, JSON.stringify(criteria), JSON.stringify(modulePaths), JSON.stringify(demoPaths), proof, ts, existing.id);
        this.audit(project.id, 'lab.propose', actor, { id: existing.id, revision: existing.revision + 1 });
      });
      return { ok: true, projectId: project.id, labId: existing.id, idempotent: false, revision: existing.revision + 1 };
    }
    const id = newId('lab');
    const ts = this.now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO labs(id, project_id, title, scenario, criteria, module_paths, demo_paths, proof, state, runtime, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'not_started', 1, ?, ?)`)
        .run(id, project.id, title, scenario, JSON.stringify(criteria), JSON.stringify(modulePaths), JSON.stringify(demoPaths), proof, ts, ts);
      this.audit(project.id, 'lab.propose', actor, { id, ...fields });
    });
    return { ok: true, projectId: project.id, labId: id, idempotent: false, lab: fields };
  }

  labDecide(payload, actor) {
    const project = this.getProject(payload.projectId);
    const decision = text(payload.decision, 'решение', { max: 40 });
    if (!LAB_DECISIONS.includes(decision)) {
      fail(`Недопустимое решение «${decision}». Возможно: ${LAB_DECISIONS.join(', ')}.`, 'lab.decision_invalid', { allowed: LAB_DECISIONS });
    }
    const id = text(payload.id, 'идентификатор лаборатории', { max: 200 });
    const lab = this.db.prepare('SELECT * FROM labs WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!lab) fail(`Лаборатория ${id} не найдена в проекте.`, 'lab.not_found', { id });
    if (lab.state === decision) {
      this.audit(project.id, 'lab.decide', actor, { id, decision }, true);
      return { ok: true, projectId: project.id, labId: id, decision, idempotent: true };
    }
    let next = null;
    if (decision === 'approved' && lab.state === 'proposed') next = 'approved';
    if (decision === 'rejected' && ['proposed', 'approved'].includes(lab.state)) next = 'rejected';
    const lastRun = parseJson(lab.last_run, null);
    const ready = Boolean(lab.ready_seen) && Boolean(lastRun && lastRun.status === 'ready');
    if (['accepted', 'changes_requested'].includes(decision)) {
      if (!ready) {
        const hint = lab.state === 'proposed'
          ? 'Сначала одобрите лабораторию.'
          : lab.state === 'approved'
            ? 'Настройте и запустите демонстрацию.'
            : 'Запустите демонстрацию и дождитесь подтверждения готовности.';
        fail(`Нельзя ${decision === 'accepted' ? 'принять' : 'запросить изменения'} лабораторию без готовой демонстрации. ${hint}`,
          'lab.not_ready', { id, state: lab.state, runtime: lab.runtime, next: hint });
      }
      if (['configured', 'ready'].includes(lab.state)) next = decision;
    }
    if (!next) {
      const hints = {
        proposed: 'одобрите или отклоните лабораторию',
        approved: 'настройте демонстрацию командой lab.configure',
        configured: 'запустите демонстрацию командой lab.start',
        ready: 'примите лабораторию или запросите изменения',
        accepted: 'лаборатория принята; создайте новую версию при необходимости',
        changes_requested: 'создайте новую версию через lab.propose с полем id',
        rejected: 'лаборатория отклонена; создайте новую версию через lab.propose',
      };
      fail(`Переход из состояния «${lab.state}» в «${decision}» запрещён. Следующий шаг: ${hints[lab.state] || 'проверьте состояние'}.`,
        'lab.transition', { id, state: lab.state, decision, next: hints[lab.state] || null });
    }
    this.transaction(() => {
      this.db.prepare('UPDATE labs SET state = ?, updated_at = ? WHERE id = ?').run(next, this.now(), id);
      this.decision(project.id, 'lab', id, decision, actor);
      this.audit(project.id, 'lab.decide', actor, { id, decision, from: lab.state, to: next });
    });
    return { ok: true, projectId: project.id, labId: id, decision, state: next, idempotent: false };
  }

  labConfigure(payload, actor) {
    const project = this.getProject(payload.projectId);
    const id = text(payload.id, 'идентификатор лаборатории', { max: 200 });
    const lab = this.db.prepare('SELECT * FROM labs WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!lab) fail(`Лаборатория ${id} не найдена в проекте.`, 'lab.not_found', { id });
    if (lab.state !== 'approved') {
      fail(`Лаборатория в состоянии «${lab.state}». Настройка доступна только после одобрения человеком. Сначала lab.decide c decision="approved".`,
        'lab.state', { id, state: lab.state, next: 'lab.decide approved' });
    }
    const cwd = text(payload.cwd, 'cwd', { max: 2000 });
    const runtime = text(payload.runtime, 'runtime', { max: 20 });
    if (!['node', 'python'].includes(runtime)) {
      fail(`Поддерживаются только runtime node и python, получено «${runtime}».`, 'lab.runtime_invalid', { allowed: ['node', 'python'] });
    }
    if (!Array.isArray(payload.args)) {
      fail('Аргументы демонстрации должны быть массивом строк (без оболочки).', 'field.type', { field: 'аргументы' });
    }
    const args = strList(payload.args, 'аргументы');
    if (!args.length) fail('Укажите аргументы запуска демонстрации.', 'field.required', { field: 'аргументы' });
    if (args.some((arg) => arg.includes('\u0000'))) fail('Аргументы не могут содержать нулевой символ.', 'field.invalid', { field: 'аргументы' });
    const evidence = text(payload.evidence, 'доказательство', { max: 20000 });
    const config = { cwd, runtime, args, evidence };
    const same = JSON.stringify(parseJson(lab.config, null)) === JSON.stringify(config);
    if (same) {
      this.audit(project.id, 'lab.configure', actor, { id }, true);
      return { ok: true, projectId: project.id, labId: id, idempotent: true, config };
    }
    this.transaction(() => {
      this.db.prepare(`UPDATE labs SET config = ?, state = 'configured', updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(config), this.now(), id);
      this.audit(project.id, 'lab.configure', actor, { id, runtime, cwd });
    });
    return { ok: true, projectId: project.id, labId: id, idempotent: false, config };
  }

  labStartPrepare(payload, actor) {
    const project = this.getProject(payload.projectId);
    const id = text(payload.id, 'идентификатор лаборатории', { max: 200 });
    const lab = this.db.prepare('SELECT * FROM labs WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!lab) fail(`Лаборатория ${id} не найдена в проекте.`, 'lab.not_found', { id });
    if (!['configured', 'ready'].includes(lab.state)) {
      fail(`Лаборатория в состоянии «${lab.state}». Запуск доступен после настройки демонстрации. Сначала lab.configure.`,
        'lab.state', { id, state: lab.state, next: 'lab.configure' });
    }
    const config = parseJson(lab.config, null);
    if (!config) fail('Конфигурация демонстрации отсутствует. Выполните lab.configure.', 'lab.not_configured', { id });
    this.audit(project.id, 'lab.start.request', actor, { id });
    return { labId: id, projectId: project.id, config };
  }

  labStartFinish(id, outcome) {
    const lab = this.db.prepare('SELECT * FROM labs WHERE id = ?').get(id);
    if (!lab) return;
    const lastRun = {
      port: outcome.port,
      data: outcome.data,
      startedAt: outcome.startedAt,
      readyAt: outcome.readyAt || null,
      endedAt: outcome.endedAt || null,
      status: outcome.ready ? 'ready' : 'failed',
      error: outcome.error || null,
      log: outcome.log || { stdout: '', stderr: '' },
      note: outcome.note || null,
    };
    const ts = this.now();
    this.transaction(() => {
      // Неудачный повторный запуск обесценивает прежнюю готовность: приёмка снова блокируется.
      this.db.prepare(`UPDATE labs SET runtime = ?, last_run = ?, ready_seen = ?,
        state = CASE WHEN ? = 'ready' AND state = 'configured' THEN 'ready'
                     WHEN ? != 'ready' AND state = 'ready' THEN 'configured' ELSE state END,
        updated_at = ? WHERE id = ?`)
        .run(outcome.ready ? 'ready' : 'failed', JSON.stringify(lastRun), outcome.ready ? 1 : 0, lastRun.status, lastRun.status, ts, id);
      this.audit(lab.project_id, outcome.ready ? 'lab.ready' : 'lab.start.failed', 'system', { id, port: outcome.port, error: outcome.error || null });
    });
  }

  labStopPrepare(payload, actor) {
    const project = this.getProject(payload.projectId);
    const id = text(payload.id, 'идентификатор лаборатории', { max: 200 });
    const lab = this.db.prepare('SELECT * FROM labs WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!lab) fail(`Лаборатория ${id} не найдена в проекте.`, 'lab.not_found', { id });
    this.audit(project.id, 'lab.stop.request', actor, { id });
    return { labId: id, projectId: project.id };
  }

  labStopFinish(id, outcome) {
    const lab = this.db.prepare('SELECT * FROM labs WHERE id = ?').get(id);
    if (!lab) return;
    const lastRun = parseJson(lab.last_run, null);
    if (lastRun && outcome.endedAt) lastRun.endedAt = outcome.endedAt;
    if (lastRun && outcome.log) lastRun.log = outcome.log;
    const previous = lab.runtime;
    const nextRuntime = outcome.stopped ? 'stopped' : (previous === 'unverified' || previous === 'failed' ? previous : 'stopped');
    this.transaction(() => {
      this.db.prepare('UPDATE labs SET runtime = ?, last_run = ?, updated_at = ? WHERE id = ?')
        .run(nextRuntime, lastRun ? JSON.stringify(lastRun) : null, this.now(), id);
      this.audit(lab.project_id, 'lab.stop', 'system', { id, stopped: Boolean(outcome.stopped), previous });
    });
  }

  designCreate(payload, actor) {
    const project = this.getProject(payload.projectId);
    const title = text(payload.title, 'название проекта проектирования', { max: 500 });
    const id = newId('design');
    const ts = this.now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO designs(id, project_id, title, step, step_index, history, created_at, updated_at) VALUES (?, ?, ?, NULL, -1, ?, ?, ?)')
        .run(id, project.id, title, '[]', ts, ts);
      this.audit(project.id, 'design.create', actor, { id, title });
    });
    return { ok: true, projectId: project.id, designId: id, idempotent: false };
  }

  normalizeFigmaSyncPayload(payload) {
    const fileKey = text(payload.fileKey, 'ключ файла Figma', { max: 500 });
    if (!/^[A-Za-z0-9_-]+$/.test(fileKey)) {
      fail('Ключ файла Figma недопустим для канонической ссылки.', 'design.figma_filekey_invalid', { field: 'fileKey' });
    }
    if (!Array.isArray(payload.frames)) {
      fail('Поле «frames» должно быть массивом объектов {nodeId, name}.', 'field.type', { field: 'frames' });
    }
    if (!payload.frames.length) {
      fail('Укажите хотя бы один фрейм в поле «frames».', 'field.required', { field: 'frames' });
    }
    const seen = new Set();
    const frames = payload.frames.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail(`Элемент frames[${index}] должен быть объектом {nodeId, name}.`, 'field.type', { field: 'frames' });
      }
      if (typeof item.nodeId !== 'string' || typeof item.name !== 'string') {
        fail(`Элемент frames[${index}] должен содержать строки nodeId и name.`, 'field.type', { field: 'frames' });
      }
      const rawNodeId = item.nodeId.trim();
      const name = item.name.trim();
      if (!rawNodeId || !name) {
        fail(`Элемент frames[${index}] должен содержать непустые nodeId и name.`, 'field.required', { field: 'frames' });
      }
      if (!/^\d+[:-]\d+$/.test(rawNodeId)) {
        fail(`Идентификатор фрейма «${rawNodeId}» недопустим: ожидается числовая пара (например 12:34 или 12-34).`, 'design.figma_nodeid_invalid', { field: 'frames', nodeId: rawNodeId });
      }
      const nodeId = rawNodeId.replace(/-/g, ':');
      if (seen.has(nodeId)) {
        fail(`Повторяющийся идентификатор фрейма «${nodeId}».`, 'design.figma_duplicate_frame', { nodeId });
      }
      seen.add(nodeId);
      const fileUrl = `https://www.figma.com/design/${fileKey}`;
      return {
        nodeId,
        name,
        url: `${fileUrl}?node-id=${encodeURIComponent(nodeId)}`,
      };
    });
    const note = optionalText(payload.note, 'примечание', 20000);
    return {
      fileKey,
      fileUrl: `https://www.figma.com/design/${fileKey}`,
      frames,
      note,
    };
  }

  designFigmaSync(payload, actor) {
    if (actor !== 'cli') {
      fail('Синхронизацию Figma выполняет локальный CLI (Codex), а не браузер.', 'cli_required', { action: 'design.figma.sync' });
    }
    const project = this.getProject(payload.projectId);
    const id = text(payload.id, 'идентификатор проекта проектирования', { max: 200 });
    const design = this.db.prepare('SELECT * FROM designs WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!design) fail(`Проект проектирования ${id} не найден.`, 'design.not_found', { id });
    const refsIndex = DESIGN_STEPS.indexOf('references_approved');
    const figmaReadyIndex = DESIGN_STEPS.indexOf('figma_ready');
    const figmaApprovedIndex = DESIGN_STEPS.indexOf('figma_approved');
    if (design.step_index < refsIndex) {
      fail('Синхронизация Figma доступна только после принятия источников (references_approved).',
        'design.figma_sync_requires_references', { id, current: design.step });
    }
    if (design.step_index >= figmaApprovedIndex) {
      fail('Нельзя изменять дизайн после подтверждения Figma (figma_approved).',
        'design.figma_sync_blocked', { id, current: design.step });
    }
    const sync = this.normalizeFigmaSyncPayload(payload);
    const history = parseJson(design.history, []);
    const entry = {
      step: 'figma_ready',
      artifact: sync.fileUrl,
      fileKey: sync.fileKey,
      fileUrl: sync.fileUrl,
      frames: sync.frames,
      verified: true,
      note: sync.note,
      ts: this.now(),
      source: 'figma-mcp',
    };
    const comparable = (item) => ({
      step: item.step,
      artifact: item.artifact ?? null,
      fileKey: item.fileKey ?? null,
      fileUrl: item.fileUrl ?? null,
      frames: item.frames ?? [],
      verified: Boolean(item.verified),
      note: item.note ?? null,
      source: item.source ?? null,
    });
    if (design.step_index === figmaReadyIndex) {
      const lastEntry = history.length ? history[history.length - 1] : null;
      if (lastEntry && lastEntry.step === 'figma_ready' &&
          JSON.stringify(comparable(lastEntry)) === JSON.stringify(comparable(entry))) {
        this.audit(project.id, 'design.figma.sync', actor, { id, fileKey: sync.fileKey }, true);
        return { ok: true, projectId: project.id, designId: id, step: 'figma_ready', idempotent: true };
      }
      this.transaction(() => {
        const nextHistory = history.slice();
        if (nextHistory.length && nextHistory[nextHistory.length - 1].step === 'figma_ready') {
          nextHistory[nextHistory.length - 1] = entry;
        } else {
          nextHistory.push(entry);
        }
        this.db.prepare('UPDATE designs SET step = ?, step_index = ?, history = ?, updated_at = ? WHERE id = ?')
          .run('figma_ready', figmaReadyIndex, JSON.stringify(nextHistory), this.now(), id);
        this.audit(project.id, 'design.figma.sync', actor, { id, fileKey: sync.fileKey, frames: sync.frames.length, updated: true });
      });
      return { ok: true, projectId: project.id, designId: id, step: 'figma_ready', idempotent: false, updated: true };
    }
    this.transaction(() => {
      this.db.prepare('UPDATE designs SET step = ?, step_index = ?, history = ?, updated_at = ? WHERE id = ?')
        .run('figma_ready', figmaReadyIndex, JSON.stringify([...history, entry]), this.now(), id);
      this.audit(project.id, 'design.figma.sync', actor, { id, fileKey: sync.fileKey, frames: sync.frames.length });
    });
    return { ok: true, projectId: project.id, designId: id, step: 'figma_ready', idempotent: false };
  }

  designAdvance(payload, actor, ctx) {
    const project = this.getProject(payload.projectId);
    const step = text(payload.step, 'шаг проектирования', { max: 60 });
    if (!DESIGN_STEPS.includes(step)) {
      fail(`Неизвестный шаг «${step}». Порядок шагов: ${DESIGN_STEPS.join(' → ')}.`, 'design.step_invalid', { steps: DESIGN_STEPS });
    }
    const id = text(payload.id, 'идентификатор проекта проектирования', { max: 200 });
    const design = this.db.prepare('SELECT * FROM designs WHERE id = ? AND project_id = ?').get(id, project.id);
    if (!design) fail(`Проект проектирования ${id} не найден.`, 'design.not_found', { id });
    const index = DESIGN_STEPS.indexOf(step);
    if (step === 'figma_ready') {
      fail('Шаг figma_ready выполняется только через синхронизацию Figma из Codex (design.figma.sync).',
        'design.figma_sync_required', { id, step });
    }
    if (HUMAN_DESIGN_STEPS.has(step) && actor !== 'browser') {
      fail(`Шаг «${step}» требует решения человека в браузере. Откройте панель и подтвердите шаг из интерфейса.`,
        'browser_required', { id, step });
    }
    const history = parseJson(design.history, []);
    const artifact = optionalText(payload.artifact, 'артефакт', 20000);
    const note = optionalText(payload.note, 'примечание', 20000);
    const frames = [];
    const lastEntry = history.length ? history[history.length - 1] : null;
    const same = lastEntry && lastEntry.step === step &&
      (lastEntry.artifact ?? null) === artifact && (lastEntry.note ?? null) === note &&
      JSON.stringify(lastEntry.frames ?? []) === JSON.stringify(frames);
    if (same) {
      this.audit(project.id, 'design.advance', actor, { id, step }, true);
      return { ok: true, projectId: project.id, designId: id, step, idempotent: true };
    }
    if (index !== design.step_index + 1) {
      const expected = design.step_index + 1 < DESIGN_STEPS.length ? DESIGN_STEPS[design.step_index + 1] : null;
      fail(expected
        ? `Шаги проектирования последовательны. Сейчас ожидается «${expected}», получен «${step}».`
        : 'Все шаги проектирования уже пройдены.',
      'design.sequence', { id, current: design.step, expected, requested: step });
    }
    if (step === 'figma_approved') {
      const proof = history.length ? history[history.length - 1] : null;
      const hasMcpSync = proof && proof.step === 'figma_ready' && proof.source === 'figma-mcp' &&
        proof.verified === true && typeof proof.fileKey === 'string' && proof.fileKey &&
        Array.isArray(proof.frames) && proof.frames.length > 0;
      if (!hasMcpSync) {
        fail('Подтверждение Figma доступно только после сохранённой синхронизации из Codex (design.figma.sync).',
          'design.figma_sync_required', { id, step });
      }
    }
    this.validateDesignArtifact(step, artifact, note, frames);
    const entry = { step, artifact, note, ts: this.now(), source: actor };
    this.transaction(() => {
      this.db.prepare('UPDATE designs SET step = ?, step_index = ?, history = ?, updated_at = ? WHERE id = ?')
        .run(step, index, JSON.stringify([...history, entry]), this.now(), id);
      if (HUMAN_DESIGN_STEPS.has(step)) this.decision(project.id, 'design', id, 'approved', actor);
      this.audit(project.id, 'design.advance', actor, { id, step, artifact: Boolean(artifact), note: Boolean(note) });
    });
    return { ok: true, projectId: project.id, designId: id, step, idempotent: false };
  }

  validateDesignArtifact(step, artifact, note, frames = []) {
    const requireArtifact = (hint) => {
      if (!artifact) fail(hint, 'design.artifact_required', { step });
    };
    if (step === 'references_ready') {
      requireArtifact('Укажите ссылки на источники в поле artifact.');
      if (!looksLikeLink(artifact)) fail('В artifact должны быть ссылки на источники (http(s):// или путь к файлу).', 'design.references_invalid', { step });
    }
    if (step === 'implemented') requireArtifact('Шаг implemented требует артефакта реализации в поле artifact.');
    if (step === 'reviewed') requireArtifact('Шаг reviewed требует доказательства проверки в поле artifact.');
    if (step === 'references_approved' || step === 'figma_approved') {
      // human step: достаточно явного решения в браузере, note необязателен
      void note;
    }
  }
}

module.exports = {
  Store,
  ActionError,
  PHASES,
  DESIGN_STEPS,
  HUMAN_DESIGN_STEPS,
  IDEA_DECISIONS,
  LAB_DECISIONS,
  LAB_STATES,
  LAB_RUNTIME,
  fail,
  makeLogger,
  realDirectory,
  samePath,
  isInside,
  normalizeProjectPaths,
  assertDisjoint,
  normalizeIdeaText,
  idHash,
};
